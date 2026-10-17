import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { STORAGE_PLANS, APP_CONFIG } from '../config/plans.mjs';

const DATA_DIR = path.resolve(APP_CONFIG.storageRoot, 'db');
const DB_FILE = path.join(DATA_DIR, 'cardng_state.json');
const DB_BAK_FILE = path.join(DATA_DIR, 'cardng_state.json.bak');

fs.mkdirSync(DATA_DIR, { recursive: true });

const defaultState = {
  users: {},          // id -> User
  blobs: {},          // sha256 -> { sha256, sizeBytes, mimeType, refCount, tier, accessCount, lastAccessedAt, createdAt }
  files: {},          // fileId -> FileRecord
  payments: {},       // paymentId -> PaymentRecord
  shares: {},         // shareCode -> ShareRecord
  uploadSessions: {}, // uploadId -> ResumableUploadSession
  auditLogs: {},      // userId -> Array<AuditEvent>
  stats: {
    totalPhysicalBytes: 0,
    totalVirtualBytes: 0,
    totalDeduplicatedBytesSaved: 0,
    totalInstantUploadsCount: 0
  }
};

let state = structuredClone(defaultState);

function loadDatabase() {
  const candidates = [DB_FILE, DB_BAK_FILE];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        const raw = fs.readFileSync(candidate, 'utf-8');
        const parsed = JSON.parse(raw);
        state = {
          ...structuredClone(defaultState),
          ...parsed,
          stats: { ...defaultState.stats, ...(parsed.stats || {}) }
        };
        return;
      }
    } catch (err) {
      console.error(`[DB] Failed to load ${path.basename(candidate)}, trying fallback:`, err.message);
    }
  }
}

// Non-blocking async persistence queue with rotating .bak snapshot
let savePending = false;
let isWriting = false;

async function flushDatabaseAsync() {
  if (isWriting || !savePending) return;
  isWriting = true;
  savePending = false;

  try {
    const tmpFile = `${DB_FILE}.tmp`;
    const payload = JSON.stringify(state, null, 2);
    await fs.promises.writeFile(tmpFile, payload, 'utf-8');
    if (fs.existsSync(DB_FILE)) {
      await fs.promises.copyFile(DB_FILE, DB_BAK_FILE).catch(() => {});
    }
    await fs.promises.rename(tmpFile, DB_FILE);
  } catch (err) {
    console.error('[DB] Async atomic write error:', err.message);
  } finally {
    isWriting = false;
    if (savePending) {
      setImmediate(flushDatabaseAsync);
    }
  }
}

function persistDatabase() {
  savePending = true;
  setImmediate(flushDatabaseAsync);
}

loadDatabase();

export function hashPin(pin, salt = APP_CONFIG.appSecret) {
  return crypto.scryptSync(String(pin), salt, 32).toString('hex');
}

function generateCardSerial() {
  const part1 = crypto.randomBytes(2).toString('hex').toUpperCase();
  const part2 = crypto.randomBytes(2).toString('hex').toUpperCase();
  return `NG-SD-${part1}-${part2}`;
}

export const db = {
  getStats() {
    const usersCount = Object.keys(state.users).length;
    const filesCount = Object.keys(state.files).length;
    const blobsCount = Object.keys(state.blobs).length;
    return {
      ...state.stats,
      usersCount,
      filesCount,
      blobsCount
    };
  },

  createAnonymousUser() {
    const id = `usr_${crypto.randomBytes(8).toString('hex')}`;
    const sessionToken = crypto.randomBytes(24).toString('hex');
    const plan = STORAGE_PLANS.free;
    const user = {
      id,
      cardSerial: generateCardSerial(),
      sessionToken,
      phone: null,
      displayName: 'Guest Cardholder',
      pinHash: null,
      recoveryKeyHash: null,
      isLockedToPhone: false,
      planId: plan.id,
      planName: plan.name,
      quotaBytes: plan.quotaBytes,
      planActivatedAt: null,
      planExpiresAt: null,
      usedBytes: 0,
      savedDataBytes: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    state.users[id] = user;
    persistDatabase();
    return user;
  },

  getUserById(userId) {
    return state.users[userId] || null;
  },

  getUserByToken(token) {
    if (!token) return null;
    return Object.values(state.users).find((u) => u.sessionToken === token) || null;
  },

  getUserByPhone(phone) {
    const normalized = db.normalizePhone(phone);
    if (!normalized) return null;
    return Object.values(state.users).find((u) => u.phone === normalized) || null;
  },

  normalizePhone(phone) {
    if (!phone) return '';
    let cleaned = String(phone).replace(/\D/g, '');
    if (cleaned.startsWith('234') && cleaned.length === 13) {
      cleaned = '0' + cleaned.slice(3);
    }
    return cleaned;
  },

  // 30-Day Sachet Subscription Lifecycle & Trust-Preserving Read-Only Grace Mode
  getQuotaStatus(userId) {
    const user = state.users[userId];
    if (!user) {
      return {
        isPlanExpired: false,
        isReadOnlyGraceMode: false,
        daysRemaining: null,
        effectiveQuotaBytes: 0,
        planExpiresAt: null
      };
    }

    if (!user.planExpiresAt || user.planId === 'free') {
      return {
        isPlanExpired: false,
        isReadOnlyGraceMode: false,
        daysRemaining: null,
        effectiveQuotaBytes: user.quotaBytes,
        planExpiresAt: null
      };
    }

    const expiresMs = new Date(user.planExpiresAt).getTime();
    const diffMs = expiresMs - Date.now();
    const isPlanExpired = diffMs <= 0;
    const daysRemaining = isPlanExpired ? 0 : Math.ceil(diffMs / (24 * 60 * 60 * 1000));
    const freeQuota = STORAGE_PLANS.free.quotaBytes;
    const effectiveQuotaBytes = isPlanExpired ? freeQuota : user.quotaBytes;
    const isReadOnlyGraceMode = isPlanExpired && user.usedBytes >= freeQuota;

    return {
      isPlanExpired,
      isReadOnlyGraceMode,
      daysRemaining,
      effectiveQuotaBytes,
      planExpiresAt: user.planExpiresAt
    };
  },

  assertCanUpload(userId, incomingBytes = 0) {
    const user = state.users[userId];
    if (!user) throw new Error('User not found');
    const qs = db.getQuotaStatus(userId);
    const numBytes = Number(incomingBytes || 0);

    if (qs.isPlanExpired) {
      if (user.usedBytes + numBytes > STORAGE_PLANS.free.quotaBytes) {
        throw new Error(
          'QUOTA_EXCEEDED: Your 30-day Sachet Plan has expired (Read-Only Grace Mode). All your existing files are 100% safe and streamable — top up ₦250 or ₦500 to upload new files!'
        );
      }
    }

    if (user.usedBytes + numBytes > qs.effectiveQuotaBytes) {
      throw new Error(
        'QUOTA_EXCEEDED: Your Digital Memory Card is full. Upgrade for ₦250 or ₦500 to add space!'
      );
    }
    return true;
  },

  lockUserToPhone(userId, { phone, pin, displayName }) {
    const user = state.users[userId];
    if (!user) throw new Error('User not found');

    const normalizedPhone = db.normalizePhone(phone);
    if (normalizedPhone.length < 10 || normalizedPhone.length > 11) {
      throw new Error('Please enter a valid Nigerian phone number (e.g. 08031234567)');
    }
    if (!/^\d{4}$/.test(String(pin))) {
      throw new Error('PIN must be exactly 4 digits');
    }

    const existingOwner = db.getUserByPhone(normalizedPhone);
    if (existingOwner && existingOwner.id !== userId) {
      throw new Error(
        'This phone number is already linked to another Memory Card. Use "Switch / Restore Card" to log in.'
      );
    }

    const recA = crypto.randomBytes(2).toString('hex').toUpperCase();
    const recB = crypto.randomBytes(2).toString('hex').toUpperCase();
    const recoveryKey = `NG-REC-${recA}-${recB}`;

    user.phone = normalizedPhone;
    user.pinHash = hashPin(pin, normalizedPhone);
    user.recoveryKeyHash = hashPin(recoveryKey, normalizedPhone);
    user.displayName = displayName?.trim() || `Card ${normalizedPhone.slice(-4)}`;
    user.isLockedToPhone = true;
    user.updatedAt = new Date().toISOString();
    persistDatabase();
    return { user, recoveryKey };
  },

  resetPinWithRecoveryKey(phone, recoveryKey, newPin) {
    const normalizedPhone = db.normalizePhone(phone);
    const user = db.getUserByPhone(normalizedPhone);
    if (!user || !user.recoveryKeyHash) {
      return null;
    }
    if (!/^\d{4}$/.test(String(newPin))) {
      throw new Error('New PIN must be exactly 4 digits');
    }

    const cleanKey = String(recoveryKey || '').trim().toUpperCase();
    const candidateHash = hashPin(cleanKey, normalizedPhone);
    const valid = crypto.timingSafeEqual(
      Buffer.from(user.recoveryKeyHash, 'hex'),
      Buffer.from(candidateHash, 'hex')
    );
    if (!valid) return null;

    const recA = crypto.randomBytes(2).toString('hex').toUpperCase();
    const recB = crypto.randomBytes(2).toString('hex').toUpperCase();
    const nextRecoveryKey = `NG-REC-${recA}-${recB}`;

    user.pinHash = hashPin(newPin, normalizedPhone);
    user.recoveryKeyHash = hashPin(nextRecoveryKey, normalizedPhone);
    user.updatedAt = new Date().toISOString();
    persistDatabase();
    return { user, recoveryKey: nextRecoveryKey };
  },

  authenticatePhoneAndPin(phone, pin) {
    const normalizedPhone = db.normalizePhone(phone);
    const user = db.getUserByPhone(normalizedPhone);
    if (!user || !user.pinHash) {
      return null;
    }
    const candidateHash = hashPin(pin, normalizedPhone);
    const valid = crypto.timingSafeEqual(
      Buffer.from(user.pinHash, 'hex'),
      Buffer.from(candidateHash, 'hex')
    );
    if (!valid) return null;
    return user;
  },

  verifyUserPin(userId, pin) {
    const user = state.users[userId];
    if (!user) return false;
    if (!user.pinHash) {
      // Default demo PIN if user hasn't set one yet is 0000
      return String(pin) === '0000';
    }
    const candidateHash = hashPin(pin, user.phone || APP_CONFIG.appSecret);
    return crypto.timingSafeEqual(
      Buffer.from(user.pinHash, 'hex'),
      Buffer.from(candidateHash, 'hex')
    );
  },

  getBlob(sha256) {
    return state.blobs[sha256] || null;
  },

  // Prevents "Confirmation-of-a-File" attacks on Private Vault blobs
  canDeduplicateBlob(sha256, requestingUserId) {
    const cleanHash = String(sha256 || '').toLowerCase();
    const blob = state.blobs[cleanHash];
    if (!blob) return false;

    const matchingFiles = Object.values(state.files).filter((f) => f.sha256 === cleanHash);
    if (matchingFiles.length === 0) return true;

    // Allow deduplication if the requesting user already owns a copy OR at least one copy is non-vault
    return matchingFiles.some((f) => f.userId === requestingUserId || !f.isVaultLocked);
  },

  touchBlobAccess(sha256) {
    const blob = state.blobs[String(sha256 || '').toLowerCase()];
    if (!blob) return;
    blob.accessCount = (blob.accessCount || 0) + 1;
    blob.lastAccessedAt = new Date().toISOString();
    blob.tier = 'HOT_LOCAL_NVME';
    persistDatabase();
  },

  registerOrIncrementBlob({ sha256, sizeBytes, mimeType }) {
    const existing = state.blobs[sha256];
    if (existing) {
      existing.refCount += 1;
      existing.accessCount = (existing.accessCount || 1) + 1;
      existing.lastAccessedAt = new Date().toISOString();
      state.stats.totalVirtualBytes += sizeBytes;
      state.stats.totalDeduplicatedBytesSaved += sizeBytes;
      state.stats.totalInstantUploadsCount += 1;
      persistDatabase();
      return { blob: existing, deduplicated: true };
    }

    const now = new Date().toISOString();
    const blob = {
      sha256,
      sizeBytes,
      mimeType: mimeType || 'application/octet-stream',
      refCount: 1,
      tier: 'HOT_LOCAL_NVME',
      accessCount: 1,
      lastAccessedAt: now,
      createdAt: now
    };
    state.blobs[sha256] = blob;
    state.stats.totalPhysicalBytes += sizeBytes;
    state.stats.totalVirtualBytes += sizeBytes;
    persistDatabase();
    return { blob, deduplicated: false };
  },

  // Resumable Chunked Uploads for Unstable 3G/4G Networks
  createUploadSession({
    userId,
    name,
    folder = 'All Files',
    mimeType = 'application/octet-stream',
    totalSizeBytes,
    expectedSha256 = null,
    isVaultLocked = false
  }) {
    db.assertCanUpload(userId, totalSizeBytes);
    if (!state.uploadSessions) state.uploadSessions = {};

    const uploadId = `upl_${crypto.randomBytes(8).toString('hex')}`;
    const session = {
      uploadId,
      userId,
      name: path.basename(name || 'Chunked_Upload.bin'),
      folder,
      mimeType,
      totalSizeBytes: Number(totalSizeBytes || 0),
      offsetBytes: 0,
      expectedSha256: expectedSha256 ? String(expectedSha256).toLowerCase() : null,
      isVaultLocked: Boolean(isVaultLocked),
      status: 'IN_PROGRESS',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    state.uploadSessions[uploadId] = session;
    persistDatabase();
    return session;
  },

  getUploadSession(uploadId, userId) {
    if (!state.uploadSessions) return null;
    const s = state.uploadSessions[uploadId];
    if (!s || (userId && s.userId !== userId)) return null;
    return s;
  },

  updateUploadSessionOffset(uploadId, newOffsetBytes) {
    if (!state.uploadSessions || !state.uploadSessions[uploadId]) return null;
    const s = state.uploadSessions[uploadId];
    s.offsetBytes = Number(newOffsetBytes);
    s.updatedAt = new Date().toISOString();
    persistDatabase();
    return s;
  },

  completeUploadSession(uploadId) {
    if (!state.uploadSessions || !state.uploadSessions[uploadId]) return null;
    const s = state.uploadSessions[uploadId];
    delete state.uploadSessions[uploadId];
    persistDatabase();
    return s;
  },

  createFileRecord({
    userId,
    name,
    folder = 'All Files',
    sha256,
    sizeBytes,
    mimeType,
    isVaultLocked = false,
    deduplicated = false,
    extraSavedDataBytes = 0
  }) {
    const user = state.users[userId];
    if (!user) throw new Error('User not found');

    const id = `fil_${crypto.randomBytes(8).toString('hex')}`;
    const savedByThisOp = deduplicated
      ? Number(sizeBytes)
      : Math.max(0, Number(extraSavedDataBytes || 0));
    const record = {
      id,
      userId,
      name: path.basename(name || 'Untitled_File'),
      folder,
      sha256,
      sizeBytes: Number(sizeBytes),
      mimeType: mimeType || 'application/octet-stream',
      isVaultLocked: Boolean(isVaultLocked),
      isTrashed: false,
      trashedAt: null,
      deduplicated: Boolean(deduplicated),
      dataSavedBytes: savedByThisOp,
      safeToDeleteVerified: true,
      createdAt: new Date().toISOString()
    };

    state.files[id] = record;
    user.usedBytes += Number(sizeBytes);
    if (savedByThisOp > 0) {
      user.savedDataBytes = (user.savedDataBytes || 0) + savedByThisOp;
    }
    user.updatedAt = new Date().toISOString();
    persistDatabase();
    return record;
  },

  getUserFiles(userId) {
    return Object.values(state.files)
      .filter((f) => f.userId === userId)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  },

  getFileById(fileId) {
    return state.files[fileId] || null;
  },

  toggleFileVault(fileId, userId, isVaultLocked) {
    const file = state.files[fileId];
    if (!file || file.userId !== userId) return null;
    file.isVaultLocked = Boolean(isVaultLocked);
    if (file.isVaultLocked && file.folder !== 'Private Vault') {
      file.folder = 'Private Vault';
    } else if (!file.isVaultLocked && file.folder === 'Private Vault') {
      file.folder = 'All Files';
    }
    persistDatabase();
    return file;
  },

  renameOrMoveFile(fileId, userId, { name, folder }) {
    const file = state.files[fileId];
    if (!file || file.userId !== userId) return null;

    if (typeof name === 'string' && name.trim()) {
      const sanitized = path.basename(name.trim()).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
      if (sanitized) file.name = sanitized;
    }
    if (typeof folder === 'string' && folder.trim()) {
      file.folder = folder.trim();
      if (file.folder === 'Private Vault') {
        file.isVaultLocked = true;
      }
    }
    file.updatedAt = new Date().toISOString();
    persistDatabase();
    return file;
  },

  softTrashFile(fileId, userId) {
    const file = state.files[fileId];
    if (!file || file.userId !== userId) return null;
    file.isTrashed = true;
    file.trashedAt = new Date().toISOString();
    persistDatabase();
    return file;
  },

  restoreTrashedFile(fileId, userId) {
    const file = state.files[fileId];
    if (!file || file.userId !== userId) return null;
    file.isTrashed = false;
    file.trashedAt = null;
    persistDatabase();
    return file;
  },

  emptyUserTrash(userId) {
    const trashedFiles = Object.values(state.files).filter(
      (f) => f.userId === userId && f.isTrashed
    );
    const physicalBlobsToDelete = [];
    for (const f of trashedFiles) {
      const res = db.deleteFileRecord(f.id, userId);
      if (res && res.shouldDeletePhysicalBlob) {
        physicalBlobsToDelete.push(res.deletedFile.sha256);
      }
    }
    return {
      deletedCount: trashedFiles.length,
      physicalBlobsToDelete
    };
  },

  getStorageBreakdown(userId) {
    const files = db.getUserFiles(userId);
    const breakdown = {
      mediaBytes: 0,
      photoBytes: 0,
      devBytes: 0,
      docBytes: 0,
      vaultBytes: 0,
      trashBytes: 0,
      otherBytes: 0
    };

    for (const f of files) {
      const sz = Number(f.sizeBytes || 0);
      if (f.isTrashed) {
        breakdown.trashBytes += sz;
      } else if (f.isVaultLocked || f.folder === 'Private Vault') {
        breakdown.vaultBytes += sz;
      } else if (
        f.folder === 'Movies & Media' ||
        f.mimeType?.startsWith('video/') ||
        f.mimeType?.startsWith('audio/')
      ) {
        breakdown.mediaBytes += sz;
      } else if (f.folder === 'Photos' || f.mimeType?.startsWith('image/')) {
        breakdown.photoBytes += sz;
      } else if (
        f.folder === 'Dev & Code' ||
        /\.(js|mjs|ts|py|md|json|sh|html|css|sql|yaml|yml|zip|tar|gz)$/i.test(f.name)
      ) {
        breakdown.devBytes += sz;
      } else if (
        f.folder === 'Documents' ||
        f.mimeType?.includes('pdf') ||
        f.mimeType?.startsWith('text/')
      ) {
        breakdown.docBytes += sz;
      } else {
        breakdown.otherBytes += sz;
      }
    }
    return breakdown;
  },

  appendAuditLog(userId, { action, detail, severity = 'INFO', ip = '' }) {
    if (!userId) return null;
    if (!state.auditLogs) state.auditLogs = {};
    if (!Array.isArray(state.auditLogs[userId])) {
      state.auditLogs[userId] = [];
    }
    const entry = {
      id: `aud_${crypto.randomBytes(5).toString('hex')}`,
      action,
      detail,
      severity,
      ip: ip ? String(ip).replace(/(\.\d+)$/, '.xxx') : 'local',
      createdAt: new Date().toISOString()
    };
    state.auditLogs[userId].unshift(entry);
    if (state.auditLogs[userId].length > 80) {
      state.auditLogs[userId].slice(0, 80);
    }
    persistDatabase();
    return entry;
  },

  getUserAuditLogs(userId) {
    if (!state.auditLogs || !Array.isArray(state.auditLogs[userId])) {
      return [];
    }
    return state.auditLogs[userId];
  },

  deleteFileRecord(fileId, userId) {
    const file = state.files[fileId];
    if (!file || file.userId !== userId) return null;

    const user = state.users[userId];
    if (user) {
      user.usedBytes = Math.max(0, user.usedBytes - file.sizeBytes);
      user.updatedAt = new Date().toISOString();
    }

    delete state.files[fileId];
    state.stats.totalVirtualBytes = Math.max(0, state.stats.totalVirtualBytes - file.sizeBytes);

    let shouldDeletePhysicalBlob = false;
    const blob = state.blobs[file.sha256];
    if (blob) {
      blob.refCount = Math.max(0, blob.refCount - 1);
      if (blob.refCount === 0) {
        delete state.blobs[file.sha256];
        state.stats.totalPhysicalBytes = Math.max(
          0,
          state.stats.totalPhysicalBytes - file.sizeBytes
        );
        shouldDeletePhysicalBlob = true;
      }
    }

    persistDatabase();
    return { deletedFile: file, shouldDeletePhysicalBlob };
  },

  createPaymentClaim({
    userId,
    planId,
    channel = 'OPay',
    senderName = '',
    sessionIdLast6 = ''
  }) {
    const user = state.users[userId];
    if (!user) throw new Error('User not found');
    const plan = STORAGE_PLANS[planId];
    if (!plan || plan.priceNaira <= 0) throw new Error('Invalid upgrade plan selected');

    const id = `pay_${crypto.randomBytes(6).toString('hex')}`;
    const refNumber = Math.floor(1000 + Math.random() * 9000);
    const reference = `MC-${refNumber}`;
    const cleanedSession6 = String(sessionIdLast6 || '')
      .replace(/[^a-zA-Z0-9]/g, '')
      .slice(-8)
      .toUpperCase();

    const payment = {
      id,
      reference,
      userId,
      cardSerial: user.cardSerial,
      userPhone: user.phone || 'Unlinked Guest',
      planId: plan.id,
      planName: plan.name,
      quotaLabel: plan.quotaLabel,
      amountNaira: plan.priceNaira,
      channel,
      senderName: senderName.trim() || user.displayName,
      sessionIdLast6: cleanedSession6 || null,
      status: 'PENDING',
      receiptNumber: null,
      createdAt: new Date().toISOString(),
      resolvedAt: null
    };

    state.payments[id] = payment;
    persistDatabase();
    return payment;
  },

  resolvePayment(paymentId, action = 'APPROVE') {
    const payment = state.payments[paymentId];
    if (!payment) throw new Error('Payment claim not found');
    if (payment.status !== 'PENDING') return payment;

    const user = state.users[payment.userId];
    const plan = STORAGE_PLANS[payment.planId];

    if (action === 'APPROVE' && user && plan) {
      const now = new Date();
      const durationDays = Number(plan.durationDays || 30);
      const expiresAt = new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000);

      payment.status = 'APPROVED';
      payment.resolvedAt = now.toISOString();
      payment.receiptNumber = `NG-RCPT-${Date.now().toString().slice(-6)}`;
      payment.planExpiresAt = expiresAt.toISOString();

      user.planId = plan.id;
      user.planName = plan.name;
      user.quotaBytes = plan.quotaBytes;
      user.planActivatedAt = now.toISOString();
      user.planExpiresAt = expiresAt.toISOString();
      user.updatedAt = now.toISOString();
    } else {
      payment.status = 'REJECTED';
      payment.resolvedAt = new Date().toISOString();
    }

    persistDatabase();
    return payment;
  },

  getUserPayments(userId) {
    return Object.values(state.payments)
      .filter((p) => p.userId === userId)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  },

  getPendingPayments() {
    return Object.values(state.payments)
      .filter((p) => p.status === 'PENDING')
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  },

  getPaymentById(paymentId) {
    return state.payments[paymentId] || null;
  },

  updateFileBlob(fileId, userId, { newSha256, newSizeBytes, mimeType }) {
    const file = state.files[fileId];
    if (!file || file.userId !== userId) return null;
    const user = state.users[userId];
    if (!user) return null;

    const oldSha = file.sha256;
    const oldSize = file.sizeBytes;
    const sizeDelta = Number(newSizeBytes) - oldSize;

    if (sizeDelta > 0) {
      db.assertCanUpload(userId, sizeDelta);
    }

    let shouldDeleteOldBlob = false;
    if (oldSha !== newSha256) {
      const oldBlob = state.blobs[oldSha];
      if (oldBlob) {
        oldBlob.refCount = Math.max(0, oldBlob.refCount - 1);
        if (oldBlob.refCount === 0) {
          delete state.blobs[oldSha];
          state.stats.totalPhysicalBytes = Math.max(0, state.stats.totalPhysicalBytes - oldSize);
          shouldDeleteOldBlob = true;
        }
      }
      db.registerOrIncrementBlob({
        sha256: newSha256,
        sizeBytes: Number(newSizeBytes),
        mimeType: mimeType || file.mimeType
      });
    }

    file.sha256 = newSha256;
    file.sizeBytes = Number(newSizeBytes);
    file.updatedAt = new Date().toISOString();
    user.usedBytes = Math.max(0, user.usedBytes + sizeDelta);
    user.updatedAt = new Date().toISOString();

    persistDatabase();
    return { file, shouldDeleteOldBlob, oldSha };
  },

  createShareCode(fileId, userId) {
    const file = state.files[fileId];
    if (!file || file.userId !== userId) return null;

    // Return existing share code if already created for this file
    const existing = Object.values(state.shares || {}).find((s) => s.fileId === fileId);
    if (existing) return existing;

    const codeSuffix = crypto.randomBytes(2).toString('hex').toUpperCase();
    const numSuffix = Math.floor(10 + Math.random() * 89);
    const shareCode = `CARD-${codeSuffix}${numSuffix}`;

    const share = {
      shareCode,
      fileId: file.id,
      ownerId: userId,
      name: file.name,
      folder: file.folder,
      sha256: file.sha256,
      sizeBytes: file.sizeBytes,
      mimeType: file.mimeType,
      claimsCount: 0,
      createdAt: new Date().toISOString()
    };

    if (!state.shares) state.shares = {};
    state.shares[shareCode] = share;
    persistDatabase();
    return share;
  },

  getShareByCode(rawCode) {
    if (!state.shares) return null;
    const code = String(rawCode || '').trim().toUpperCase();
    return state.shares[code] || null;
  },

  claimShareCode(rawCode, targetUserId) {
    if (!state.shares) state.shares = {};
    const code = String(rawCode || '').trim().toUpperCase();
    const share = state.shares[code];
    if (!share) {
      throw new Error(
        'Invalid or expired Share Code. Check the code (e.g. CARD-A1B2) and try again.'
      );
    }

    const user = state.users[targetUserId];
    if (!user) throw new Error('User not found');

    db.assertCanUpload(targetUserId, share.sizeBytes);

    db.registerOrIncrementBlob({
      sha256: share.sha256,
      sizeBytes: share.sizeBytes,
      mimeType: share.mimeType
    });

    const clonedFile = db.createFileRecord({
      userId: targetUserId,
      name: share.name,
      folder: share.folder === 'Private Vault' ? 'All Files' : share.folder,
      sha256: share.sha256,
      sizeBytes: share.sizeBytes,
      mimeType: share.mimeType,
      isVaultLocked: false,
      deduplicated: true
    });

    share.claimsCount = (share.claimsCount || 0) + 1;
    persistDatabase();
    return { file: clonedFile, share };
  }
};
