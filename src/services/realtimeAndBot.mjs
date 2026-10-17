import { BroadcastChannel } from 'node:worker_threads';
import { APP_CONFIG } from '../config/plans.mjs';
import { db } from '../db/database.mjs';

// Map of userId -> Set of SSE response objects
const userSseClients = new Map();

// Map of roomCode -> Map of peerId -> { peerId, deviceName, res }
const p2pRooms = new Map();

// Cross-Worker Cluster Bus (allows SSE & P2P events across multi-core Node.js workers)
const clusterChannel = new BroadcastChannel('cardng_cluster_sse');
clusterChannel.unref();

function deliverLocalUserSse(userId, payload) {
  const clients = userSseClients.get(userId);
  if (!clients) return;
  const serialized = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) {
    try {
      res.write(serialized);
    } catch {
      clients.delete(res);
    }
  }
}

function deliverLocalP2P(roomCode, payload, excludePeerId = null) {
  const cleanRoom = String(roomCode).trim().toUpperCase();
  const roomPeers = p2pRooms.get(cleanRoom);
  if (!roomPeers) return;
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const [id, peer] of roomPeers.entries()) {
    if (excludePeerId && id === excludePeerId) continue;
    try {
      peer.res.write(data);
    } catch {
      roomPeers.delete(id);
    }
  }
}

clusterChannel.onmessage = (event) => {
  const msg = event.data;
  if (!msg) return;
  if (msg.channelType === 'USER_SSE') {
    deliverLocalUserSse(msg.userId, msg.payload);
  } else if (msg.channelType === 'P2P_ROOM') {
    deliverLocalP2P(msg.roomCode, msg.payload, msg.excludePeerId);
  }
};

export function subscribeUserEvents(userId, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  res.write(`data: ${JSON.stringify({ type: 'CONNECTED', timestamp: Date.now() })}\n\n`);

  if (!userSseClients.has(userId)) {
    userSseClients.set(userId, new Set());
  }
  userSseClients.get(userId).add(res);

  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch {
      clearInterval(heartbeat);
    }
  }, 20000);

  res.on('close', () => {
    clearInterval(heartbeat);
    const set = userSseClients.get(userId);
    if (set) {
      set.delete(res);
      if (set.size === 0) userSseClients.delete(userId);
    }
  });
}

export function pushToUser(userId, payload) {
  deliverLocalUserSse(userId, payload);
  try {
    clusterChannel.postMessage({ channelType: 'USER_SSE', userId, payload });
  } catch {
    // Ignore broadcast serialization errors
  }
}

// Local Wi-Fi P2P Signaling Room
export function joinP2PRoom(roomCode, peerId, deviceName, res) {
  const cleanRoom = String(roomCode).trim().toUpperCase();
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive'
  });

  if (!p2pRooms.has(cleanRoom)) {
    p2pRooms.set(cleanRoom, new Map());
  }
  const roomPeers = p2pRooms.get(cleanRoom);
  roomPeers.set(peerId, { peerId, deviceName, res });

  const peerList = Array.from(roomPeers.values()).map((p) => ({
    peerId: p.peerId,
    deviceName: p.deviceName
  }));

  broadcastToP2PRoom(cleanRoom, {
    type: 'PEERS_UPDATED',
    roomCode: cleanRoom,
    peers: peerList
  });

  res.on('close', () => {
    const map = p2pRooms.get(cleanRoom);
    if (map) {
      map.delete(peerId);
      if (map.size === 0) {
        p2pRooms.delete(cleanRoom);
      } else {
        broadcastToP2PRoom(cleanRoom, {
          type: 'PEERS_UPDATED',
          roomCode: cleanRoom,
          peers: Array.from(map.values()).map((p) => ({
            peerId: p.peerId,
            deviceName: p.deviceName
          }))
        });
      }
    }
  });
}

export function broadcastToP2PRoom(roomCode, payload, excludePeerId = null) {
  deliverLocalP2P(roomCode, payload, excludePeerId);
  try {
    clusterChannel.postMessage({
      channelType: 'P2P_ROOM',
      roomCode,
      payload,
      excludePeerId
    });
  } catch {
    // Ignore broadcast serialization errors
  }
}

export async function notifyTelegramAdminOfPayment(payment) {
  const sessionTag = payment.sessionIdLast6 ? ` | Session/Ref Tail: #${payment.sessionIdLast6}` : '';
  console.log(
    `\n🔔 [TELEGRAM 1-TAP ALERT] New Transfer Claim: ${payment.reference}` +
      `\n   • Plan: ${payment.planName} (${payment.quotaLabel}) — ₦${payment.amountNaira}` +
      `\n   • Channel: ${payment.channel} | Sender: ${payment.senderName} (${payment.userPhone})${sessionTag}` +
      `\n   • Card Serial: ${payment.cardSerial}\n`
  );

  const { botToken, adminChatId } = APP_CONFIG.telegram;
  if (!botToken || !adminChatId) {
    return { sentToTelegram: false, mode: 'local-simulator' };
  }

  try {
    const text =
      `🔔 *New CardNG Transfer Claim*\n\n` +
      `*Reference:* \`${payment.reference}\`\n` +
      `*Amount:* ₦${payment.amountNaira.toLocaleString()}\n` +
      `*Plan:* ${payment.planName} (${payment.quotaLabel})\n` +
      `*Channel:* ${payment.channel}\n` +
      `*Sender:* ${payment.senderName}\n` +
      (payment.sessionIdLast6 ? `*Receipt Session Tail:* \`${payment.sessionIdLast6}\`\n` : '') +
      `*Phone:* ${payment.userPhone}\n` +
      `*Card:* \`${payment.cardSerial}\``;

    const replyMarkup = {
      inline_keyboard: [
        [
          {
            text: `✅ Approve ₦${payment.amountNaira} (${payment.reference})`,
            callback_data: `APPROVE:${payment.id}`
          },
          {
            text: `❌ Reject`,
            callback_data: `REJECT:${payment.id}`
          }
        ]
      ]
    };

    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: adminChatId,
        text,
        parse_mode: 'Markdown',
        reply_markup: replyMarkup
      })
    });
    return { sentToTelegram: true, mode: 'telegram-live' };
  } catch (err) {
    console.warn('[TelegramBot] Could not reach Telegram API:', err.message);
    return { sentToTelegram: false, mode: 'local-simulator' };
  }
}

export function resolvePaymentAndNotifyUser(paymentId, action = 'APPROVE') {
  const updatedPayment = db.resolvePayment(paymentId, action);
  const user = db.getUserById(updatedPayment.userId);
  if (user) {
    pushToUser(user.id, {
      type: 'PAYMENT_RESOLVED',
      payment: updatedPayment,
      user: sanitizeUserForClient(user)
    });
  }
  return { payment: updatedPayment, user };
}

export function sanitizeUserForClient(user) {
  if (!user) return null;
  const quotaStatus = db.getQuotaStatus(user.id);
  return {
    id: user.id,
    cardSerial: user.cardSerial,
    sessionToken: user.sessionToken,
    phone: user.phone,
    displayName: user.displayName,
    isLockedToPhone: user.isLockedToPhone,
    planId: user.planId,
    planName: user.planName,
    quotaBytes: user.quotaBytes,
    planActivatedAt: user.planActivatedAt || null,
    planExpiresAt: user.planExpiresAt || null,
    quotaStatus,
    usedBytes: user.usedBytes,
    savedDataBytes: user.savedDataBytes || 0,
    createdAt: user.createdAt
  };
}
