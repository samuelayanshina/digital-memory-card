import crypto from 'node:crypto';
import { db } from '../db/database.mjs';
import { APP_CONFIG } from '../config/plans.mjs';

const rateBuckets = new Map();
const activeUserStreams = new Map();

// Clean up expired rate limit buckets every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets.entries()) {
    if (now > bucket.resetAt) {
      rateBuckets.delete(key);
    }
  }
}, 5 * 60 * 1000).unref();

export function checkRateLimit(key, maxRequests, windowMs) {
  const now = Date.now();
  let bucket = rateBuckets.get(key);
  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + windowMs };
    rateBuckets.set(key, bucket);
  }
  bucket.count += 1;
  return {
    allowed: bucket.count <= maxRequests,
    remaining: Math.max(0, maxRequests - bucket.count),
    retryAfterSec: Math.ceil((bucket.resetAt - now) / 1000)
  };
}

export function acquireStreamSlot(userId, maxConcurrent = 4) {
  const current = activeUserStreams.get(userId) || 0;
  if (current >= maxConcurrent) {
    return false;
  }
  activeUserStreams.set(userId, current + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = activeUserStreams.get(userId) || 1;
    if (count <= 1) activeUserStreams.delete(userId);
    else activeUserStreams.set(userId, count - 1);
  };
}

export function applySecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=()'
  );
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: blob:; media-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'self';"
  );
}

export function parseCookies(cookieHeader = '') {
  const cookies = {};
  if (!cookieHeader) return cookies;
  for (const part of cookieHeader.split(';')) {
    const [rawName, ...rest] = part.trim().split('=');
    if (rawName) {
      cookies[rawName] = decodeURIComponent(rest.join('='));
    }
  }
  return cookies;
}

export function setSessionCookie(res, sessionToken, extraCookie = null) {
  const maxAge = 365 * 24 * 60 * 60; // 1 year
  const primary = `cardng_token=${encodeURIComponent(
    sessionToken
  )}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax`;
  if (extraCookie) {
    res.setHeader('Set-Cookie', [primary, extraCookie]);
  } else {
    res.setHeader('Set-Cookie', primary);
  }
}

export function createVaultUnlockToken(userId, ttlSeconds = 1800) {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = `vault:${userId}:${exp}`;
  const sig = crypto
    .createHmac('sha256', APP_CONFIG.appSecret)
    .update(payload)
    .digest('hex');
  return `${exp}.${sig}`;
}

export function setVaultUnlockCookie(res, userId) {
  const token = createVaultUnlockToken(userId, 1800);
  res.setHeader(
    'Set-Cookie',
    `cardng_vault=${encodeURIComponent(token)}; Path=/; Max-Age=1800; HttpOnly; SameSite=Lax`
  );
  return token;
}

export function isVaultUnlockedForRequest(req, userId) {
  const cookies = parseCookies(req.headers.cookie);
  const rawToken = req.headers['x-vault-token'] || cookies.cardng_vault;
  if (!rawToken || typeof rawToken !== 'string') return false;
  const [expStr, sig] = rawToken.split('.');
  const exp = Number(expStr);
  if (!exp || !sig || exp < Math.floor(Date.now() / 1000)) return false;

  const expectedSig = crypto
    .createHmac('sha256', APP_CONFIG.appSecret)
    .update(`vault:${userId}:${exp}`)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(expectedSig, 'hex'),
      Buffer.from(sig, 'hex')
    );
  } catch {
    return false;
  }
}

export function getOrProvisionUser(req, res, autoCreate = true) {
  const cookies = parseCookies(req.headers.cookie);
  const headerToken = req.headers['x-card-token'];
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const queryToken = urlObj.searchParams.get('token');

  const token = headerToken || cookies.cardng_token || queryToken;
  let user = token ? db.getUserByToken(token) : null;

  if (!user && autoCreate) {
    user = db.createAnonymousUser();
    setSessionCookie(res, user.sessionToken);
  }
  return user;
}
