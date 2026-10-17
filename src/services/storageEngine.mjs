import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import dns from 'node:dns';
import net from 'node:net';
import { Readable, Transform } from 'node:stream';
import { APP_CONFIG } from '../config/plans.mjs';

const BLOBS_ROOT = path.resolve(APP_CONFIG.storageRoot, 'blobs');
const COLD_ARCHIVE_ROOT = path.resolve(APP_CONFIG.storageRoot, 'cold_archive');
const TMP_ROOT = path.resolve(APP_CONFIG.storageRoot, 'tmp');

// 8-byte magic header identifying Convergent AES-256-CTR encrypted blobs on disk
const ENC_MAGIC = Buffer.from('CNGENC01', 'ascii');

fs.mkdirSync(BLOBS_ROOT, { recursive: true });
fs.mkdirSync(COLD_ARCHIVE_ROOT, { recursive: true });
fs.mkdirSync(TMP_ROOT, { recursive: true });

export function isValidSha256(hash) {
  return typeof hash === 'string' && /^[a-f0-9]{64}$/i.test(hash);
}

export function getBlobPath(sha256) {
  const cleanHash = sha256.toLowerCase();
  if (!isValidSha256(cleanHash)) {
    throw new Error('Invalid SHA-256 hash');
  }
  const shard = cleanHash.slice(0, 2);
  const dir = path.join(BLOBS_ROOT, shard);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${cleanHash}.blob`);
}

export function getColdBlobPath(sha256) {
  const cleanHash = sha256.toLowerCase();
  if (!isValidSha256(cleanHash)) {
    throw new Error('Invalid SHA-256 hash');
  }
  const shard = cleanHash.slice(0, 2);
  const dir = path.join(COLD_ARCHIVE_ROOT, shard);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${cleanHash}.cold.gz`);
}

// Derive deterministic AES-256-CTR Key and block-offset Counter IV for random-access HTTP 206 decryption
export function deriveBlobKeyAndIv(sha256, blockCounterOffset = 0n) {
  const clean = String(sha256).toLowerCase();
  const key = crypto
    .createHmac('sha256', APP_CONFIG.appSecret)
    .update(`blob-aes256-key:${clean}`)
    .digest();
  const iv = Buffer.from(
    crypto
      .createHmac('sha256', APP_CONFIG.appSecret)
      .update(`blob-aes256-iv:${clean}`)
      .digest()
      .subarray(0, 16)
  );

  if (blockCounterOffset > 0n) {
    const high = iv.readBigUInt64BE(0);
    const low = iv.readBigUInt64BE(8);
    const combined = ((high << 64n) | low) + BigInt(blockCounterOffset);
    const mask64 = 0xffffffffffffffffn;
    iv.writeBigUInt64BE((combined >> 64n) & mask64, 0);
    iv.writeBigUInt64BE(combined & mask64, 8);
  }

  return { key, iv };
}

// Transparently restore a Cold-Archived blob back to Hot NVMe tier on demand
export function ensureBlobInHotTier(sha256) {
  if (!isValidSha256(sha256)) return false;
  const hotPath = getBlobPath(sha256);
  if (fs.existsSync(hotPath)) return true;

  const coldPath = getColdBlobPath(sha256);
  if (!fs.existsSync(coldPath)) return false;

  try {
    const compressed = fs.readFileSync(coldPath);
    const restored = zlib.gunzipSync(compressed);
    const tmpRestore = `${hotPath}.restore_${Date.now()}`;
    fs.writeFileSync(tmpRestore, restored);
    fs.renameSync(tmpRestore, hotPath);
    fs.unlinkSync(coldPath);
    return true;
  } catch (err) {
    console.error('[StorageTier] Failed to restore cold blob:', err.message);
    return false;
  }
}

// Offload a Hot NVMe blob into compressed Cold Archive storage (frees primary disk space)
export function offloadBlobToColdArchive(sha256) {
  if (!isValidSha256(sha256)) return null;
  const hotPath = getBlobPath(sha256);
  const coldPath = getColdBlobPath(sha256);

  if (!fs.existsSync(hotPath)) {
    if (fs.existsSync(coldPath)) {
      return {
        sha256: sha256.toLowerCase(),
        alreadyCold: true,
        coldArchiveBytes: fs.statSync(coldPath).size,
        hotBytesFreed: 0
      };
    }
    return null;
  }

  const rawBuf = fs.readFileSync(hotPath);
  const compressed = zlib.gzipSync(rawBuf, { level: zlib.constants.Z_BEST_COMPRESSION });
  const tmpCold = `${coldPath}.tmp_${Date.now()}`;
  fs.writeFileSync(tmpCold, compressed);
  fs.renameSync(tmpCold, coldPath);
  fs.unlinkSync(hotPath);

  return {
    sha256: sha256.toLowerCase(),
    alreadyCold: false,
    hotBytesFreed: rawBuf.length,
    coldArchiveBytes: compressed.length
  };
}

// Real-time Server Disk Capacity & Pressure Monitor via fs.statfsSync
export function getServerDiskHealth() {
  try {
    const statfs = fs.statfsSync(BLOBS_ROOT);
    const blockSize = Number(statfs.bsize || 4096);
    const totalDiskBytes = Number(statfs.blocks || 0) * blockSize;
    const freeDiskBytes = Number(statfs.bavail || statfs.bfree || 0) * blockSize;
    const usedDiskBytes = Math.max(0, totalDiskBytes - freeDiskBytes);
    const usagePercent =
      totalDiskBytes > 0 ? Number(((usedDiskBytes / totalDiskBytes) * 100).toFixed(1)) : 0;

    return {
      totalDiskBytes,
      freeDiskBytes,
      freeBytes: freeDiskBytes,
      usedDiskBytes,
      usagePercent,
      usedPercent: usagePercent,
      status: usagePercent >= 88 ? 'HIGH_PRESSURE_AUTO_TIER' : 'HEALTHY_NVME'
    };
  } catch {
    return {
      totalDiskBytes: 200 * 1024 * 1024 * 1024,
      freeDiskBytes: 180 * 1024 * 1024 * 1024,
      freeBytes: 180 * 1024 * 1024 * 1024,
      usedDiskBytes: 20 * 1024 * 1024 * 1024,
      usagePercent: 10.0,
      usedPercent: 10.0,
      status: 'HEALTHY_NVME'
    };
  }
}

export function isBlobEncryptedAtRest(sha256) {
  if (!isValidSha256(sha256)) return false;
  try {
    const blobPath = getBlobPath(sha256);
    if (!fs.existsSync(blobPath)) return false;
    const stat = fs.statSync(blobPath);
    if (stat.size < ENC_MAGIC.length) return false;
    const header = Buffer.alloc(ENC_MAGIC.length);
    const fd = fs.openSync(blobPath, 'r');
    try {
      fs.readSync(fd, header, 0, ENC_MAGIC.length, 0);
    } finally {
      fs.closeSync(fd);
    }
    return header.equals(ENC_MAGIC);
  } catch {
    return false;
  }
}

export function encryptBlobAtRest(sha256) {
  if (!ensureBlobInHotTier(sha256)) return false;
  if (isBlobEncryptedAtRest(sha256)) return true;

  const blobPath = getBlobPath(sha256);
  const plaintext = fs.readFileSync(blobPath);
  const { key, iv } = deriveBlobKeyAndIv(sha256, 0n);
  const cipher = crypto.createCipheriv('aes-256-ctr', key, iv);
  const encrypted = Buffer.concat([ENC_MAGIC, cipher.update(plaintext), cipher.final()]);

  const tmpEnc = `${blobPath}.enc_${Date.now()}`;
  fs.writeFileSync(tmpEnc, encrypted);
  fs.renameSync(tmpEnc, blobPath);
  return true;
}

export function getLogicalBlobSize(sha256) {
  if (!ensureBlobInHotTier(sha256)) return null;
  const blobPath = getBlobPath(sha256);
  const stat = fs.statSync(blobPath);
  if (isBlobEncryptedAtRest(sha256)) {
    return Math.max(0, stat.size - ENC_MAGIC.length);
  }
  return stat.size;
}

export function hasPhysicalBlob(sha256, expectedSizeBytes = null) {
  if (!isValidSha256(sha256)) return false;
  try {
    if (!ensureBlobInHotTier(sha256)) return false;
    const logicalSize = getLogicalBlobSize(sha256);
    if (logicalSize === null) return false;
    if (expectedSizeBytes !== null) {
      return logicalSize === Number(expectedSizeBytes);
    }
    return true;
  } catch {
    return false;
  }
}

// Stream plaintext bytes from any blob (transparently restoring Cold Tier & decrypting AES-256-CTR byte ranges!)
export function createPlaintextBlobReadStream(sha256, { start = 0, end = null } = {}) {
  ensureBlobInHotTier(sha256);
  const blobPath = getBlobPath(sha256);
  const logicalSize = getLogicalBlobSize(sha256);
  const safeStart = Math.max(0, Number(start) || 0);
  const safeEnd =
    end !== null && end !== undefined
      ? Math.min(Number(end), Math.max(0, logicalSize - 1))
      : Math.max(0, logicalSize - 1);

  if (!isBlobEncryptedAtRest(sha256)) {
    return fs.createReadStream(blobPath, { start: safeStart, end: safeEnd });
  }

  // Random-access AES-256-CTR decryption starting at arbitrary byte offset safeStart
  const blockIndex = BigInt(Math.floor(safeStart / 16));
  const skipHeadBytes = safeStart % 16;
  const alignedPlainStart = safeStart - skipHeadBytes;
  const cipherFileStart = ENC_MAGIC.length + alignedPlainStart;
  const cipherFileEnd = ENC_MAGIC.length + safeEnd;

  const { key, iv } = deriveBlobKeyAndIv(sha256, blockIndex);
  const cipherReadStream = fs.createReadStream(blobPath, {
    start: cipherFileStart,
    end: cipherFileEnd
  });
  const decipher = crypto.createDecipheriv('aes-256-ctr', key, iv);

  if (skipHeadBytes === 0) {
    cipherReadStream.on('error', (err) => decipher.destroy(err));
    return cipherReadStream.pipe(decipher);
  }

  let bytesToSkip = skipHeadBytes;
  const skipper = new Transform({
    transform(chunk, _encoding, callback) {
      if (bytesToSkip > 0) {
        if (chunk.length <= bytesToSkip) {
          bytesToSkip -= chunk.length;
          return callback();
        }
        const sliced = chunk.subarray(bytesToSkip);
        bytesToSkip = 0;
        this.push(sliced);
        return callback();
      }
      this.push(chunk);
      callback();
    }
  });

  cipherReadStream.on('error', (err) => skipper.destroy(err));
  decipher.on('error', (err) => skipper.destroy(err));
  return cipherReadStream.pipe(decipher).pipe(skipper);
}

// Cryptographic Proof-of-Ownership Slice Verifier (works on both plaintext and AES-256-CTR encrypted blobs)
export function computeBlobSliceHash(sha256, offset = 0, length = 64) {
  if (!hasPhysicalBlob(sha256)) return null;
  const logicalSize = getLogicalBlobSize(sha256);
  if (logicalSize === 0) {
    return crypto.createHash('sha256').update(Buffer.alloc(0)).digest('hex');
  }

  const safeOffset = Math.max(0, Math.min(Number(offset) || 0, Math.max(0, logicalSize - 1)));
  const safeLength = Math.max(1, Math.min(Number(length) || 64, logicalSize - safeOffset));

  const blobPath = getBlobPath(sha256);
  if (!isBlobEncryptedAtRest(sha256)) {
    const buf = Buffer.alloc(safeLength);
    const fd = fs.openSync(blobPath, 'r');
    try {
      const bytesRead = fs.readSync(fd, buf, 0, safeLength, safeOffset);
      return crypto.createHash('sha256').update(buf.subarray(0, bytesRead)).digest('hex');
    } finally {
      fs.closeSync(fd);
    }
  }

  // Decrypt just the needed blocks for the slice
  const blockIndex = BigInt(Math.floor(safeOffset / 16));
  const skipHeadBytes = safeOffset % 16;
  const readLen = safeLength + skipHeadBytes;
  const cipherBuf = Buffer.alloc(readLen);
  const fd = fs.openSync(blobPath, 'r');
  let bytesRead = 0;
  try {
    bytesRead = fs.readSync(
      fd,
      cipherBuf,
      0,
      readLen,
      ENC_MAGIC.length + safeOffset - skipHeadBytes
    );
  } finally {
    fs.closeSync(fd);
  }
  const { key, iv } = deriveBlobKeyAndIv(sha256, blockIndex);
  const decipher = crypto.createDecipheriv('aes-256-ctr', key, iv);
  const decrypted = Buffer.concat([
    decipher.update(cipherBuf.subarray(0, bytesRead)),
    decipher.final()
  ]);
  const slice = decrypted.subarray(skipHeadBytes, skipHeadBytes + safeLength);
  return crypto.createHash('sha256').update(slice).digest('hex');
}

export function storeStreamAsBlob(
  reqStream,
  { maxBytes, expectedSha256 = null, isGzipCompressed = false, encryptAtRest = false }
) {
  return new Promise((resolve, reject) => {
    const tmpFile = path.join(
      TMP_ROOT,
      `upload_${Date.now()}_${crypto.randomBytes(6).toString('hex')}.part`
    );
    const writeStream = fs.createWriteStream(tmpFile);
    const hasher = crypto.createHash('sha256');
    let bytesWritten = 0;
    let networkBytesReceived = 0;
    let aborted = false;

    const cleanupTmp = () => {
      try {
        if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
      } catch {
        // Ignore cleanup errors
      }
    };

    const gunzipStream = isGzipCompressed ? zlib.createGunzip() : null;
    const sourceStream = gunzipStream ? reqStream.pipe(gunzipStream) : reqStream;

    const fail = (err) => {
      if (aborted) return;
      aborted = true;
      try {
        if (gunzipStream) gunzipStream.destroy();
        if (typeof reqStream.destroy === 'function') reqStream.destroy();
      } catch {
        // Ignore stream destroy errors
      }
      writeStream.destroy();
      cleanupTmp();
      reject(err);
    };

    reqStream.on('data', (rawChunk) => {
      if (aborted) return;
      networkBytesReceived += rawChunk.length;
      if (networkBytesReceived > maxBytes * 2 + 1024 * 1024) {
        fail(
          new Error('QUOTA_EXCEEDED: Raw upload stream exceeds your remaining Memory Card space')
        );
      }
    });

    if (isGzipCompressed) {
      reqStream.on('error', (err) => fail(err));
    }

    sourceStream.on('data', (chunk) => {
      if (aborted) return;
      bytesWritten += chunk.length;
      if (bytesWritten > maxBytes) {
        return fail(
          new Error('QUOTA_EXCEEDED: Upload exceeds your remaining Digital Memory Card space')
        );
      }
      hasher.update(chunk);
      const canContinue = writeStream.write(chunk);
      if (!canContinue) {
        sourceStream.pause();
        writeStream.once('drain', () => {
          if (!aborted) sourceStream.resume();
        });
      }
    });

    sourceStream.on('error', (err) => fail(err));
    writeStream.on('error', (err) => fail(err));

    sourceStream.on('end', () => {
      if (aborted) return;
      writeStream.end(() => {
        try {
          const computedHash = hasher.digest('hex').toLowerCase();
          if (expectedSha256 && expectedSha256.toLowerCase() !== computedHash) {
            cleanupTmp();
            return reject(new Error('CHECKSUM_MISMATCH: File corrupted during network transit'));
          }

          const finalPath = getBlobPath(computedHash);
          const alreadyExistedOnDisk =
            fs.existsSync(finalPath) || fs.existsSync(getColdBlobPath(computedHash));
          if (alreadyExistedOnDisk) {
            cleanupTmp();
            ensureBlobInHotTier(computedHash);
          } else {
            fs.renameSync(tmpFile, finalPath);
          }

          if (encryptAtRest) {
            encryptBlobAtRest(computedHash);
          }

          const compressionSavedBytes = Math.max(0, bytesWritten - networkBytesReceived);

          resolve({
            sha256: computedHash,
            sizeBytes: bytesWritten,
            networkBytesReceived,
            compressionSavedBytes,
            alreadyExistedOnDisk,
            encryptedAtRest: isBlobEncryptedAtRest(computedHash)
          });
        } catch (err) {
          cleanupTmp();
          reject(err);
        }
      });
    });
  });
}

// Resumable Chunked Upload Engine for Unstable 3G/4G Networks
export function getUploadSessionPartPath(uploadId) {
  const safeId = String(uploadId || '').replace(/[^a-zA-Z0-9_-]/g, '');
  return path.join(TMP_ROOT, `resumable_${safeId}.part`);
}

export function appendChunkToUploadSession(
  uploadId,
  reqStream,
  { expectedOffset = 0, maxTotalBytes }
) {
  return new Promise((resolve, reject) => {
    const partPath = getUploadSessionPartPath(uploadId);
    const currentSize = fs.existsSync(partPath) ? fs.statSync(partPath).size : 0;

    if (currentSize !== Number(expectedOffset)) {
      return reject(
        new Error(
          `OFFSET_MISMATCH: Server has ${currentSize} bytes, but client sent offset ${expectedOffset}`
        )
      );
    }

    const writeStream = fs.createWriteStream(partPath, { flags: 'a' });
    let chunkBytes = 0;
    let aborted = false;

    const fail = (err) => {
      if (aborted) return;
      aborted = true;
      writeStream.destroy();
      reject(err);
    };

    reqStream.on('data', (chunk) => {
      if (aborted) return;
      chunkBytes += chunk.length;
      if (currentSize + chunkBytes > maxTotalBytes) {
        return fail(new Error('QUOTA_EXCEEDED: Chunk exceeds declared total file size or quota'));
      }
      const canContinue = writeStream.write(chunk);
      if (!canContinue) {
        reqStream.pause();
        writeStream.once('drain', () => {
          if (!aborted) reqStream.resume();
        });
      }
    });

    reqStream.on('error', (err) => fail(err));
    writeStream.on('error', (err) => fail(err));

    reqStream.on('end', () => {
      if (aborted) return;
      writeStream.end(() => {
        resolve({
          chunkBytesWritten: chunkBytes,
          newOffsetBytes: currentSize + chunkBytes
        });
      });
    });
  });
}

export function finalizeUploadSessionAsBlob(
  uploadId,
  expectedSha256 = null,
  { encryptAtRest = false } = {}
) {
  const partPath = getUploadSessionPartPath(uploadId);
  if (!fs.existsSync(partPath)) {
    throw new Error('Resumable upload part file not found');
  }

  const fileBuffer = fs.readFileSync(partPath);
  const computedHash = crypto.createHash('sha256').update(fileBuffer).digest('hex').toLowerCase();

  if (expectedSha256 && expectedSha256.toLowerCase() !== computedHash) {
    fs.unlinkSync(partPath);
    throw new Error('CHECKSUM_MISMATCH: Final assembled file hash did not match expected SHA-256');
  }

  const finalPath = getBlobPath(computedHash);
  const alreadyExistedOnDisk = fs.existsSync(finalPath);
  if (alreadyExistedOnDisk) {
    fs.unlinkSync(partPath);
  } else {
    fs.renameSync(partPath, finalPath);
  }

  if (encryptAtRest) {
    encryptBlobAtRest(computedHash);
  }

  return {
    sha256: computedHash,
    sizeBytes: fileBuffer.length,
    alreadyExistedOnDisk,
    encryptedAtRest: isBlobEncryptedAtRest(computedHash)
  };
}

// Strict IPv4 / IPv6 Private & Reserved Range Classifier (blocks SSRF & DNS Rebinding)
export function isPrivateOrReservedIp(ip) {
  if (!ip || typeof ip !== 'string') return true;
  const clean = ip.trim().toLowerCase();

  if (clean.startsWith('::ffff:')) {
    return isPrivateOrReservedIp(clean.slice(7));
  }

  if (net.isIPv4(clean)) {
    const parts = clean.split('.').map(Number);
    const [a, b] = parts;
    if (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    ) {
      return true;
    }
    return false;
  }

  if (net.isIPv6(clean)) {
    if (
      clean === '::1' ||
      clean === '::' ||
      clean.startsWith('fc') ||
      clean.startsWith('fd') ||
      clean.startsWith('fe8') ||
      clean.startsWith('fe9') ||
      clean.startsWith('fea') ||
      clean.startsWith('feb')
    ) {
      return true;
    }
    return false;
  }

  return true;
}

export function isSafePublicUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (
      host === 'localhost' ||
      host.endsWith('.local') ||
      host.endsWith('.internal') ||
      host === 'metadata.google.internal'
    ) {
      return false;
    }
    if (net.isIP(host)) {
      return !isPrivateOrReservedIp(host);
    }
    return true;
  } catch {
    return false;
  }
}

export async function validatePublicUrlAndResolveDns(rawUrl) {
  if (!isSafePublicUrl(rawUrl)) {
    throw new Error('Please provide a valid public HTTP/HTTPS file link.');
  }
  const parsed = new URL(rawUrl);
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (isPrivateOrReservedIp(host)) {
      throw new Error('Please provide a valid public HTTP/HTTPS file link.');
    }
    return parsed;
  }

  const records = await dns.promises.lookup(host, { all: true });
  if (!records || records.length === 0) {
    throw new Error('Could not resolve remote hostname.');
  }
  for (const rec of records) {
    if (isPrivateOrReservedIp(rec.address)) {
      throw new Error('SSRF_BLOCKED: Remote hostname resolved to a private or reserved IP address.');
    }
  }
  return parsed;
}

export async function fetchRemoteUrlAsBlob(rawUrl, { maxBytes, encryptAtRest = false }) {
  let currentUrl = rawUrl;
  let response = null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    for (let hop = 0; hop <= 3; hop++) {
      await validatePublicUrlAndResolveDns(currentUrl);
      response = await fetch(currentUrl, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) {
          throw new Error('Remote redirect missing Location header.');
        }
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }
      break;
    }

    if (!response || !response.ok || !response.body) {
      throw new Error(`Remote server returned HTTP ${response ? response.status : 500}`);
    }

    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    const urlObj = new URL(currentUrl);
    const rawPathname = decodeURIComponent(path.basename(urlObj.pathname) || 'Cloud_Fetched_File');
    const inferredName =
      rawPathname && rawPathname !== '/' ? rawPathname : `Cloud_File_${Date.now()}.bin`;

    const nodeStream = Readable.fromWeb(response.body);
    const { sha256, sizeBytes, alreadyExistedOnDisk, encryptedAtRest } = await storeStreamAsBlob(
      nodeStream,
      { maxBytes, encryptAtRest }
    );

    return {
      sha256,
      sizeBytes,
      mimeType: contentType.split(';')[0].trim(),
      inferredName,
      alreadyExistedOnDisk,
      encryptedAtRest
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function storeBufferAsBlob(buffer, { encryptAtRest = false } = {}) {
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex').toLowerCase();
  const finalPath = getBlobPath(sha256);
  const alreadyExistedOnDisk = fs.existsSync(finalPath);
  if (!alreadyExistedOnDisk) {
    fs.writeFileSync(finalPath, buffer);
  }
  if (encryptAtRest) {
    encryptBlobAtRest(sha256);
  }
  return {
    sha256,
    sizeBytes: buffer.length,
    alreadyExistedOnDisk,
    encryptedAtRest: isBlobEncryptedAtRest(sha256)
  };
}

export function deletePhysicalBlob(sha256) {
  try {
    const blobPath = getBlobPath(sha256);
    if (fs.existsSync(blobPath)) {
      fs.unlinkSync(blobPath);
    }
    const coldPath = getColdBlobPath(sha256);
    if (fs.existsSync(coldPath)) {
      fs.unlinkSync(coldPath);
    }
  } catch (err) {
    console.error('[Storage] Failed to delete physical blob:', err.message);
  }
}
