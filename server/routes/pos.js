const express = require('express');
const router = express.Router();
const { apiFetch } = require('../utils/fetch');
const { getSetting } = require('./settings');

router.get('/', async (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) return res.status(400).json({ error: 'start and end required' });

  const posUrl = process.env.POS_API_URL || await getSetting('pos_api_url');

  if (posUrl) {
    try {
      const url = `${posUrl.replace(/\/$/, '')}/api/sales-summary?start=${start}&end=${end}`;
      const resp = await apiFetch(url);
      if (!resp.ok) throw new Error(`POS API ${resp.status}`);
      const data = await resp.json();
      return res.json({ channel: 'pos', revenue: data.revenue, orders: data.sessions || data.orders, live: true });
    } catch (err) {
      console.error('POS API error:', err.message);
    }
  }

  const mock = generateMock(start, end, 6800, 55);
  res.json({ ...mock, channel: 'pos', live: false, note: 'mock — add POS API URL via Settings' });
});

function generateMock(start, end, baseRevenue, baseOrders) {
  const days = Math.max(1, (new Date(end) - new Date(start)) / 86400000 + 1);
  const v = () => 0.7 + Math.random() * 0.6;
  return { revenue: +(baseRevenue * days * v() / 30).toFixed(2), orders: Math.round(baseOrders * days * v() / 30) };
}

module.exports = router;
