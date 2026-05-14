const express = require('express');
const router  = express.Router();

// ── GET /api/shopee?start=YYYY-MM-DD&end=YYYY-MM-DD ──────────────────────────
// Reads from cached_data table, populated nightly by scrapers/shopee.js
router.get('/', async (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) return res.status(400).json({ error: 'start and end required' });

  const { db } = require('../db');
  try {
    const result = await db.execute({
      sql: `SELECT
              SUM(revenue)         AS revenue,
              SUM(gross_sales)     AS gross_sales,
              SUM(orders)          AS orders,
              SUM(sessions)        AS visitors,
              SUM(clicks)          AS clicks,
              AVG(conversion_rate) AS conversion_rate,
              SUM(ad_spend)        AS ad_spend,
              AVG(roas)            AS roas
            FROM cached_data
            WHERE channel = 'shopee' AND entry_date >= ? AND entry_date <= ?`,
      args: [start, end],
    });
    const row = result.rows[0];
    if (row && row.revenue != null) {
      const n = (v, d = 2) => v != null ? +Number(v).toFixed(d) : null;
      return res.json({
        channel:        'shopee',
        live:           true,
        income:         n(row.revenue),
        grossSales:     n(row.gross_sales),
        orders:         row.orders   != null ? Number(row.orders)   : null,
        visitors:       row.visitors != null ? Number(row.visitors) : null,
        clicks:         row.clicks   != null ? Number(row.clicks)   : null,
        conversionRate: n(row.conversion_rate),
        adSpend:        n(row.ad_spend),
        roas:           n(row.roas),
      });
    }
  } catch (err) {
    console.error('[Shopee] DB error:', err.message);
  }

  // Fall back to manual_entries
  try {
    const result = await db.execute({
      sql: `SELECT COALESCE(SUM(revenue),0) AS revenue, COALESCE(SUM(orders),0) AS orders
            FROM manual_entries WHERE channel = 'shopee' AND entry_date >= ? AND entry_date <= ?`,
      args: [start, end],
    });
    const row = result.rows[0];
    return res.json({
      channel: 'shopee',
      live:    false,
      income:  +Number(row.revenue).toFixed(2),
      orders:  +Number(row.orders),
    });
  } catch (err) {
    console.error('[Shopee] fallback error:', err.message);
  }

  res.json({ channel: 'shopee', income: 0, orders: 0, live: false });
});

module.exports = router;
