const express = require('express');
const router  = express.Router();
const { db } = require('../db');

const CHANNELS = ['shopify', 'shopee', 'lazada', 'tiktok'];

// GET /api/rankings?start=YYYY-MM-DD&end=YYYY-MM-DD&limit=10
// Returns top products by units sold per channel over the date range.
// A single day = start === end. Over a range, units/revenue are summed per
// product and re-ranked. Grouped by product_name (stable across days).
router.get('/', async (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) return res.status(400).json({ error: 'start and end required' });
  const limit = Math.min(parseInt(req.query.limit || '10', 10), 50);

  const out = {};
  for (const channel of CHANNELS) {
    try {
      const r = await db.execute({
        sql: `SELECT product_name,
                     SUM(units)   AS units,
                     SUM(revenue) AS revenue,
                     MAX(sku)     AS sku
              FROM product_rankings
              WHERE channel = ? AND entry_date >= ? AND entry_date <= ?
              GROUP BY product_name
              HAVING units > 0
              ORDER BY units DESC, revenue DESC
              LIMIT ?`,
        args: [channel, start, end, limit],
      });
      out[channel] = r.rows.map((row, i) => ({
        rank:    i + 1,
        name:    row.product_name,
        units:   row.units != null ? Number(row.units) : null,
        revenue: row.revenue != null ? +Number(row.revenue).toFixed(2) : null,
        sku:     row.sku || null,
      }));
    } catch (err) {
      console.error(`[Rankings] ${channel} error:`, err.message);
      out[channel] = [];
    }
  }

  res.json({ start, end, channels: out });
});

module.exports = router;
