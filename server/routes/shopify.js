const express = require('express');
const router = express.Router();
const { apiFetch } = require('../utils/fetch');
const { getSetting, setSetting } = require('./settings');

const SHOPIFY_API_VERSION = '2024-01';

// ── Token cache (in-memory + persisted to DB) ─────────────────────────────────
let _tokenCache = null; // { token, expiresAt }

async function getShopifyToken() {
  // 1. Try in-memory cache
  if (_tokenCache && Date.now() < _tokenCache.expiresAt - 60000) {
    return _tokenCache.token;
  }

  // 2. Try DB cache
  const stored      = await getSetting('shopify_access_token');
  const storedExp   = await getSetting('shopify_token_expires_at');
  if (stored && storedExp && Date.now() < parseInt(storedExp) - 60000) {
    _tokenCache = { token: stored, expiresAt: parseInt(storedExp) };
    return stored;
  }

  // 3. Fetch fresh token via client credentials grant
  const store        = process.env.SHOPIFY_STORE || await getSetting('shopify_store');
  const clientId     = process.env.SHOPIFY_CLIENT_ID     || 'ee20e6c4c23ecd743e9183797029f066';
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET || await getSetting('shopify_client_secret');

  if (!store || !clientSecret) return null;

  const resp = await apiFetch(`https://${store}/admin/oauth/access_token`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' })
  });

  if (!resp.ok) {
    const err = await resp.text();
    console.error('Shopify token fetch failed:', resp.status, err);
    return null;
  }

  const data      = await resp.json();
  const token     = data.access_token;
  const expiresIn = data.expires_in || 86399; // seconds (~24h)
  const expiresAt = Date.now() + expiresIn * 1000;

  // Persist to DB and in-memory
  await setSetting('shopify_access_token',    token);
  await setSetting('shopify_token_expires_at', String(expiresAt));
  _tokenCache = { token, expiresAt };

  console.log(`[Shopify] Fresh token obtained, expires in ${Math.round(expiresIn/3600)}h`);
  return token;
}

// GET /api/shopify?start=YYYY-MM-DD&end=YYYY-MM-DD
router.get('/', async (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) return res.status(400).json({ error: 'start and end required' });

  const store = process.env.SHOPIFY_STORE || await getSetting('shopify_store');
  const token = await getShopifyToken();

  if (token && store) {
    try {
      let allOrders = [];
      let url = `https://${store}/admin/api/${SHOPIFY_API_VERSION}/orders.json?status=any&created_at_min=${start}T00:00:00+08:00&created_at_max=${end}T23:59:59+08:00&limit=250&fields=total_price,financial_status`;

      while (url) {
        const resp = await apiFetch(url, { headers: { 'X-Shopify-Access-Token': token } });
        if (!resp.ok) throw new Error(`Shopify API ${resp.status}`);
        const data = await resp.json();
        allOrders = allOrders.concat(data.orders || []);
        const link = resp.headers.get('link') || '';
        const next = link.match(/<([^>]+)>;\s*rel="next"/);
        url = next ? next[1] : null;
      }

      const orders  = allOrders.filter(o => o.financial_status !== 'refunded' && o.financial_status !== 'voided');
      const revenue = orders.reduce((s, o) => s + parseFloat(o.total_price || 0), 0);
      return res.json({ channel: 'shopify', revenue: +revenue.toFixed(2), orders: orders.length, live: true });
    } catch (err) {
      console.error('Shopify API error:', err.message);
      _tokenCache = null; // clear cache so next call retries token
    }
  }

  const mock = generateMock('shopify', start, end, 4200, 38);
  res.json({ ...mock, live: false, note: 'mock — configure Shopify in Settings' });
});

// GET /api/shopify/test — verify connection
router.get('/test', async (req, res) => {
  const store = process.env.SHOPIFY_STORE || await getSetting('shopify_store');
  if (!store) return res.json({ ok: false, reason: 'No store domain saved' });

  _tokenCache = null; // force fresh token
  const token = await getShopifyToken();
  if (!token) return res.json({ ok: false, reason: 'Could not obtain access token — check Client ID and Client Secret' });

  try {
    const resp = await apiFetch(`https://${store}/admin/api/${SHOPIFY_API_VERSION}/shop.json`, {
      headers: { 'X-Shopify-Access-Token': token }
    });
    const body = await resp.json();
    if (!resp.ok) return res.json({ ok: false, status: resp.status, body });
    return res.json({ ok: true, shop: body.shop?.name, plan: body.shop?.plan_name });
  } catch (err) {
    return res.json({ ok: false, reason: err.message });
  }
});

function generateMock(channel, start, end, baseRevenue, baseOrders) {
  const days     = Math.max(1, (new Date(end) - new Date(start)) / 86400000 + 1);
  const variance = () => 0.7 + Math.random() * 0.6;
  return { channel, revenue: +(baseRevenue * days * variance() / 30).toFixed(2), orders: Math.round(baseOrders * days * variance() / 30) };
}

module.exports = router;
