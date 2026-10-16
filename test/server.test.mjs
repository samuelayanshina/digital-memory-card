import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Readable, PassThrough } from 'node:stream';
import { createAppServer } from '../src/server.mjs';

const server = createAppServer();

/**
 * In-process HTTP request dispatcher so the entire test suite runs fast
 * and works inside restricted sandboxes without needing loopback TCP sockets.
 */
function dispatch(urlPath, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const reqStream = new PassThrough();
    reqStream.url = urlPath;
    reqStream.method = method;
    reqStream.headers = {
      host: 'localhost:4000',
      ...Object.fromEntries(
        Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)])
      )
    };
    reqStream.socket = { remoteAddress: '127.0.0.1' };

    const resStream = new PassThrough();
    const resChunks = [];
    const resHeaders = {};
    let statusCode = 200;

    resStream.headersSent = false;
    resStream.setHeader = (name, value) => {
      resHeaders[name.toLowerCase()] = value;
    };
    resStream.getHeader = (name) => resHeaders[name.toLowerCase()];
    resStream.writeHead = (code, hdrs = {}) => {
      statusCode = code;
      resStream.headersSent = true;
      for (const [k, v] of Object.entries(hdrs)) {
        resHeaders[k.toLowerCase()] = v;
      }
      return resStream;
    };

    resStream.on('data', (chunk) => resChunks.push(Buffer.from(chunk)));
    resStream.on('end', () => {
      const rawBuffer = Buffer.concat(resChunks);
      resolve({
        status: statusCode,
        headers: {
          get: (name) => resHeaders[name.toLowerCase()] ?? null,
          all: resHeaders
        },
        arrayBuffer: async () => rawBuffer,
        text: async () => rawBuffer.toString('utf-8'),
        json: async () => JSON.parse(rawBuffer.toString('utf-8'))
      });
    });
    resStream.on('error', reject);

    server.emit('request', reqStream, resStream);

    if (body === null || body === undefined) {
      reqStream.end();
    } else if (Buffer.isBuffer(body)) {
      reqStream.end(body);
    } else if (typeof body === 'string') {
      reqStream.end(Buffer.from(body, 'utf-8'));
    } else {
      reqStream.end(Buffer.from(JSON.stringify(body), 'utf-8'));
    }
  });
}

test('1. Zero-Login Instant 5GB Card Provisioning', async () => {
  const res = await dispatch('/api/session');
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data.user.cardSerial.startsWith('NG-SD-'));
  assert.equal(data.user.planId, 'free');
  assert.equal(data.user.quotaBytes, 5 * 1024 * 1024 * 1024);
  assert.ok(data.user.sessionToken);
});

test('2. SHA-256 Streaming Upload, Instant Zero-Data Deduplication & HTTP 206 Byte-Range Streaming', async () => {
  const sRes = await dispatch('/api/session');
  const sData = await sRes.json();
  const token = sData.user.sessionToken;

  const sampleBuffer = Buffer.from(
    `CardNG Sample Nollywood 4K Movie Stream Payload ${Date.now()} `.repeat(200),
    'utf-8'
  );
  const sha256 = crypto.createHash('sha256').update(sampleBuffer).digest('hex');

  // Upload file first time
  const upRes = await dispatch('/api/files/upload', {
    method: 'POST',
    headers: {
      'x-card-token': token,
      'x-file-name': 'Lagos_Movie_4K.mp4',
      'x-file-type': 'video/mp4',
      'x-file-folder': 'Movies & Media',
      'x-file-sha256': sha256
    },
    body: sampleBuffer
  });
  assert.equal(upRes.status, 201);
  const upData = await upRes.json();
  assert.equal(upData.file.sha256, sha256);
  assert.equal(upData.file.sizeBytes, sampleBuffer.length);
  assert.equal(upData.file.safeToDeleteVerified, true);

  // Test HTTP 206 Partial Content Byte-Range Stream (first 50 bytes)
  const streamRes = await dispatch(upData.file.streamUrl, {
    headers: {
      Range: 'bytes=0-49'
    }
  });
  assert.equal(streamRes.status, 206);
  assert.equal(
    streamRes.headers.get('content-range'),
    `bytes 0-49/${sampleBuffer.length}`
  );
  const chunk = await streamRes.arrayBuffer();
  assert.equal(chunk.length, 50);
  assert.equal(chunk.toString('utf-8'), sampleBuffer.subarray(0, 50).toString('utf-8'));

  // Test SHA-256 Preflight Deduplication (Second upload of same file = 0 bytes uploaded!)
  const preRes = await dispatch('/api/files/preflight', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-card-token': token
    },
    body: {
      sha256,
      sizeBytes: sampleBuffer.length,
      name: 'Duplicate_Lagos_Movie_4K.mp4',
      mimeType: 'video/mp4',
      folder: 'Movies & Media'
    }
  });
  assert.equal(preRes.status, 200);
  const preData = await preRes.json();
  assert.equal(preData.instantMatch, true);
  assert.equal(preData.deduplicated, true);
  assert.equal(preData.user.savedDataBytes, sampleBuffer.length);
});

test('3. Lock Card to Nigerian Phone + 4-Digit PIN & Cross-Device Restore', async () => {
  const sRes = await dispatch('/api/session');
  const sData = await sRes.json();
  const token = sData.user.sessionToken;
  const randomPhone = `0803${Math.floor(1000000 + Math.random() * 8999999)}`;

  const lockRes = await dispatch('/api/auth/lock', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-card-token': token
    },
    body: {
      displayName: 'Chinedu Dev',
      phone: randomPhone,
      pin: '4321'
    }
  });
  assert.equal(lockRes.status, 200);
  const lockData = await lockRes.json();
  assert.equal(lockData.user.isLockedToPhone, true);

  // Restore from another device
  const restoreRes = await dispatch('/api/auth/restore', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: {
      phone: randomPhone,
      pin: '4321'
    }
  });
  assert.equal(restoreRes.status, 200);
  const restoreData = await restoreRes.json();
  assert.equal(restoreData.user.cardSerial, sData.user.cardSerial);
});

test('4. OPay Sachet Transfer Claim & 1-Tap Telegram Approval Unlocks 50GB + Official Receipt', async () => {
  const sRes = await dispatch('/api/session');
  const sData = await sRes.json();
  const token = sData.user.sessionToken;

  const claimRes = await dispatch('/api/payments/claim', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-card-token': token
    },
    body: {
      planId: 'standard',
      channel: 'OPay',
      senderName: 'Adebayo Student'
    }
  });
  assert.equal(claimRes.status, 201);
  const claimData = await claimRes.json();
  assert.equal(claimData.payment.amountNaira, 500);
  assert.equal(claimData.payment.status, 'PENDING');

  // 1-Tap Approve
  const approveRes = await dispatch(`/api/payments/${claimData.payment.id}/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: { action: 'APPROVE' }
  });
  assert.equal(approveRes.status, 200);
  const approveData = await approveRes.json();
  assert.equal(approveData.payment.status, 'APPROVED');
  assert.ok(approveData.payment.receiptNumber.startsWith('NG-RCPT-'));
  assert.equal(approveData.user.planId, 'standard');
  assert.equal(approveData.user.quotaBytes, 50 * 1024 * 1024 * 1024);
});

test('5. WebDAV Virtual Disk Bridge (PROPFIND & PUT for Mac Finder / Windows Explorer)', async () => {
  const sRes = await dispatch('/api/session');
  const sData = await sRes.json();
  const token = sData.user.sessionToken;

  // Upload a file via WebDAV PUT (simulating dragging a file into Mac Finder!)
  const finderPayload = Buffer.from('print("Hello from mounted Mac Finder drive!")\n', 'utf-8');
  const putRes = await dispatch(`/webdav/${token}/finder_script.py`, {
    method: 'PUT',
    body: finderPayload
  });
  assert.equal(putRes.status, 201);

  const davRes = await dispatch(`/webdav/${token}/`, {
    method: 'PROPFIND',
    headers: { Depth: '1' }
  });
  assert.equal(davRes.status, 207);
  const xml = await davRes.text();
  assert.ok(xml.includes('<D:multistatus'));
  assert.ok(xml.includes('finder_script.py'));
});
