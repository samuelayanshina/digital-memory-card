import crypto from 'node:crypto';
import { APP_CONFIG } from '../config/plans.mjs';
import {
  hasPhysicalBlob,
  getLogicalBlobSize,
  createPlaintextBlobReadStream
} from './storageEngine.mjs';
import { acquireStreamSlot } from '../middleware/security.mjs';

export function signFileStreamToken(fileId, userId, ttlSeconds = 7200) {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = `${fileId}:${userId}:${exp}`;
  const sig = crypto
    .createHmac('sha256', APP_CONFIG.appSecret)
    .update(payload)
    .digest('hex');
  return { exp, sig };
}

export function verifyFileStreamToken(fileId, userId, exp, sig) {
  if (!exp || !sig) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Number(exp) < now) return false;
  const payload = `${fileId}:${userId}:${exp}`;
  const expectedSig = crypto
    .createHmac('sha256', APP_CONFIG.appSecret)
    .update(payload)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expectedSig, 'hex'),
      Buffer.from(String(sig), 'hex')
    );
  } catch {
    return false;
  }
}

export function streamFileBlob(req, res, fileRecord, { download = false } = {}) {
  if (!hasPhysicalBlob(fileRecord.sha256)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Physical storage blob not found' }));
    return;
  }

  const totalSize = getLogicalBlobSize(fileRecord.sha256);
  const mimeType = fileRecord.mimeType || 'application/octet-stream';
  const safeName = encodeURIComponent(fileRecord.name).replace(/['()]/g, escape);
  const disposition = download
    ? `attachment; filename="${fileRecord.name.replace(/"/g, '')}"; filename*=UTF-8''${safeName}`
    : `inline; filename="${fileRecord.name.replace(/"/g, '')}"; filename*=UTF-8''${safeName}`;

  const releaseSlot = acquireStreamSlot(fileRecord.userId, 4);
  if (!releaseSlot) {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: 'Too many simultaneous streams active on this Memory Card. Close another stream and retry.'
      })
    );
    return;
  }

  res.on('close', releaseSlot);
  res.on('error', releaseSlot);

  const rangeHeader = req.headers.range;

  if (rangeHeader && rangeHeader.startsWith('bytes=')) {
    const parts = rangeHeader.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const requestedEnd = parts[1] ? parseInt(parts[1], 10) : totalSize - 1;
    const end = Math.min(requestedEnd, totalSize - 1);

    if (Number.isNaN(start) || start < 0 || start >= totalSize || start > end) {
      res.writeHead(416, {
        'Content-Range': `bytes */${totalSize}`
      });
      res.end();
      releaseSlot();
      return;
    }

    const chunkSize = end - start + 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${totalSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': mimeType,
      'Content-Disposition': disposition,
      'Cache-Control': 'private, max-age=3600'
    });

    if (req.method === 'HEAD') {
      res.end();
      releaseSlot();
      return;
    }

    const stream = createPlaintextBlobReadStream(fileRecord.sha256, { start, end });
    stream.on('error', () => {
      releaseSlot();
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
    stream.pipe(res);
    return;
  }

  // Full stream response with Accept-Ranges advertised for native players
  res.writeHead(200, {
    'Accept-Ranges': 'bytes',
    'Content-Length': totalSize,
    'Content-Type': mimeType,
    'Content-Disposition': disposition,
    'Cache-Control': 'private, max-age=3600'
  });

  if (req.method === 'HEAD') {
    res.end();
    releaseSlot();
    return;
  }

  const stream = createPlaintextBlobReadStream(fileRecord.sha256, {
    start: 0,
    end: totalSize - 1
  });
  stream.on('error', () => {
    releaseSlot();
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
  stream.pipe(res);
}
