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

// GET /api/settings/scrape-status
router.get('/scrape-status', async (req, res) => {
  const val = await getSetting('last_scrape');
  res.json(val ? JSON.parse(val) : null);
});

// GET /api/settings — return non-sensitive settings. Secrets are NEVER sent to
// the browser, only a boolean `<key>_set` flag. (The old check matched keys
// containing 'token', but the key is shopify_client_SECRET — so a stored secret
// would have been returned in plaintext, and the _set flag never emitted.)
router.get('/', async (req, res) => {
  const keys = ['shopify_store', 'shopify_client_secret', 'pos_api_url'];
  const result = {};
  for (const key of keys) {
    const val = await getSetting(key);
    if (/secret|token|password/.test(key)) {
      result[key] = '';
      result[key + '_set'] = !!val;
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
