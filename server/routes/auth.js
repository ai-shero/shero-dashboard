const express = require('express');
const router = express.Router();
const { checkPassword, signSession, setAuthCookie, clearAuthCookie, isAuthed } = require('../auth');

// POST /api/auth/login  { password }
router.post('/login', (req, res) => {
  const password = (req.body && req.body.password) || '';
  if (!checkPassword(password)) {
    return res.status(401).json({ error: 'Incorrect password' });
  }
  setAuthCookie(res, signSession());
  res.json({ ok: true });
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

// GET /api/auth/me — { authed: boolean }
router.get('/me', (req, res) => {
  res.json({ authed: isAuthed(req) });
});

module.exports = router;
