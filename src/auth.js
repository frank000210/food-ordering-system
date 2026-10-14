'use strict';
const crypto = require('node:crypto');

const COOKIE_NAME = 'admin_session';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    try { out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim()); } catch { /* skip */ }
  }
  return out;
}

/** Constant-time string comparison (hash first so lengths always match). */
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * Admin credentials come from the environment (ADMIN / ADMIN_PASSWORD), never from the database.
 * Without ADMIN_PASSWORD the back office stays locked.
 */
function createAuth(db, { credentials } = {}) {
  const sessions = db.collection('sessions');
  const creds = credentials || {
    username: process.env.ADMIN || 'admin',
    password: process.env.ADMIN_PASSWORD || '',
  };
  if (!creds.password) console.warn('[auth] 未設定 ADMIN_PASSWORD，後台將無法登入');

  // Simple in-memory login throttle: max 5 failures per 15 minutes per IP.
  const failures = new Map();
  const WINDOW_MS = 15 * 60 * 1000;
  const MAX_FAILS = 5;

  function isThrottled(ip) {
    const rec = failures.get(ip);
    if (!rec) return false;
    if (Date.now() - rec.first > WINDOW_MS) { failures.delete(ip); return false; }
    return rec.count >= MAX_FAILS;
  }
  function recordFailure(ip) {
    const rec = failures.get(ip);
    if (!rec || Date.now() - rec.first > WINDOW_MS) failures.set(ip, { first: Date.now(), count: 1 });
    else rec.count += 1;
  }

  const isConfigured = () => Boolean(creds.password);

  function checkCredentials(username, password) {
    if (!isConfigured()) return false;
    // Evaluate both comparisons to avoid leaking which one failed via timing.
    const userOk = safeEqual(username || '', creds.username);
    const passOk = safeEqual(password || '', creds.password);
    return userOk && passOk;
  }

  async function startSession(res, username, secure) {
    const token = crypto.randomBytes(32).toString('hex');
    await sessions.insertOne({ _id: token, username, expires_at: new Date(Date.now() + SESSION_TTL_MS) });
    const flags = [`${COOKIE_NAME}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax',
      `Max-Age=${SESSION_TTL_MS / 1000}`];
    if (secure) flags.push('Secure');
    res.setHeader('Set-Cookie', flags.join('; '));
  }

  async function endSession(req, res) {
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (token) await sessions.deleteOne({ _id: token });
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  }

  async function currentAdmin(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (!token) return null;
    const row = await sessions.findOne({ _id: token });
    if (!row) return null;
    // TTL cleanup runs about once a minute, so double-check expiry; also drop sessions
    // issued for a username that is no longer the configured admin.
    if (row.expires_at < new Date() || row.username !== creds.username) {
      await sessions.deleteOne({ _id: token });
      return null;
    }
    return { username: row.username };
  }

  async function requireAdmin(req, res, next) {
    const admin = await currentAdmin(req);
    if (!admin) return res.status(401).json({ error: '請先登入後台' });
    req.admin = admin;
    next();
  }

  return { startSession, endSession, currentAdmin, requireAdmin, isThrottled, recordFailure,
    checkCredentials, isConfigured, clearFailures: (ip) => failures.delete(ip) };
}

module.exports = { createAuth, parseCookies };
