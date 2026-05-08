const express = require('express');
const router = express.Router();
const { db } = require('../db');

async function getSetting(key) {
  try {
    const r = await db.execute({ sql: 'SELECT value FROM settings WHERE key = ?', args: [key] });
    return r.rows[0]?.value ?? null;
  } catch { return null; }
}

async function setSetting(key, value) {
  await db.execute({
    sql: `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    args: [key, value]
  });
}

// GET /api/settings — return non-sensitive settings (masked tokens)
router.get('/', async (req, res) => {
  const keys = ['shopify_store', 'shopify_client_secret', 'pos_api_url'];
  const result = {};
  for (const key of keys) {
    const val = await getSetting(key);
    if (key.includes('token') && val) {
      result[key] = val.slice(0, 8) + '…' + val.slice(-4);
      result[key + '_set'] = true;
    } else {
      result[key] = val || '';
    }
  }
  res.json(result);
});

// POST /api/settings — save settings
router.post('/', async (req, res) => {
  const allowed = ['shopify_store', 'shopify_client_secret', 'pos_api_url'];
  const saved = [];
  for (const key of allowed) {
    if (req.body[key] !== undefined && req.body[key] !== '') {
      await setSetting(key, req.body[key].trim());
      saved.push(key);
    }
  }
  res.json({ ok: true, saved });
});

module.exports = { router, getSetting, setSetting };
