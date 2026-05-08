const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { apiFetch } = require('../utils/fetch');
const { getSetting } = require('./settings');

const SHOPIFY_API_VERSION = '2024-01';
const SCOPES = 'read_orders,read_products';

async function getShopifyCredentials() {
  const store = process.env.SHOPIFY_STORE || await getSetting('shopify_store');
  const token = process.env.SHOPIFY_TOKEN || await getSetting('shopify_token');
  return { store, token };
}

// GET /api/shopify?start=YYYY-MM-DD&end=YYYY-MM-DD
router.get('/', async (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) return res.status(400).json({ error: 'start and end required' });

  const { store, token } = await getShopifyCredentials();

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

      const orders = allOrders.filter(o => o.financial_status !== 'refunded' && o.financial_status !== 'voided');
      const revenue = orders.reduce((s, o) => s + parseFloat(o.total_price || 0), 0);
      return res.json({ channel: 'shopify', revenue: +revenue.toFixed(2), orders: orders.length, live: true });
    } catch (err) {
      console.error('Shopify API error:', err.message);
    }
  }

  const mock = generateMock('shopify', start, end, 4200, 38);
  res.json({ ...mock, live: false, note: 'mock — add SHOPIFY_TOKEN via Settings' });
});

// GET /api/shopify/test — verify stored credentials
router.get('/test', async (req, res) => {
  const { store, token } = await getShopifyCredentials();
  if (!store || !token) return res.json({ ok: false, reason: 'No credentials saved' });
  try {
    const url = `https://${store}/admin/api/${SHOPIFY_API_VERSION}/shop.json`;
    const resp = await apiFetch(url, { headers: { 'X-Shopify-Access-Token': token } });
    const body = await resp.json();
    if (!resp.ok) return res.json({ ok: false, status: resp.status, body });
    return res.json({ ok: true, shop: body.shop?.name, plan: body.shop?.plan_name });
  } catch (err) {
    return res.json({ ok: false, reason: err.message });
  }
});

// GET /api/shopify/auth?shop=yourstore.myshopify.com — start OAuth
router.get('/auth', (req, res) => {
  const shop = req.query.shop;
  if (!shop) return res.status(400).send('shop parameter required');
  const clientId = process.env.SHOPIFY_CLIENT_ID || 'ee20e6c4c23ecd743e9183797029f066';
  const redirectUri = `${req.protocol}://${req.get('host')}/api/shopify/callback`;
  const state = crypto.randomBytes(16).toString('hex');
  res.cookie('shopify_oauth_state', state, { httpOnly: true, maxAge: 600000 });
  const authUrl = `https://${shop}/admin/oauth/authorize?client_id=${clientId}&scope=${SCOPES}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;
  res.redirect(authUrl);
});

// GET /api/shopify/callback — Shopify redirects here after auth
router.get('/callback', async (req, res) => {
  const { code, shop, state } = req.query;
  const savedState = req.cookies?.shopify_oauth_state;
  if (state !== savedState) return res.status(403).send('State mismatch — CSRF check failed');

  const clientId = process.env.SHOPIFY_CLIENT_ID || 'ee20e6c4c23ecd743e9183797029f066';
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
  if (!clientSecret) return res.status(500).send('SHOPIFY_CLIENT_SECRET not configured');

  try {
    const resp = await apiFetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code })
    });
    if (!resp.ok) throw new Error(`Token exchange failed: ${resp.status}`);
    const data = await resp.json();
    const { setSetting } = require('./settings');
    await setSetting('shopify_store', shop);
    await setSetting('shopify_token', data.access_token);
    res.redirect('/?connected=shopify');
  } catch (err) {
    console.error('Shopify OAuth error:', err.message);
    res.status(500).send('OAuth failed: ' + err.message);
  }
});

function generateMock(channel, start, end, baseRevenue, baseOrders) {
  const days = Math.max(1, (new Date(end) - new Date(start)) / 86400000 + 1);
  const variance = () => 0.7 + Math.random() * 0.6;
  return { channel, revenue: +(baseRevenue * days * variance() / 30).toFixed(2), orders: Math.round(baseOrders * days * variance() / 30) };
}

module.exports = router;
