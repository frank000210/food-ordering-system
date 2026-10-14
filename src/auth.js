'use strict';
const crypto = require('node:crypto');

const COOKIE_NAME = 'admin_session';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function createAuth(db) {
  const insertSession = db.prepare('INSERT INTO sessions (token, admin_id, expires_at) VALUES (?, ?, ?)');
  const findSession = db.prepare(`SELECT s.token, s.expires_at, a.id, a.username
    FROM sessions s JOIN admins a ON a.id = s.admin_id WHERE s.token = ?`);
  const deleteSession = db.prepare('DELETE FROM sessions WHERE token = ?');
  const purgeExpired = db.prepare('DELETE FROM sessions WHERE expires_at < ?');

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

  function startSession(res, adminId, secure) {
    purgeExpired.run(Date.now());
    const token = crypto.randomBytes(32).toString('hex');
    insertSession.run(token, adminId, Date.now() + SESSION_TTL_MS);
    const flags = [`${COOKIE_NAME}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax',
      `Max-Age=${SESSION_TTL_MS / 1000}`];
    if (secure) flags.push('Secure');
    res.setHeader('Set-Cookie', flags.join('; '));
  }

  function endSession(req, res) {
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (token) deleteSession.run(token);
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  }

  function currentAdmin(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (!token) return null;
    const row = findSession.get(token);
    if (!row) return null;
    if (row.expires_at < Date.now()) { deleteSession.run(token); return null; }
    return { id: row.id, username: row.username };
  }

  function requireAdmin(req, res, next) {
    const admin = currentAdmin(req);
    if (!admin) return res.status(401).json({ error: '請先登入後台' });
    req.admin = admin;
    next();
  }

  return { startSession, endSession, currentAdmin, requireAdmin, isThrottled, recordFailure,
    clearFailures: (ip) => failures.delete(ip) };
}

module.exports = { hashPassword, verifyPassword, createAuth };
