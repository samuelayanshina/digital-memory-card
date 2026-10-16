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

test('6. Cloud Code Studio: Create, Edit, Save & Run Code Directly on Memory Card', async () => {
  const sRes = await dispatch('/api/session');
  const sData = await sRes.json();
  const token = sData.user.sessionToken;

  // Create new cloud script
  const createRes = await dispatch('/api/files/create-text', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-card-token': token
    },
    body: {
      name: 'cloud_calc.js',
      folder: 'Dev & Code',
      content: 'const a = 20; const b = 30; console.log("Sum:", a + b); a + b;'
    }
  });
  assert.equal(createRes.status, 201);
  const createData = await createRes.json();
  assert.equal(createData.file.name, 'cloud_calc.js');

  // Execute in Cloud Sandbox
  const runRes = await dispatch('/api/workspace/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: {
      code: 'const a = 20; const b = 30; console.log("Sum:", a + b); a + b;',
      filename: 'cloud_calc.js'
    }
  });
  assert.equal(runRes.status, 200);
  const runData = await runRes.json();
  assert.equal(runData.ok, true);
  assert.ok(runData.output.includes('Sum: 50'));
  assert.ok(runData.output.includes('50'));

  // Edit & save updated content directly on card
  const editRes = await dispatch(`/api/files/${createData.file.id}/content`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'x-card-token': token
    },
    body: {
      content: 'console.log("Updated on Cloud Card!");'
    }
  });
  assert.equal(editRes.status, 200);
});

test('7. Zero-Data Share Codes (CARD-XXXX) & 256GB MacBook Storage Doctor', async () => {
  const userARes = await dispatch('/api/session');
  const userAData = await userARes.json();
  const tokenA = userAData.user.sessionToken;

  // User A creates a file and shares it
  const createRes = await dispatch('/api/files/create-text', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-card-token': tokenA
    },
    body: {
      name: 'shared_course_notes.md',
      folder: 'Documents',
      content: `# Shared Course Notes ${Date.now()}`
    }
  });
  const fileA = (await createRes.json()).file;

  const shareRes = await dispatch(`/api/files/${fileA.id}/share`, {
    method: 'POST',
    headers: { 'x-card-token': tokenA }
  });
  assert.equal(shareRes.status, 200);
  const shareData = await shareRes.json();
  assert.ok(shareData.share.shareCode.startsWith('CARD-'));

  // User B claims the share code using 0 MB internet data
  const userBRes = await dispatch('/api/session');
  const tokenB = (await userBRes.json()).user.sessionToken;

  const claimRes = await dispatch('/api/files/claim-share', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-card-token': tokenB
    },
    body: {
      shareCode: shareData.share.shareCode
    }
  });
  assert.equal(claimRes.status, 201);
  const claimData = await claimRes.json();
  assert.equal(claimData.file.name, 'shared_course_notes.md');
  assert.equal(claimData.file.deduplicated, true);

  // Mac Storage Doctor Scan
  const docRes = await dispatch('/api/mac-doctor/scan');
  assert.equal(docRes.status, 200);
  const docData = await docRes.json();
  assert.ok(Array.isArray(docData.hotspots));
  assert.equal(docData.hotspots.length, 4);
});

