import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { Readable, PassThrough } from 'node:stream';
import { createAppServer } from '../src/server.mjs';
import { getBlobPath, getColdBlobPath } from '../src/services/storageEngine.mjs';

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

test('8. Production Healthcheck & Strict Zero-Trust Security Headers', async () => {
  const res = await dispatch('/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(res.headers.get('content-security-policy')?.includes("script-src 'self'"));

  const data = await res.json();
  assert.equal(data.status, 'healthy');
  assert.equal(data.service, 'CardNG Digital Memory Card Engine');
  assert.ok(typeof data.memoryRssMB === 'number');
});

test('9. Server-Enforced Private Vault: Blocks Stream & Share Until Signed PIN Token Issued', async () => {
  const sRes = await dispatch('/api/session');
  const sData = await sRes.json();
  const token = sData.user.sessionToken;

  // Upload a confidential file directly into Private Vault
  const secretBuf = Buffer.from('CONFIDENTIAL_BVN_AND_PASSPORT_SCAN_2026', 'utf-8');
  const sha256 = crypto.createHash('sha256').update(secretBuf).digest('hex');

  const upRes = await dispatch('/api/files/upload', {
    method: 'POST',
    headers: {
      'x-card-token': token,
      'x-file-name': 'Passport_Vault_Copy.pdf',
      'x-file-type': 'application/pdf',
      'x-file-folder': 'Private Vault',
      'x-file-sha256': sha256,
      'x-file-vault': 'true'
    },
    body: secretBuf
  });
  assert.equal(upRes.status, 201);
  const vaultFile = (await upRes.json()).file;
  assert.equal(vaultFile.isVaultLocked, true);

  // Attempt to stream WITHOUT unlocking Vault -> Must be blocked (403 Forbidden)
  const blockedStream = await dispatch(vaultFile.streamUrl, {
    headers: { 'x-card-token': token }
  });
  assert.equal(blockedStream.status, 403);
  const blockedData = await blockedStream.json();
  assert.ok(blockedData.error.includes('VAULT_LOCKED'));

  // Attempt to share WITHOUT unlocking Vault -> Must be blocked (403 Forbidden)
  const blockedShare = await dispatch(`/api/files/${vaultFile.id}/share`, {
    method: 'POST',
    headers: { 'x-card-token': token }
  });
  assert.equal(blockedShare.status, 403);

  // Verify wrong PIN -> 403 + Audit Log entry
  const badPinRes = await dispatch('/api/auth/verify-pin', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-card-token': token
    },
    body: { pin: '9999' }
  });
  assert.equal(badPinRes.status, 403);

  // Verify correct starter PIN (0000) -> Issues cryptographic vaultToken
  const goodPinRes = await dispatch('/api/auth/verify-pin', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-card-token': token
    },
    body: { pin: '0000' }
  });
  assert.equal(goodPinRes.status, 200);
  const goodPinData = await goodPinRes.json();
  assert.equal(goodPinData.unlocked, true);
  assert.ok(goodPinData.vaultToken);

  // Stream WITH cryptographic vaultToken -> 200 OK
  const unlockedStream = await dispatch(vaultFile.streamUrl, {
    headers: {
      'x-card-token': token,
      'x-vault-token': goodPinData.vaultToken
    }
  });
  assert.equal(unlockedStream.status, 200);
  const streamedContent = await unlockedStream.text();
  assert.equal(streamedContent, 'CONFIDENTIAL_BVN_AND_PASSPORT_SCAN_2026');
});

test('10. File Rename/Move, Safety Trash Bin, Restore & Empty Trash Lifecycle', async () => {
  const sRes = await dispatch('/api/session');
  const token = (await sRes.json()).user.sessionToken;

  const createRes = await dispatch('/api/files/create-text', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-card-token': token
    },
    body: {
      name: 'draft_notes.txt',
      folder: 'Documents',
      content: 'Important client project notes'
    }
  });
  const file = (await createRes.json()).file;

  // 1. Rename & Move file
  const renameRes = await dispatch(`/api/files/${file.id}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'x-card-token': token
    },
    body: {
      name: 'final_architecture.md',
      folder: 'Dev & Code'
    }
  });
  assert.equal(renameRes.status, 200);
  const renamedFile = (await renameRes.json()).file;
  assert.equal(renamedFile.name, 'final_architecture.md');
  assert.equal(renamedFile.folder, 'Dev & Code');

  // 2. Soft-Trash file
  const trashRes = await dispatch(`/api/files/${file.id}/trash`, {
    method: 'POST',
    headers: { 'x-card-token': token }
  });
  assert.equal(trashRes.status, 200);
  const trashedData = await trashRes.json();
  assert.equal(trashedData.file.isTrashed, true);
  assert.ok(trashedData.breakdown.trashBytes > 0);

  // 3. Restore file from Trash
  const restoreRes = await dispatch(`/api/files/${file.id}/restore`, {
    method: 'POST',
    headers: { 'x-card-token': token }
  });
  assert.equal(restoreRes.status, 200);
  const restoredData = await restoreRes.json();
  assert.equal(restoredData.file.isTrashed, false);
  assert.equal(restoredData.breakdown.trashBytes, 0);

  // 4. Move to Trash again and Empty Trash permanently
  await dispatch(`/api/files/${file.id}/trash`, {
    method: 'POST',
    headers: { 'x-card-token': token }
  });
  const emptyRes = await dispatch('/api/files/trash/empty', {
    method: 'DELETE',
    headers: { 'x-card-token': token }
  });
  assert.equal(emptyRes.status, 200);
  const emptyData = await emptyRes.json();
  assert.equal(emptyData.deletedCount, 1);
  assert.equal(emptyData.breakdown.trashBytes, 0);
});

test('11. Tamper-Evident Security Audit Ledger & Multi-Segment Storage Breakdown', async () => {
  const sRes = await dispatch('/api/session');
  const token = (await sRes.json()).user.sessionToken;

  // Trigger a PIN verification to generate an audit event
  await dispatch('/api/auth/verify-pin', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-card-token': token
    },
    body: { pin: '0000' }
  });

  const auditRes = await dispatch('/api/security/audit', {
    headers: { 'x-card-token': token }
  });
  assert.equal(auditRes.status, 200);
  const auditData = await auditRes.json();
  assert.ok(Array.isArray(auditData.auditLogs));
  assert.ok(auditData.auditLogs.length >= 1);
  assert.equal(auditData.auditLogs[0].action, 'VAULT_UNLOCKED');
  assert.ok(typeof auditData.breakdown.mediaBytes === 'number');
});

test('12. On-Device GZIP Data-Saver Upload (80%+ Mobile Data Saved) & SSRF-Safe Cloud Fetch', async () => {
  const sRes = await dispatch('/api/session');
  const token = (await sRes.json()).user.sessionToken;

  // 1. Original 50KB dataset buffer compressed with GZIP on client before upload
  const originalBuffer = Buffer.from(
    `NIGERIA_STUDENT_DATASET_ROW_${Date.now()},LAGOS,IBADAN,ABUJA,PORT_HARCOURT\n`.repeat(800),
    'utf-8'
  );
  const expectedSha256 = crypto.createHash('sha256').update(originalBuffer).digest('hex');
  const compressedPayload = zlib.gzipSync(originalBuffer);

  // Compressed payload is < 5% of original size!
  assert.ok(compressedPayload.length < originalBuffer.length * 0.1);

  const upRes = await dispatch('/api/files/upload', {
    method: 'POST',
    headers: {
      'x-card-token': token,
      'x-file-name': 'student_records_2026.csv',
      'x-file-type': 'text/csv',
      'x-file-folder': 'Documents',
      'x-file-sha256': expectedSha256,
      'x-upload-encoding': 'gzip'
    },
    body: compressedPayload
  });
  assert.equal(upRes.status, 201);
  const upData = await upRes.json();
  assert.equal(upData.file.sizeBytes, originalBuffer.length);
  assert.equal(upData.file.sha256, expectedSha256);
  assert.ok(upData.compressionSavedBytes > originalBuffer.length * 0.9);
  assert.equal(upData.user.savedDataBytes, upData.compressionSavedBytes);

  // 2. Verify SSRF protection blocks internal/private IP fetch attempts on /api/files/remote-fetch
  const ssrfRes = await dispatch('/api/files/remote-fetch', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-card-token': token
    },
    body: {
      url: 'http://127.0.0.1:4000/api/session',
      folder: 'Documents'
    }
  });
  assert.equal(ssrfRes.status, 400);
});

test('13. Cryptographic PIN Recovery Key Reset (₦0 SMS) & Real Telegram 1-Tap Webhook Callback', async () => {
  const sRes = await dispatch('/api/session');
  const token = (await sRes.json()).user.sessionToken;
  const randomPhone = `081${Math.floor(10000000 + Math.random() * 89999999)}`;

  // 1. Lock Card and receive Emergency Recovery Key (NG-REC-XXXX-XXXX)
  const lockRes = await dispatch('/api/auth/lock', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-card-token': token
    },
    body: {
      displayName: 'Ngozi Founder',
      phone: randomPhone,
      pin: '1357'
    }
  });
  assert.equal(lockRes.status, 200);
  const lockData = await lockRes.json();
  assert.ok(lockData.recoveryKey?.startsWith('NG-REC-'));

  // 2. Reset forgotten PIN using Emergency Recovery Key -> rotates recoveryKey
  const resetRes = await dispatch('/api/auth/reset-pin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: {
      phone: randomPhone,
      recoveryKey: lockData.recoveryKey,
      newPin: '8642'
    }
  });
  assert.equal(resetRes.status, 200);
  const resetData = await resetRes.json();
  assert.ok(resetData.recoveryKey?.startsWith('NG-REC-'));
  assert.notEqual(resetData.recoveryKey, lockData.recoveryKey);

  // 3. Reusing the old recovery key must fail (one-time rotation)
  const replayRes = await dispatch('/api/auth/reset-pin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: {
      phone: randomPhone,
      recoveryKey: lockData.recoveryKey,
      newPin: '1111'
    }
  });
  assert.equal(replayRes.status, 401);

  // 4. Submit an OPay transfer claim and approve via real Telegram Bot callback_query webhook
  const claimRes = await dispatch('/api/payments/claim', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-card-token': token
    },
    body: {
      planId: 'pro',
      channel: 'PalmPay',
      senderName: 'Ngozi Founder'
    }
  });
  assert.equal(claimRes.status, 201);
  const claimId = (await claimRes.json()).payment.id;

  const tgWebhookRes = await dispatch('/api/telegram/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: {
      callback_query: {
        id: 'cbq_test_991',
        data: `approve:${claimId}`
      }
    }
  });
  assert.equal(tgWebhookRes.status, 200);
  const tgData = await tgWebhookRes.json();
  assert.equal(tgData.payment.status, 'APPROVED');
  assert.equal(tgData.user.planId, 'pro');
  assert.equal(tgData.user.quotaStatus.daysRemaining, 30);
  assert.equal(tgData.user.quotaStatus.isReadOnlyGraceMode, false);
});

test('14. Resumable Chunked Upload Engine (Unstable 3G/4G Recovery) & Viral Share Link (/s/CARD-XXXX)', async () => {
  const sRes = await dispatch('/api/session');
  const token = (await sRes.json()).user.sessionToken;

  const chunk1 = Buffer.from('PART_ONE_OF_LECTURE_VIDEO_OVER_UNSTABLE_MTN_3G_', 'utf-8');
  const chunk2 = Buffer.from('PART_TWO_RESUMED_AFTER_NETWORK_DROP_WITHOUT_LOSING_PROGRESS', 'utf-8');
  const fullBuffer = Buffer.concat([chunk1, chunk2]);
  const expectedSha256 = crypto.createHash('sha256').update(fullBuffer).digest('hex');

  // 1. Start resumable upload session
  const initRes = await dispatch('/api/files/upload-session', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-card-token': token
    },
    body: {
      name: 'UNILAG_Engineering_Lecture.mp4',
      folder: 'Movies & Media',
      mimeType: 'video/mp4',
      totalSizeBytes: fullBuffer.length,
      expectedSha256
    }
  });
  assert.equal(initRes.status, 201);
  const { session } = await initRes.json();
  assert.ok(session.uploadId.startsWith('upl_'));

  // 2. Upload Chunk 1 (offset 0)
  const patch1 = await dispatch(`/api/files/upload-session/${session.uploadId}`, {
    method: 'PATCH',
    headers: {
      'x-card-token': token,
      'x-upload-offset': '0'
    },
    body: chunk1
  });
  assert.equal(patch1.status, 200);
  const patch1Data = await patch1.json();
  assert.equal(patch1Data.completed, false);
  assert.equal(patch1Data.offsetBytes, chunk1.length);

  // 3. Query session status after simulated 3G drop to find resume offset
  const statusRes = await dispatch(`/api/files/upload-session/${session.uploadId}`, {
    headers: { 'x-card-token': token }
  });
  assert.equal(statusRes.status, 200);
  const statusData = await statusRes.json();
  assert.equal(statusData.session.offsetBytes, chunk1.length);

  // 4. Resume from exact byte offset with Chunk 2 -> Finalizes & mounts file!
  const patch2 = await dispatch(`/api/files/upload-session/${session.uploadId}`, {
    method: 'PATCH',
    headers: {
      'x-card-token': token,
      'x-upload-offset': String(chunk1.length)
    },
    body: chunk2
  });
  assert.equal(patch2.status, 200);
  const patch2Data = await patch2.json();
  assert.equal(patch2Data.completed, true);
  assert.equal(patch2Data.file.sha256, expectedSha256);
  assert.equal(patch2Data.file.sizeBytes, fullBuffer.length);

  // 5. Verify 1-Click Viral Share Link (/s/CARD-XXXX) redirects to /?claim=CARD-XXXX
  const redirRes = await dispatch('/s/card-a1b2');
  assert.equal(redirRes.status, 302);
  assert.equal(redirRes.headers.get('location'), '/?claim=CARD-A1B2');
});

test('15. Anti-Hash-Spoofing Proof-of-Ownership & Private Vault Deduplication Isolation', async () => {
  const userARes = await dispatch('/api/session');
  const tokenA = (await userARes.json()).user.sessionToken;

  const userBRes = await dispatch('/api/session');
  const tokenB = (await userBRes.json()).user.sessionToken;

  // 1. User A uploads a strictly private file into Private Vault
  const vaultSecretBuf = Buffer.from(
    `PRIVATE_VAULT_ONLY_DOCUMENT_${Date.now()}_${crypto.randomBytes(16).toString('hex')}`,
    'utf-8'
  );
  const vaultSha = crypto.createHash('sha256').update(vaultSecretBuf).digest('hex');

  const upVault = await dispatch('/api/files/upload', {
    method: 'POST',
    headers: {
      'x-card-token': tokenA,
      'x-file-name': 'Secret_Contract.pdf',
      'x-file-type': 'application/pdf',
      'x-file-folder': 'Private Vault',
      'x-file-sha256': vaultSha,
      'x-file-vault': 'true'
    },
    body: vaultSecretBuf
  });
  assert.equal(upVault.status, 201);

  // 2. User B tries a "Confirmation-of-a-File" attack on User A's Private Vault hash -> Must NOT instantMatch!
  const spoofVaultPre = await dispatch('/api/files/preflight', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-card-token': tokenB
    },
    body: {
      sha256: vaultSha,
      sizeBytes: vaultSecretBuf.length,
      name: 'Stolen_Contract.pdf',
      folder: 'Documents'
    }
  });
  assert.equal(spoofVaultPre.status, 200);
  const spoofVaultData = await spoofVaultPre.json();
  assert.equal(spoofVaultData.instantMatch, false);

  // 3. User A uploads a public file; User B sends a forged sliceProof -> Blocked (403)
  const publicBuf = Buffer.from(
    `PUBLIC_CAMPUS_HANDOUT_${Date.now()}_ABCDEFGHIJKLMNOPQRSTUVWXYZ_0123456789`,
    'utf-8'
  );
  const publicSha = crypto.createHash('sha256').update(publicBuf).digest('hex');
  await dispatch('/api/files/upload', {
    method: 'POST',
    headers: {
      'x-card-token': tokenA,
      'x-file-name': 'Handout.pdf',
      'x-file-type': 'application/pdf',
      'x-file-folder': 'Documents',
      'x-file-sha256': publicSha
    },
    body: publicBuf
  });

  const forgedProofRes = await dispatch('/api/files/preflight', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-card-token': tokenB
    },
    body: {
      sha256: publicSha,
      sizeBytes: publicBuf.length,
      name: 'Handout.pdf',
      folder: 'Documents',
      sliceProof: {
        offset: 0,
        length: 64,
        hash: '0000000000000000000000000000000000000000000000000000000000000000'
      }
    }
  });
  assert.equal(forgedProofRes.status, 403);

  // 4. User B sends valid cryptographic sliceProof -> Instant Zero-Data Match succeeds (200)
  const validSliceHash = crypto
    .createHash('sha256')
    .update(publicBuf.subarray(0, 64))
    .digest('hex');
  const validProofRes = await dispatch('/api/files/preflight', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-card-token': tokenB
    },
    body: {
      sha256: publicSha,
      sizeBytes: publicBuf.length,
      name: 'Handout.pdf',
      folder: 'Documents',
      sliceProof: {
        offset: 0,
        length: 64,
        hash: validSliceHash
      }
    }
  });
  assert.equal(validProofRes.status, 200);
  const validProofData = await validProofRes.json();
  assert.equal(validProofData.instantMatch, true);
});

test('16. AES-256-CTR Encryption at Rest (HTTP 206 Range Seek), Two-Tier Hot/Cold Archival & Scannable QR SVG', async () => {
  const sRes = await dispatch('/api/session');
  const token = (await sRes.json()).user.sessionToken;

  // 1. Upload a sensitive file directly into Private Vault
  const plaintextStr =
    'TOP_SECRET_BANK_LEDGER_2026_AES_256_CTR_ENCRYPTED_AT_REST_ON_DISK_WITH_RANGE_SEEK_SUPPORT!';
  const plaintextBuf = Buffer.from(plaintextStr, 'utf-8');
  const sha = crypto.createHash('sha256').update(plaintextBuf).digest('hex');

  const upRes = await dispatch('/api/files/upload', {
    method: 'POST',
    headers: {
      'x-card-token': token,
      'x-file-name': 'Encrypted_Vault_Ledger.txt',
      'x-file-type': 'text/plain',
      'x-file-folder': 'Private Vault',
      'x-file-sha256': sha,
      'x-file-vault': 'true'
    },
    body: plaintextBuf
  });
  assert.equal(upRes.status, 201);
  const upData = await upRes.json();
  assert.equal(upData.encryptedAtRest, true);

  // 2. Inspect physical .blob file on hard drive: must start with CNGENC01 magic header and NOT contain plaintext!
  const physicalPath = getBlobPath(sha);
  const rawDiskBytes = fs.readFileSync(physicalPath);
  assert.equal(rawDiskBytes.subarray(0, 8).toString('utf-8'), 'CNGENC01');
  assert.equal(rawDiskBytes.includes(Buffer.from('TOP_SECRET_BANK_LEDGER', 'utf-8')), false);

  // 3. Unlock Private Vault with default starter PIN (0000) and stream an unaligned HTTP 206 byte range (bytes=11-34)
  const unlockRes = await dispatch('/api/auth/verify-pin', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-card-token': token
    },
    body: { pin: '0000' }
  });
  assert.equal(unlockRes.status, 200);
  const { vaultToken } = await unlockRes.json();

  const rangeRes = await dispatch(upData.file.streamUrl, {
    headers: {
      'x-card-token': token,
      'x-vault-token': vaultToken,
      range: 'bytes=11-34'
    }
  });
  assert.equal(rangeRes.status, 206);
  const decryptedSlice = await rangeRes.text();
  assert.equal(decryptedSlice, plaintextStr.slice(11, 35));

  // 4. Offload blob from Hot NVMe tier to Cold Archive Storage (POST /api/system/cold-tier/offload)
  const offloadRes = await dispatch('/api/system/cold-tier/offload', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-card-token': token
    },
    body: { fileId: upData.file.id }
  });
  assert.equal(offloadRes.status, 200);
  const offloadData = await offloadRes.json();
  assert.equal(offloadData.offloaded, true);
  assert.equal(offloadData.tier, 'COLD_ARCHIVE_STORAGE');
  assert.equal(fs.existsSync(physicalPath), false);
  assert.equal(fs.existsSync(getColdBlobPath(sha)), true);

  // 5. Streaming the cold-archived file transparently restores it to Hot NVMe tier and decrypts it!
  const fullStreamRes = await dispatch(upData.file.streamUrl, {
    headers: {
      'x-card-token': token,
      'x-vault-token': vaultToken
    }
  });
  assert.equal(fullStreamRes.status, 200);
  assert.equal(await fullStreamRes.text(), plaintextStr);
  assert.equal(fs.existsSync(physicalPath), true);

  // 6. Verify Zero-Dependency Scannable SVG QR Code Generator & Server Disk Health
  const qrRes = await dispatch(
    '/api/system/qr-svg?text=' + encodeURIComponent('http://192.168.3.8:4000')
  );
  assert.equal(qrRes.status, 200);
  assert.ok(qrRes.headers.get('content-type')?.includes('image/svg+xml'));
  const qrSvg = await qrRes.text();
  assert.ok(qrSvg.startsWith('<svg ') && qrSvg.includes('<path d="M'));

  const healthRes = await dispatch('/api/health');
  const healthData = await healthRes.json();
  assert.ok(healthData.diskHealth && typeof healthData.diskHealth.freeBytes === 'number');
});

test('17. Triple Zero-Touch Payment Engine: Instant Session ID Unlock, Auto Credit-Alert Webhook & Paystack Webhook', async () => {
  const sRes = await dispatch('/api/session');
  const token = (await sRes.json()).user.sessionToken;
  const uniqueSession6 = String(Math.floor(100000 + Math.random() * 899999));

  // 1. Engine 1: Student's roommate ("Chinedu Roommate") sends ₦500 on OPay & student enters 6-digit Session ID -> 0-Second Instant Unlock!
  const claimRes = await dispatch('/api/payments/claim', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-card-token': token
    },
    body: {
      planId: 'standard',
      channel: 'OPay',
      senderName: 'Chinedu Roommate',
      sessionIdLast6: uniqueSession6
    }
  });
  assert.equal(claimRes.status, 201);
  const claimData = await claimRes.json();
  assert.equal(claimData.instantUnlocked, true);
  assert.equal(claimData.user.planId, 'standard');
  assert.equal(claimData.user.quotaBytes, 50 * 1024 * 1024 * 1024);

  // 2. Replay Attack Defense: Reusing the exact same 6-digit Session ID must be blocked!
  const replayRes = await dispatch('/api/payments/claim', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-card-token': token
    },
    body: {
      planId: 'pro',
      channel: 'OPay',
      senderName: 'Chinedu Roommate',
      sessionIdLast6: uniqueSession6
    }
  });
  assert.equal(replayRes.status, 400);

  // 3. Engine 2: Direct OPay Credit Alert Auto-Parser Webhook automatically matches & finalizes official receipt!
  const alertWebhookRes = await dispatch('/api/payments/alert-webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: {
      text: `OPay Credit Alert: NGN 500.00 received from CHINEDU ROOMMATE into 8114587431. Session ID: 10000426${uniqueSession6}`
    }
  });
  assert.equal(alertWebhookRes.status, 200);
  const alertData = await alertWebhookRes.json();
  assert.equal(alertData.matched, true);
  assert.equal(alertData.payment.status, 'APPROVED');
  assert.ok(alertData.payment.receiptNumber.startsWith('NG-RCPT-'));

  // 4. Engine 3: Paystack Starter Business Webhook (charge.success) auto-verifies a 20GB Student Sachet claim
  const s2Res = await dispatch('/api/session');
  const token2 = (await s2Res.json()).user.sessionToken;
  const claim2Res = await dispatch('/api/payments/claim', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-card-token': token2
    },
    body: {
      planId: 'student',
      channel: 'Bank Transfer',
      senderName: 'Bolanle POS'
    }
  });
  const claim2 = (await claim2Res.json()).payment;

  const paystackRes = await dispatch('/api/payments/paystack-webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: {
      event: 'charge.success',
      data: {
        reference: claim2.reference,
        amount: 25000, // ₦250.00 in kobo
        metadata: { paymentId: claim2.id, reference: claim2.reference }
      }
    }
  });
  assert.equal(paystackRes.status, 200);
  const psData = await paystackRes.json();
  assert.equal(psData.verified, true);
  assert.equal(psData.payment.status, 'APPROVED');
  assert.equal(psData.user.planId, 'student');
});

test('18. Brand Favicon (/favicon.svg & /favicon.ico) & Founder Admin Operations Command Center (PIN 9934, Device/Login Origins, 1-Click Plan Override)', async () => {
  // 1. Verify Brand Favicon routes
  const favSvg = await dispatch('/favicon.svg');
  assert.equal(favSvg.status, 200);
  assert.ok(favSvg.headers.get('content-type')?.includes('image/svg+xml'));
  const favText = await favSvg.text();
  assert.ok(favText.includes('<svg') && favText.includes('#059669'));

  const favIco = await dispatch('/favicon.ico');
  assert.equal(favIco.status, 200);
  assert.ok(favIco.headers.get('content-type')?.includes('image/svg+xml'));

  // 2. Simulate an iPhone Safari user connecting to CardNG so Device/OS & Browser origin telemetry is recorded
  const iphoneSessionRes = await dispatch('/api/session', {
    headers: {
      'user-agent':
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
      'x-forwarded-for': '102.89.42.19'
    }
  });
  assert.equal(iphoneSessionRes.status, 200);
  const iphoneUser = (await iphoneSessionRes.json()).user;
  assert.equal(iphoneUser.lastDeviceOs, 'iPhone / iOS');
  assert.equal(iphoneUser.lastBrowser, 'Safari');
  assert.equal(iphoneUser.lastIp, '102.89.42.xxx');

  // 3. Unauthenticated request to /api/admin/overview must be blocked (403)
  const unauthAdmin = await dispatch('/api/admin/overview');
  assert.equal(unauthAdmin.status, 403);

  // 4. Authenticated request with Founder Admin PIN (9934) returns full telemetry, device origins, users, payments & global audit stream
  const adminRes = await dispatch('/api/admin/overview', {
    headers: { 'x-admin-pin': '9934' }
  });
  assert.equal(adminRes.status, 200);
  const adminData = await adminRes.json();
  assert.ok(adminData.kpis.totalCards >= 1);
  assert.ok(adminData.deviceOrigins['iPhone / iOS'] >= 1);
  assert.ok(Array.isArray(adminData.users) && adminData.users.length >= 1);
  assert.ok(Array.isArray(adminData.payments));
  assert.ok(Array.isArray(adminData.globalAuditLogs) && adminData.globalAuditLogs.length >= 1);
  assert.ok(adminData.diskHealth && typeof adminData.diskHealth.freeBytes === 'number');

  // 5. Founder Admin 1-Click Manual Plan Upgrade (/api/admin/users/:id/plan)
  const upgradeRes = await dispatch(`/api/admin/users/${iphoneUser.id}/plan`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-admin-pin': '9934'
    },
    body: { planId: 'pro' }
  });
  assert.equal(upgradeRes.status, 200);
  const upgradeData = await upgradeRes.json();
  assert.equal(upgradeData.user.planId, 'pro');
  assert.equal(upgradeData.user.quotaBytes, 150 * 1024 * 1024 * 1024);
});
