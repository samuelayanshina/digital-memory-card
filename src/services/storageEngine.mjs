import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import dns from 'node:dns';
import net from 'node:net';
import { Readable } from 'node:stream';
import { APP_CONFIG } from '../config/plans.mjs';

const BLOBS_ROOT = path.resolve(APP_CONFIG.storageRoot, 'blobs');
const TMP_ROOT = path.resolve(APP_CONFIG.storageRoot, 'tmp');

fs.mkdirSync(BLOBS_ROOT, { recursive: true });
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

export function hasPhysicalBlob(sha256, expectedSizeBytes = null) {
  if (!isValidSha256(sha256)) return false;
  try {
    const blobPath = getBlobPath(sha256);
    if (!fs.existsSync(blobPath)) return false;
    if (expectedSizeBytes !== null) {
      const stat = fs.statSync(blobPath);
      return stat.size === Number(expectedSizeBytes);
    }
    return true;
  } catch {
    return false;
  }
}

// Cryptographic Proof-of-Ownership Slice Verifier (defends against SHA-256 hash spoofing)
export function computeBlobSliceHash(sha256, offset = 0, length = 64) {
  if (!hasPhysicalBlob(sha256)) return null;
  const blobPath = getBlobPath(sha256);
  const stat = fs.statSync(blobPath);
  if (stat.size === 0) {
    return crypto.createHash('sha256').update(Buffer.alloc(0)).digest('hex');
  }
  const safeOffset = Math.max(0, Math.min(Number(offset) || 0, Math.max(0, stat.size - 1)));
  const safeLength = Math.max(1, Math.min(Number(length) || 64, stat.size - safeOffset));
  const buf = Buffer.alloc(safeLength);
  const fd = fs.openSync(blobPath, 'r');
  try {
    const bytesRead = fs.readSync(fd, buf, 0, safeLength, safeOffset);
    return crypto.createHash('sha256').update(buf.subarray(0, bytesRead)).digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}

export function storeStreamAsBlob(
  reqStream,
  { maxBytes, expectedSha256 = null, isGzipCompressed = false }
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
          const alreadyExistedOnDisk = fs.existsSync(finalPath);
          if (alreadyExistedOnDisk) {
            cleanupTmp();
          } else {
            fs.renameSync(tmpFile, finalPath);
          }

          const compressionSavedBytes = Math.max(0, bytesWritten - networkBytesReceived);

          resolve({
            sha256: computedHash,
            sizeBytes: bytesWritten,
            networkBytesReceived,
            compressionSavedBytes,
            alreadyExistedOnDisk
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

export function finalizeUploadSessionAsBlob(uploadId, expectedSha256 = null) {
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

  return {
    sha256: computedHash,
    sizeBytes: fileBuffer.length,
    alreadyExistedOnDisk
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

export async function fetchRemoteUrlAsBlob(rawUrl, { maxBytes }) {
  let currentUrl = rawUrl;
  let response = null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    // Follow up to 3 redirect hops manually, validating DNS & IP on every single hop
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
    const { sha256, sizeBytes, alreadyExistedOnDisk } = await storeStreamAsBlob(nodeStream, {
      maxBytes
    });

    return {
      sha256,
      sizeBytes,
      mimeType: contentType.split(';')[0].trim(),
      inferredName,
      alreadyExistedOnDisk
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function storeBufferAsBlob(buffer) {
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex').toLowerCase();
  const finalPath = getBlobPath(sha256);
  const alreadyExistedOnDisk = fs.existsSync(finalPath);
  if (!alreadyExistedOnDisk) {
    fs.writeFileSync(finalPath, buffer);
  }
  return {
    sha256,
    sizeBytes: buffer.length,
    alreadyExistedOnDisk
  };
}

export function deletePhysicalBlob(sha256) {
  try {
    const blobPath = getBlobPath(sha256);
    if (fs.existsSync(blobPath)) {
      fs.unlinkSync(blobPath);
    }
  } catch (err) {
    console.error('[Storage] Failed to delete physical blob:', err.message);
  }
}
