// Shared-password gate for the SHERO Dashboard. The dashboard is a read-only,
// all-staff internal view, so a single shared password (one session cookie) is
// proportionate — no per-user accounts. Set DASHBOARD_PASSWORD in the env.
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const SECRET = process.env.SESSION_SECRET || process.env.JWT_SECRET || (() => {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('SESSION_SECRET (or JWT_SECRET) must be set in production');
  }
  console.warn('[auth] SESSION_SECRET not set — using dev-only fallback. Do not deploy without it.');
  return 'dev-secret-do-not-use-in-prod-change-me';
})();

const PASSWORD = process.env.DASHBOARD_PASSWORD || (() => {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('DASHBOARD_PASSWORD must be set in production');
  }
  console.warn('[auth] DASHBOARD_PASSWORD not set — using dev-only fallback "shero".');
  return 'shero';
})();

const COOKIE_NAME = 'shero_dash_session';
const MAX_AGE_MS  = 7 * 24 * 60 * 60 * 1000; // 7 days

// Random per-process key so the dashboard's own server-to-server calls
// (summary.js → /api/<channel>) can bypass the session gate without exposing
// anything externally. Never sent to the browser.
const INTERNAL_KEY = crypto.randomBytes(32).toString('hex');

function checkPassword(input) {
  const a = Buffer.from(String(input || ''));
  const b = Buffer.from(PASSWORD);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function signSession() {
  return jwt.sign({ ok: true }, SECRET, { expiresIn: '7d' });
}

function setAuthCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: MAX_AGE_MS,
    path: '/',
  });
}

function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

function isAuthed(req) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return false;
  try { jwt.verify(token, SECRET); return true; } catch (_) { return false; }
}

function requireAuth(req, res, next) {
  // Allow the dashboard's own internal server-to-server calls.
  if (req.headers['x-internal-key'] === INTERNAL_KEY) return next();
  if (isAuthed(req)) return next();
  return res.status(401).json({ error: 'unauthenticated' });
}

module.exports = {
  COOKIE_NAME, INTERNAL_KEY,
  checkPassword, signSession, setAuthCookie, clearAuthCookie, isAuthed, requireAuth,
};
