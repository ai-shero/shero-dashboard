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

  // Fall back to manual_entries for channel='pos'
  const { db } = require('../db');
  try {
    const result = await db.execute({
      sql: `SELECT COALESCE(SUM(revenue),0) AS revenue, COALESCE(SUM(orders),0) AS orders
            FROM manual_entries WHERE channel = 'pos' AND entry_date >= ? AND entry_date <= ?`,
      args: [start, end]
    });
    const row = result.rows[0];
    return res.json({ channel: 'pos', revenue: +Number(row.revenue).toFixed(2), orders: +Number(row.orders), live: false });
  } catch (err) {
    console.error('[POS] DB error:', err.message);
  }
  res.json({ channel: 'pos', revenue: 0, orders: 0, live: false });

module.exports = router;
