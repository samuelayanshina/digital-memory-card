import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { STORAGE_PLANS, APP_CONFIG } from './config/plans.mjs';
import { db } from './db/database.mjs';
import {
  checkRateLimit,
  applySecurityHeaders,
  getOrProvisionUser,
  setSessionCookie
} from './middleware/security.mjs';
import {
  isValidSha256,
  hasPhysicalBlob,
  storeStreamAsBlob,
  storeBufferAsBlob,
  deletePhysicalBlob
} from './services/storageEngine.mjs';
import {
  signFileStreamToken,
  verifyFileStreamToken,
  streamFileBlob
} from './services/streamEngine.mjs';
import {
  subscribeUserEvents,
  pushToUser,
  joinP2PRoom,
  broadcastToP2PRoom,
  notifyTelegramAdminOfPayment,
  resolvePaymentAndNotifyUser,
  sanitizeUserForClient
} from './services/realtimeAndBot.mjs';
import { handleWebDavRequest } from './services/webdavServer.mjs';
import {
  scanDeveloperStorageHotspots,
  executeCodeInCardSandbox
} from './services/macDoctorAndRunner.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '../public');

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        reject(new Error('Request JSON body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf-8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('Invalid JSON payload'));
      }
    });
    req.on('error', reject);
  });
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress || '127.0.0.1';
}

function getLocalLanIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

function decorateFileWithStreamUrl(file, userId) {
  const { exp, sig } = signFileStreamToken(file.id, userId, 7200);
  return {
    ...file,
    streamUrl: `/api/files/${file.id}/stream?uid=${encodeURIComponent(userId)}&exp=${exp}&sig=${sig}`,
    downloadUrl: `/api/files/${file.id}/stream?uid=${encodeURIComponent(userId)}&exp=${exp}&sig=${sig}&download=1`
  };
}

// Generate a real playable stereo WAV audio sample (Afrobeats-inspired synth chord loop)
function createSampleAudioWavBuffer() {
  const sampleRate = 22050;
  const durationSeconds = 4;
  const numSamples = sampleRate * durationSeconds;
  const dataSize = numSamples * 2; // 16-bit mono
  const buffer = Buffer.alloc(44 + dataSize);

  // RIFF Header
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // PCM chunk size
  buffer.writeUInt16LE(1, 20);  // PCM format
  buffer.writeUInt16LE(1, 22);  // Mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  const notes = [261.63, 329.63, 392.0, 523.25]; // C4, E4, G4, C5
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const beatIndex = Math.floor(t * 2) % notes.length;
    const freq = notes[beatIndex];
    const envelope = Math.exp(-((t * 2) % 1) * 3.5);
    const wave =
      Math.sin(2 * Math.PI * freq * t) * 0.55 +
      Math.sin(2 * Math.PI * (freq * 1.5) * t) * 0.25;
    const sample = Math.max(-1, Math.min(1, wave * envelope)) * 24000;
    buffer.writeInt16LE(Math.floor(sample), 44 + i * 2);
  }
  return buffer;
}

export function createAppServer() {
  const server = http.createServer(async (req, res) => {
    applySecurityHeaders(res);

    // WebDAV Virtual Drive Mount Endpoint (/webdav...)
    if (req.url.startsWith('/webdav')) {
      return handleWebDavRequest(req, res);
    }

    const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = urlObj.pathname;
    const clientIp = getClientIp(req);

    // Global API rate limit: 180 req / min / IP
    if (pathname.startsWith('/api/')) {
      const rl = checkRateLimit(`api:${clientIp}`, 180, 60 * 1000);
      if (!rl.allowed) {
        return sendJson(res, 429, {
          error: `Too many requests. Please wait ${rl.retryAfterSec} seconds.`
        });
      }
    }

    try {
      // 1. GET /api/session — Zero-Login Instant Card Provisioning
      if (pathname === '/api/session' && req.method === 'GET') {
        const user = getOrProvisionUser(req, res, true);
        const files = db
          .getUserFiles(user.id)
          .map((f) => decorateFileWithStreamUrl(f, user.id));
        const payments = db.getUserPayments(user.id);
        const lanIp = getLocalLanIp();
        const hostHeader = req.headers.host || `${lanIp}:${APP_CONFIG.port}`;

        return sendJson(res, 200, {
          user: sanitizeUserForClient(user),
          files,
          payments,
          plans: STORAGE_PLANS,
          merchant: APP_CONFIG.merchant,
          stats: db.getStats(),
          webdavUrl: `http://${hostHeader}/webdav/${user.sessionToken}`,
          lanUrl: `http://${lanIp}:${APP_CONFIG.port}`
        });
      }

      // 2. GET /api/events/stream — Live SSE Updates (Payment Unlocks & File Sync)
      if (pathname === '/api/events/stream' && req.method === 'GET') {
        const user = getOrProvisionUser(req, res, true);
        return subscribeUserEvents(user.id, res);
      }

      // 3. POST /api/auth/lock — Lock Instant Card to Nigerian Phone Number + 4-Digit PIN
      if (pathname === '/api/auth/lock' && req.method === 'POST') {
        const rl = checkRateLimit(`auth:${clientIp}`, 10, 15 * 60 * 1000);
        if (!rl.allowed) {
          return sendJson(res, 429, {
            error: `Too many attempts. Try again in ${rl.retryAfterSec}s.`
          });
        }
        const user = getOrProvisionUser(req, res, true);
        const body = await readJsonBody(req);
        const updatedUser = db.lockUserToPhone(user.id, {
          phone: body.phone,
          pin: body.pin,
          displayName: body.displayName
        });
        return sendJson(res, 200, {
          user: sanitizeUserForClient(updatedUser),
          message: 'Memory Card permanently locked to your phone number and 4-digit PIN!'
        });
      }

      // 4. POST /api/auth/restore — Open Existing Memory Card on Any Device (Mac, iPhone, Android, PC)
      if (pathname === '/api/auth/restore' && req.method === 'POST') {
        const rl = checkRateLimit(`restore:${clientIp}`, 6, 15 * 60 * 1000);
        if (!rl.allowed) {
          return sendJson(res, 429, {
            error: `Too many PIN attempts. Locked for ${rl.retryAfterSec}s.`
          });
        }
        const body = await readJsonBody(req);
        const restoredUser = db.authenticatePhoneAndPin(body.phone, body.pin);
        if (!restoredUser) {
          return sendJson(res, 401, {
            error: 'Invalid phone number or 4-digit PIN. Please check and try again.'
          });
        }
        setSessionCookie(res, restoredUser.sessionToken);
        const files = db
          .getUserFiles(restoredUser.id)
          .map((f) => decorateFileWithStreamUrl(f, restoredUser.id));
        return sendJson(res, 200, {
          user: sanitizeUserForClient(restoredUser),
          files,
          payments: db.getUserPayments(restoredUser.id),
          message: `Welcome back! Loaded Memory Card ${restoredUser.cardSerial}`
        });
      }

      // 5. POST /api/auth/verify-pin — Unlock Private Vault Folder
      if (pathname === '/api/auth/verify-pin' && req.method === 'POST') {
        const rl = checkRateLimit(`vault:${clientIp}`, 6, 10 * 60 * 1000);
        if (!rl.allowed) {
          return sendJson(res, 429, { error: 'Too many PIN attempts. Please wait.' });
        }
        const user = getOrProvisionUser(req, res, false);
        if (!user) return sendJson(res, 401, { error: 'Session required' });
        const body = await readJsonBody(req);
        const valid = db.verifyUserPin(user.id, body.pin);
        if (!valid) {
          return sendJson(res, 403, {
            error: user.isLockedToPhone
              ? 'Incorrect 4-digit PIN'
              : 'Incorrect PIN (Default starter PIN is 0000 until you lock your card)'
          });
        }
        return sendJson(res, 200, { unlocked: true });
      }

      // 6. POST /api/files/preflight — SHA-256 Deduplication Preflight Check (Zero-Data Instant Upload!)
      if (pathname === '/api/files/preflight' && req.method === 'POST') {
        const user = getOrProvisionUser(req, res, true);
        const body = await readJsonBody(req);
        const { sha256, sizeBytes, name, mimeType, folder, isVaultLocked } = body;

        if (!isValidSha256(sha256)) {
          return sendJson(res, 400, { error: 'Valid 64-char SHA-256 hash required' });
        }

        const numericSize = Number(sizeBytes || 0);
        if (user.usedBytes + numericSize > user.quotaBytes) {
          return sendJson(res, 507, {
            error: 'QUOTA_EXCEEDED: Your Digital Memory Card is full. Upgrade for ₦250 or ₦500 to add space!'
          });
        }

        // Check if physical blob already exists on our server!
        if (hasPhysicalBlob(sha256, numericSize)) {
          db.registerOrIncrementBlob({ sha256: sha256.toLowerCase(), sizeBytes: numericSize, mimeType });
          const fileRecord = db.createFileRecord({
            userId: user.id,
            name: name || 'Deduplicated_File',
            folder: folder || 'All Files',
            sha256: sha256.toLowerCase(),
            sizeBytes: numericSize,
            mimeType,
            isVaultLocked: Boolean(isVaultLocked),
            deduplicated: true
          });

          const updatedUser = db.getUserById(user.id);
          return sendJson(res, 200, {
            instantMatch: true,
            deduplicated: true,
            message: '⚡ Instant Zero-Data Match! File already in Cloud Vault — 0 MB data spent!',
            file: decorateFileWithStreamUrl(fileRecord, user.id),
            user: sanitizeUserForClient(updatedUser),
            stats: db.getStats()
          });
        }

        return sendJson(res, 200, {
          instantMatch: false,
          uploadAllowed: true
        });
      }

      // 7. POST /api/files/upload — Stream File Upload to Content-Addressable Storage
      if (pathname === '/api/files/upload' && req.method === 'POST') {
        const user = getOrProvisionUser(req, res, true);
        const rawName = decodeURIComponent(req.headers['x-file-name'] || 'Uploaded_File');
        const mimeType = req.headers['x-file-type'] || 'application/octet-stream';
        const folder = decodeURIComponent(req.headers['x-file-folder'] || 'All Files');
        const expectedSha256 = req.headers['x-file-sha256'] || null;
        const isVaultLocked = req.headers['x-file-vault'] === 'true';

        const remainingQuota = Math.max(0, user.quotaBytes - user.usedBytes);
        if (remainingQuota <= 0) {
          req.resume();
          return sendJson(res, 507, {
            error: 'Your Digital Memory Card is full! Tap Upgrade (from ₦250) to expand immediately.'
          });
        }

        const { sha256, sizeBytes } = await storeStreamAsBlob(req, {
          maxBytes: remainingQuota,
          expectedSha256
        });

        const { deduplicated } = db.registerOrIncrementBlob({
          sha256,
          sizeBytes,
          mimeType
        });

        const fileRecord = db.createFileRecord({
          userId: user.id,
          name: rawName,
          folder,
          sha256,
          sizeBytes,
          mimeType,
          isVaultLocked,
          deduplicated
        });

        const updatedUser = db.getUserById(user.id);
        return sendJson(res, 201, {
          deduplicated,
          file: decorateFileWithStreamUrl(fileRecord, user.id),
          user: sanitizeUserForClient(updatedUser),
          stats: db.getStats()
        });
      }

      // 8. POST /api/files/seed-demo — Seed Playable Sample Media & Dev Kit
      if (pathname === '/api/files/seed-demo' && req.method === 'POST') {
        const user = getOrProvisionUser(req, res, true);

        const samples = [
          {
            name: 'Afrobeats_Studio_Session_Preview.wav',
            folder: 'Movies & Media',
            mimeType: 'audio/wav',
            buffer: createSampleAudioWavBuffer()
          },
          {
            name: 'MacBook_256GB_Cleanup_Guide.md',
            folder: 'Dev & Code',
            mimeType: 'text/markdown',
            buffer: Buffer.from(
              `# MacBook 256GB Developer Survival Guide (CardNG)\n\n` +
                `Your Digital Memory Card (${user.cardSerial}) is active!\n\n` +
                `## How to Mount This Card in macOS Finder as a Real Drive:\n` +
                `1. Open **Finder** on your MacBook.\n` +
                `2. Press **Cmd + K** (or click **Go → Connect to Server**).\n` +
                `3. Paste your personal WebDAV Drive URL from the dashboard.\n` +
                `4. Click **Connect** — your Digital Memory Card appears in Finder just like a physical SD card!\n\n` +
                `## Safe to Offload Here:\n` +
                `- Old \`node_modules\` archives & project zip backups\n` +
                `- Python ML datasets & CSV dumps\n` +
                `- 4K tutorial videos, movies & screen recordings\n` +
                `- Figma exports & UI kits\n`,
              'utf-8'
            )
          },
          {
            name: 'python_dataset_cleaner.py',
            folder: 'Dev & Code',
            mimeType: 'text/x-python',
            buffer: Buffer.from(
              `# Streamed directly from CardNG Digital Memory Card\n` +
                `import hashlib\n\n` +
                `def verify_cardng_blob(filepath: str) -> str:\n` +
                `    """Computes SHA-256 content fingerprint for zero-data deduplication."""\n` +
                `    h = hashlib.sha256()\n` +
                `    with open(filepath, "rb") as f:\n` +
                `        while chunk := f.read(1024 * 1024):\n` +
                `            h.update(chunk)\n` +
                `    return h.hexdigest()\n\n` +
                `if __name__ == "__main__":\n` +
                `    print("CardNG Developer Engine Ready — 0 Bytes Local SSD Used!")\n`,
              'utf-8'
            )
          },
          {
            name: 'lagos_storage_calculator.js',
            folder: 'Dev & Code',
            mimeType: 'text/javascript',
            buffer: Buffer.from(
              `// Editable & Runnable directly inside CardNG Cloud Studio (0B Local Space)\n` +
                `const macbookTotalGB = 256;\n` +
                `const offloadedMoviesGB = 42.5;\n` +
                `const offloadedXcodeArchivesGB = 28.0;\n` +
                `const totalFreedGB = offloadedMoviesGB + offloadedXcodeArchivesGB;\n\n` +
                `console.log("MacBook Internal SSD:", macbookTotalGB + " GB");\n` +
                `console.log("Space Freed via CardNG:", totalFreedGB + " GB");\n` +
                `console.log("Remaining Local Disk Pressure: LOW (Ready for Xcode & Python)");\n\n` +
                `({ freedPercent: ((totalFreedGB / macbookTotalGB) * 100).toFixed(1) + "%" });\n`,
              'utf-8'
            )
          }
        ];

        const createdFiles = [];
        for (const item of samples) {
          const { sha256, sizeBytes } = storeBufferAsBlob(item.buffer);
          const { deduplicated } = db.registerOrIncrementBlob({
            sha256,
            sizeBytes,
            mimeType: item.mimeType
          });
          const rec = db.createFileRecord({
            userId: user.id,
            name: item.name,
            folder: item.folder,
            sha256,
            sizeBytes,
            mimeType: item.mimeType,
            deduplicated
          });
          createdFiles.push(decorateFileWithStreamUrl(rec, user.id));
        }

        const updatedUser = db.getUserById(user.id);
        return sendJson(res, 201, {
          files: createdFiles,
          user: sanitizeUserForClient(updatedUser),
          stats: db.getStats()
        });
      }

      // 8b. POST /api/files/create-text — Create New Code / Note File Directly on Card
      if (pathname === '/api/files/create-text' && req.method === 'POST') {
        const user = getOrProvisionUser(req, res, true);
        const body = await readJsonBody(req, 5 * 1024 * 1024);
        const name = String(body.name || 'untitled.js').trim();
        const content = String(body.content || '');
        const folder = String(body.folder || 'Dev & Code');
        const mimeType = name.endsWith('.js')
          ? 'text/javascript'
          : name.endsWith('.py')
            ? 'text/x-python'
            : name.endsWith('.md')
              ? 'text/markdown'
              : 'text/plain';

        const buf = Buffer.from(content, 'utf-8');
        if (user.usedBytes + buf.length > user.quotaBytes) {
          return sendJson(res, 507, { error: 'QUOTA_EXCEEDED: Not enough space on Memory Card' });
        }

        const { sha256, sizeBytes } = storeBufferAsBlob(buf);
        const { deduplicated } = db.registerOrIncrementBlob({ sha256, sizeBytes, mimeType });
        const rec = db.createFileRecord({
          userId: user.id,
          name,
          folder,
          sha256,
          sizeBytes,
          mimeType,
          deduplicated
        });

        return sendJson(res, 201, {
          file: decorateFileWithStreamUrl(rec, user.id),
          user: sanitizeUserForClient(db.getUserById(user.id))
        });
      }

      // 8c. PUT /api/files/:id/content — Save Cloud Studio Edits Directly to Card
      const contentMatch = pathname.match(/^\/api\/files\/([^/]+)\/content$/);
      if (contentMatch && req.method === 'PUT') {
        const user = getOrProvisionUser(req, res, false);
        if (!user) return sendJson(res, 401, { error: 'Unauthorized' });
        const body = await readJsonBody(req, 5 * 1024 * 1024);
        const buf = Buffer.from(String(body.content ?? ''), 'utf-8');
        const { sha256, sizeBytes } = storeBufferAsBlob(buf);

        const updated = db.updateFileBlob(contentMatch[1], user.id, {
          newSha256: sha256,
          newSizeBytes: sizeBytes
        });
        if (!updated) return sendJson(res, 404, { error: 'File not found' });
        if (updated.shouldDeleteOldBlob && updated.oldSha) {
          deletePhysicalBlob(updated.oldSha);
        }

        return sendJson(res, 200, {
          file: decorateFileWithStreamUrl(updated.file, user.id),
          user: sanitizeUserForClient(db.getUserById(user.id))
        });
      }

      // 8d. POST /api/workspace/run — Run JS Code Directly on Digital Memory Card
      if (pathname === '/api/workspace/run' && req.method === 'POST') {
        const body = await readJsonBody(req, 512 * 1024);
        const result = executeCodeInCardSandbox(body.code || '', body.filename || 'card_script.js');
        return sendJson(res, 200, result);
      }

      // 8e. POST /api/files/:id/share — Generate Zero-Data Instant Share Code
      const shareMatch = pathname.match(/^\/api\/files\/([^/]+)\/share$/);
      if (shareMatch && req.method === 'POST') {
        const user = getOrProvisionUser(req, res, false);
        if (!user) return sendJson(res, 401, { error: 'Unauthorized' });
        const share = db.createShareCode(shareMatch[1], user.id);
        if (!share) return sendJson(res, 404, { error: 'File not found' });
        return sendJson(res, 200, { share });
      }

      // 8f. POST /api/files/claim-share — Claim Shared File into Card (0 MB Internet Data!)
      if (pathname === '/api/files/claim-share' && req.method === 'POST') {
        const user = getOrProvisionUser(req, res, true);
        const body = await readJsonBody(req);
        const { file, share } = db.claimShareCode(body.shareCode, user.id);
        const updatedUser = db.getUserById(user.id);
        return sendJson(res, 201, {
          file: decorateFileWithStreamUrl(file, user.id),
          share,
          user: sanitizeUserForClient(updatedUser)
        });
      }

      // 8g. GET /api/mac-doctor/scan — Scan 256GB MacBook Developer Storage Hotspots
      if (pathname === '/api/mac-doctor/scan' && req.method === 'GET') {
        const report = scanDeveloperStorageHotspots();
        return sendJson(res, 200, report);
      }

      // 9. GET /api/files/:id/stream — HTTP 206 Partial Content Media Streamer
      const streamMatch = pathname.match(/^\/api\/files\/([^/]+)\/stream$/);
      if (streamMatch && (req.method === 'GET' || req.method === 'HEAD')) {
        const fileId = streamMatch[1];
        const file = db.getFileById(fileId);
        if (!file) {
          return sendJson(res, 404, { error: 'File not found on this Memory Card' });
        }

        const uid = urlObj.searchParams.get('uid');
        const exp = urlObj.searchParams.get('exp');
        const sig = urlObj.searchParams.get('sig');
        const download = urlObj.searchParams.get('download') === '1';

        const validSig = verifyFileStreamToken(fileId, uid, exp, sig);
        const sessionUser = getOrProvisionUser(req, res, false);
        const authorized = validSig || (sessionUser && sessionUser.id === file.userId);

        if (!authorized) {
          return sendJson(res, 403, { error: 'Expired or unauthorized stream link' });
        }

        return streamFileBlob(req, res, file, { download });
      }

      // 10. PATCH /api/files/:id/vault — Toggle PIN Vault Lock on a File
      const vaultMatch = pathname.match(/^\/api\/files\/([^/]+)\/vault$/);
      if (vaultMatch && req.method === 'PATCH') {
        const user = getOrProvisionUser(req, res, false);
        if (!user) return sendJson(res, 401, { error: 'Unauthorized' });
        const body = await readJsonBody(req);
        const updated = db.toggleFileVault(vaultMatch[1], user.id, body.isVaultLocked);
        if (!updated) return sendJson(res, 404, { error: 'File not found' });
        return sendJson(res, 200, { file: decorateFileWithStreamUrl(updated, user.id) });
      }

      // 11. DELETE /api/files/:id — Delete File from Card (Ref-Counted Physical Cleanup)
      const deleteMatch = pathname.match(/^\/api\/files\/([^/]+)$/);
      if (deleteMatch && req.method === 'DELETE') {
        const user = getOrProvisionUser(req, res, false);
        if (!user) return sendJson(res, 401, { error: 'Unauthorized' });
        const result = db.deleteFileRecord(deleteMatch[1], user.id);
        if (!result) return sendJson(res, 404, { error: 'File not found' });

        if (result.shouldDeletePhysicalBlob) {
          deletePhysicalBlob(result.deletedFile.sha256);
        }

        const updatedUser = db.getUserById(user.id);
        return sendJson(res, 200, {
          deletedId: deleteMatch[1],
          user: sanitizeUserForClient(updatedUser),
          stats: db.getStats()
        });
      }

      // 12. POST /api/payments/claim — Submit OPay / PalmPay Transfer Claim
      if (pathname === '/api/payments/claim' && req.method === 'POST') {
        const user = getOrProvisionUser(req, res, true);
        const rl = checkRateLimit(`payclaim:${user.id}`, 6, 60 * 60 * 1000);
        if (!rl.allowed) {
          return sendJson(res, 429, {
            error: 'Too many transfer claims submitted. Please wait for verification.'
          });
        }

        const body = await readJsonBody(req);
        const payment = db.createPaymentClaim({
          userId: user.id,
          planId: body.planId,
          channel: body.channel || 'OPay',
          senderName: body.senderName || ''
        });

        const tgResult = await notifyTelegramAdminOfPayment(payment);
        return sendJson(res, 201, {
          payment,
          telegramDelivery: tgResult,
          message: `Transfer claim ${payment.reference} received! Waiting for 1-Tap confirmation.`
        });
      }

      // 13. POST /api/payments/:id/resolve — Admin / Telegram 1-Tap Approve or Reject
      const resolveMatch = pathname.match(/^\/api\/payments\/([^/]+)\/resolve$/);
      if (resolveMatch && req.method === 'POST') {
        const paymentId = resolveMatch[1];
        const body = await readJsonBody(req);
        const action = body.action === 'REJECT' ? 'REJECT' : 'APPROVE';
        const { payment, user } = resolvePaymentAndNotifyUser(paymentId, action);
        return sendJson(res, 200, {
          payment,
          user: sanitizeUserForClient(user)
        });
      }

      // 14. GET /api/payments/pending — List Pending Claims for Admin / Telegram Simulator
      if (pathname === '/api/payments/pending' && req.method === 'GET') {
        return sendJson(res, 200, {
          pending: db.getPendingPayments()
        });
      }

      // 15. Local Wi-Fi Zero-Data P2P Transfer Endpoints
      const p2pRoomMatch = pathname.match(/^\/api\/p2p\/room\/([^/]+)$/);
      if (p2pRoomMatch && req.method === 'GET') {
        const roomCode = p2pRoomMatch[1];
        const peerId = urlObj.searchParams.get('peerId') || `peer_${Date.now()}`;
        const deviceName = urlObj.searchParams.get('device') || 'CardNG Device';
        return joinP2PRoom(roomCode, peerId, deviceName, res);
      }

      if (pathname === '/api/p2p/signal' && req.method === 'POST') {
        const body = await readJsonBody(req, 10 * 1024 * 1024); // Allow up to 10MB local P2P chunks
        broadcastToP2PRoom(body.roomCode, body, body.senderPeerId);
        return sendJson(res, 200, { relayed: true });
      }

      // Serve Static Frontend PWA Files
      let safePath = pathname === '/' ? '/index.html' : pathname;
      safePath = path.normalize(safePath).replace(/^(\.\.(\/|\\|$))+/, '');
      const fullPath = path.join(PUBLIC_DIR, safePath);

      if (fullPath.startsWith(PUBLIC_DIR) && fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
        const ext = path.extname(fullPath).toLowerCase();
        const mimeTypes = {
          '.html': 'text/html; charset=utf-8',
          '.css': 'text/css; charset=utf-8',
          '.js': 'text/javascript; charset=utf-8',
          '.json': 'application/json; charset=utf-8',
          '.svg': 'image/svg+xml',
          '.png': 'image/png',
          '.ico': 'image/x-icon'
        };
        res.writeHead(200, {
          'Content-Type': mimeTypes[ext] || 'application/octet-stream',
          'Cache-Control': 'no-cache'
        });
        fs.createReadStream(fullPath).pipe(res);
        return;
      }

      // Fallback SPA / 404
      sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      console.error('[Server Error]:', err);
      const status = err.message?.startsWith('QUOTA_EXCEEDED') ? 507 : 400;
      if (!res.headersSent) {
        sendJson(res, status, { error: err.message || 'Internal Server Error' });
      }
    }
  });

  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createAppServer();
  server.listen(APP_CONFIG.port, APP_CONFIG.host, () => {
    const lanIp = getLocalLanIp();
    console.log(`\n==================================================================`);
    console.log(`💾 CardNG — Digital Memory Card Server Running!`);
    console.log(`   • Mac / PC Browser:   http://localhost:${APP_CONFIG.port}`);
    console.log(`   • iPhone / Android:   http://${lanIp}:${APP_CONFIG.port} (Same Wi-Fi)`);
    console.log(`   • Mac Finder Mount:   http://localhost:${APP_CONFIG.port}/webdav/<your-token>`);
    console.log(`==================================================================\n`);
  });
}
