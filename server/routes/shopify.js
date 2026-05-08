const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const { apiFetch } = require('../utils/fetch');
const { getSetting, setSetting } = require('./settings');

const SHOPIFY_API_VERSION = '2024-01';
const SHOPIFY_STORE       = 'shero-cosmetics-my.myshopify.com';
const CLIENT_ID           = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET       = process.env.SHOPIFY_CLIENT_SECRET;
const SCOPES              = 'read_orders,read_analytics';
const REDIRECT_URI        = process.env.SHOPIFY_REDIRECT_URI  || 'https://shero-dashboard.onrender.com/api/shopify/oauth/callback';

// ── OAuth: Step 1 — redirect user to Shopify consent page ────────────────────
// Visit http://localhost:3200/api/shopify/oauth/start in your logged-in Chrome
router.get('/oauth/start', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  // Store state in a simple in-process map (survives the round-trip)
  oauthStates.add(state);
  setTimeout(() => oauthStates.delete(state), 10 * 60 * 1000); // expire in 10 min

  const url = `https://${SHOPIFY_STORE}/admin/oauth/authorize`
    + `?client_id=${CLIENT_ID}`
    + `&scope=${SCOPES}`
    + `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`
    + `&state=${state}`;

  console.log('[Shopify OAuth] Redirecting to Shopify consent page...');
  res.redirect(url);
});

const oauthStates = new Set();

// ── OAuth: Step 2 — Shopify redirects back here with a code ──────────────────
router.get('/oauth/callback', async (req, res) => {
  const { code, state, hmac, shop } = req.query;

  if (!oauthStates.has(state)) {
    return res.status(403).send('Invalid state — possible CSRF. Please start again at /api/shopify/oauth/start');
  }
  oauthStates.delete(state);

  if (!code) {
    return res.status(400).send('No code returned by Shopify.');
  }

  // Exchange code for permanent access token
  try {
    const resp = await apiFetch(`https://${SHOPIFY_STORE}/admin/oauth/access_token`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      console.error('[Shopify OAuth] Token exchange failed:', resp.status, err);
      return res.status(500).send(`Token exchange failed: ${resp.status} — ${err}`);
    }

    const data  = await resp.json();
    const token = data.access_token;

    if (!token) {
      return res.status(500).send('No access_token in response: ' + JSON.stringify(data));
    }

    // Save permanently — this token never expires
    await setSetting('shopify_access_token',    token);
    await setSetting('shopify_token_expires_at', String(Date.now() + 100 * 365 * 24 * 3600 * 1000)); // 100 years
    _tokenCache = { token, expiresAt: Date.now() + 100 * 365 * 24 * 3600 * 1000 };

    console.log('[Shopify OAuth] ✓ Access token saved. Shopify is connected!');
    console.log(`[Shopify OAuth] TOKEN: ${token}`);
    res.send(`
      <html><body style="font-family:sans-serif;padding:40px">
        <h2>✅ Shopify connected!</h2>
        <p>Access token saved. You can close this tab.</p>
        <p><a href="/">← Back to dashboard</a></p>
      </body></html>
    `);
  } catch (err) {
    console.error('[Shopify OAuth] Error:', err.message);
    res.status(500).send('Error: ' + err.message);
  }
});

// ── Token helper ─────────────────────────────────────────────────────────────
let _tokenCache = null;

async function getShopifyToken() {
  // Env var override — set SHOPIFY_ACCESS_TOKEN after completing OAuth once
  if (process.env.SHOPIFY_ACCESS_TOKEN) {
    _tokenCache = { token: process.env.SHOPIFY_ACCESS_TOKEN, expiresAt: Date.now() + 365 * 24 * 3600 * 1000 };
    return process.env.SHOPIFY_ACCESS_TOKEN;
  }

  if (_tokenCache && Date.now() < _tokenCache.expiresAt - 60000) return _tokenCache.token;

  const stored    = await getSetting('shopify_access_token');
  const storedExp = await getSetting('shopify_token_expires_at');
  if (stored && storedExp && Date.now() < parseInt(storedExp) - 60000) {
    _tokenCache = { token: stored, expiresAt: parseInt(storedExp) };
    return stored;
  }

  // Auto-fetch via client credentials grant
  try {
    const resp = await apiFetch(`https://${SHOPIFY_STORE}/admin/oauth/access_token`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: 'client_credentials' }),
    });
    if (!resp.ok) throw new Error(`${resp.status}: ${await resp.text()}`);
    const data      = await resp.json();
    const token     = data.access_token;
    const expiresAt = Date.now() + (data.expires_in || 86399) * 1000;
    await setSetting('shopify_access_token',    token);
    await setSetting('shopify_token_expires_at', String(expiresAt));
    _tokenCache = { token, expiresAt };
    console.log('[Shopify] ✓ Token refreshed via client credentials');
    return token;
  } catch (e) {
    console.error('[Shopify] Token fetch failed:', e.message);
    return null;
  }
}

// ── GET /api/shopify?start=YYYY-MM-DD&end=YYYY-MM-DD ─────────────────────────
router.get('/', async (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) return res.status(400).json({ error: 'start and end required' });

  const token = await getShopifyToken();

  if (token) {
    try {
      let allOrders = [];
      let url = `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/orders.json`
        + `?status=any`
        + `&created_at_min=${start}T00:00:00+08:00`
        + `&created_at_max=${end}T23:59:59+08:00`
        + `&limit=250`
        + `&fields=total_price,financial_status`;

      while (url) {
        const resp = await apiFetch(url, { headers: { 'X-Shopify-Access-Token': token } });
        if (!resp.ok) throw new Error(`Shopify API ${resp.status}: ${await resp.text()}`);
        const data = await resp.json();
        allOrders  = allOrders.concat(data.orders || []);
        const link = resp.headers.get('link') || '';
        const next = link.match(/<([^>]+)>;\s*rel="next"/);
        url = next ? next[1] : null;
      }

      const orders  = allOrders.filter(o => !['refunded','voided'].includes(o.financial_status));
      const revenue = orders.reduce((s, o) => s + parseFloat(o.total_price || 0), 0);
      return res.json({ channel: 'shopify', revenue: +revenue.toFixed(2), orders: orders.length, live: true });
    } catch (err) {
      console.error('[Shopify] API error:', err.message);
      _tokenCache = null;
    }
  }

  const mock = generateMock('shopify', start, end, 4200, 38);
  res.json({ ...mock, live: false, note: 'mock — visit /api/shopify/oauth/start to connect' });
});

// ── GET /api/shopify/test ─────────────────────────────────────────────────────
router.get('/test', async (req, res) => {
  const token = await getShopifyToken();
  if (!token) {
    return res.json({
      ok: false,
      reason: 'No token — visit http://localhost:3200/api/shopify/oauth/start to authorise'
    });
  }

  try {
    const resp = await apiFetch(
      `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/shop.json`,
      { headers: { 'X-Shopify-Access-Token': token } }
    );
    const body = await resp.json();
    if (!resp.ok) return res.json({ ok: false, status: resp.status, body });
    return res.json({ ok: true, shop: body.shop?.name, plan: body.shop?.plan_name });
  } catch (err) {
    return res.json({ ok: false, reason: err.message });
  }
});

function generateMock(channel, start, end, baseRevenue, baseOrders) {
  const days = Math.max(1, (new Date(end) - new Date(start)) / 86400000 + 1);
  const v    = () => 0.7 + Math.random() * 0.6;
  return { channel, revenue: +(baseRevenue * days * v() / 30).toFixed(2), orders: Math.round(baseOrders * days * v() / 30) };
}

module.exports = router;
