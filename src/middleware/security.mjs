import { db } from '../db/database.mjs';

const rateBuckets = new Map();
const activeUserStreams = new Map();

// Clean up expired buckets every 5 minutes
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

export function acquireStreamSlot(userId, maxConcurrent = 3) {
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

export function setSessionCookie(res, sessionToken) {
  const maxAge = 365 * 24 * 60 * 60; // 1 year
  res.setHeader(
    'Set-Cookie',
    `cardng_token=${encodeURIComponent(sessionToken)}; Path=/; Max-Age=${maxAge}; SameSite=Lax`
  );
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
