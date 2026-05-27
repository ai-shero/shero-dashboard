const express = require('express');
const router  = express.Router();

// ── GET /api/tiktok?start=YYYY-MM-DD&end=YYYY-MM-DD ──────────────────────────
// Reads from cached_data table, populated nightly by scrapers/tiktok.js
router.get('/', async (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) return res.status(400).json({ error: 'start and end required' });

  const { db } = require('../db');
  try {
    const result = await db.execute({
      sql: `SELECT
              SUM(gross_sales)      AS gross_sales,
              SUM(orders)           AS orders,
              SUM(sessions)         AS visitors,
              AVG(avg_order_value)  AS avg_order_value
            FROM cached_data
            WHERE channel = 'tiktok' AND entry_date >= ? AND entry_date <= ?`,
      args: [start, end],
    });
    const row = result.rows[0];
    if (row && row.gross_sales != null) {
      const n = (v, d = 2) => v != null ? +Number(v).toFixed(d) : null;
      return res.json({
        channel:       'tiktok',
        live:          true,
        revenue:       n(row.gross_sales),
        grossSales:    n(row.gross_sales),
        orders:        row.orders   != null ? Number(row.orders)   : null,
        visitors:      row.visitors != null ? Number(row.visitors) : null,
        avgOrderValue: n(row.avg_order_value),
      });
    }
  } catch (err) {
    console.error('[TikTok] DB error:', err.message);
  }

  // Fall back to manual_entries
  try {
    const result = await db.execute({
      sql: `SELECT COALESCE(SUM(revenue),0) AS revenue, COALESCE(SUM(orders),0) AS orders
            FROM manual_entries WHERE channel = 'tiktok' AND entry_date >= ? AND entry_date <= ?`,
      args: [start, end],
    });
    const row = result.rows[0];
    return res.json({
      channel: 'tiktok',
      live:    false,
      revenue: +Number(row.revenue).toFixed(2),
      orders:  +Number(row.orders),
    });
  } catch (err) {
    console.error('[TikTok] fallback error:', err.message);
  }

  res.json({ channel: 'tiktok', revenue: 0, orders: 0, live: false });
});

module.exports = router;
