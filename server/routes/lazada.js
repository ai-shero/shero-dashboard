const express = require('express');
const router  = express.Router();

// ── GET /api/lazada?start=YYYY-MM-DD&end=YYYY-MM-DD ──────────────────────────
// Reads from cached_data table, populated nightly by scrapers/lazada.js
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
              AVG(conversion_rate) AS conversion_rate,
              SUM(ad_spend)        AS ad_spend
            FROM cached_data
            WHERE channel = 'lazada' AND entry_date >= ? AND entry_date <= ?`,
      args: [start, end],
    });
    const row = result.rows[0];
    if (row && row.revenue != null) {
      const n = (v, d = 2) => v != null ? +Number(v).toFixed(d) : null;
      return res.json({
        channel:        'lazada',
        live:           true,
        income:         n(row.revenue),
        grossSales:     n(row.gross_sales),
        orders:         row.orders   != null ? Number(row.orders)   : null,
        visitors:       row.visitors != null ? Number(row.visitors) : null,
        conversionRate: n(row.conversion_rate),
        adSpend:        n(row.ad_spend),
      });
    }
  } catch (err) {
    console.error('[Lazada] DB error:', err.message);
  }

  // Fall back to manual_entries
  try {
    const result = await db.execute({
      sql: `SELECT COALESCE(SUM(revenue),0) AS revenue, COALESCE(SUM(orders),0) AS orders
            FROM manual_entries WHERE channel = 'lazada' AND entry_date >= ? AND entry_date <= ?`,
      args: [start, end],
    });
    const row = result.rows[0];
    return res.json({
      channel: 'lazada',
      live:    false,
      income:  +Number(row.revenue).toFixed(2),
      orders:  +Number(row.orders),
    });
  } catch (err) {
    console.error('[Lazada] fallback error:', err.message);
  }

  res.json({ channel: 'lazada', income: 0, orders: 0, live: false });
});

module.exports = router;
