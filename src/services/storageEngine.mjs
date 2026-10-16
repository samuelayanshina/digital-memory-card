import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
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

export function storeStreamAsBlob(reqStream, { maxBytes, expectedSha256 = null }) {
  return new Promise((resolve, reject) => {
    const tmpFile = path.join(
      TMP_ROOT,
      `upload_${Date.now()}_${crypto.randomBytes(6).toString('hex')}.part`
    );
    const writeStream = fs.createWriteStream(tmpFile);
    const hasher = crypto.createHash('sha256');
    let bytesWritten = 0;
    let aborted = false;

    const cleanupTmp = () => {
      try {
        if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
      } catch {
        // Ignore cleanup errors
      }
    };

    const fail = (err) => {
      if (aborted) return;
      aborted = true;
      writeStream.destroy();
      cleanupTmp();
      reject(err);
    };

    reqStream.on('data', (chunk) => {
      if (aborted) return;
      bytesWritten += chunk.length;
      if (bytesWritten > maxBytes) {
        reqStream.pause();
        return fail(new Error('QUOTA_EXCEEDED: Upload exceeds your remaining Digital Memory Card space'));
      }
      hasher.update(chunk);
      const canContinue = writeStream.write(chunk);
      if (!canContinue) {
        reqStream.pause();
        writeStream.once('drain', () => reqStream.resume());
      }
    });

    reqStream.on('error', (err) => fail(err));
    writeStream.on('error', (err) => fail(err));

    reqStream.on('end', () => {
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

          resolve({
            sha256: computedHash,
            sizeBytes: bytesWritten,
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
