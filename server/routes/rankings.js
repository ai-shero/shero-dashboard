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
      // Pull all sold products over the range, then split into paid (revenue > 0,
      // the ranking) and free gifts (units sold but RM0 — GWP / gift cards / samples).
      const r = await db.execute({
        sql: `SELECT product_name,
                     SUM(units)   AS units,
                     SUM(revenue) AS revenue,
                     MAX(sku)     AS sku
              FROM product_rankings
              WHERE channel = ? AND entry_date >= ? AND entry_date <= ?
              GROUP BY product_name
              HAVING units > 0
              ORDER BY units DESC, revenue DESC`,
        args: [channel, start, end],
      });

      const rows = r.rows.map(row => ({
        name:    row.product_name,
        units:   row.units != null ? Number(row.units) : 0,
        revenue: row.revenue != null ? +Number(row.revenue).toFixed(2) : 0,
        sku:     row.sku || null,
      }));

      const ranked = rows.filter(p => p.revenue > 0).slice(0, limit).map((p, i) => ({ rank: i + 1, ...p }));
      const freeGifts = rows.filter(p => p.revenue <= 0).slice(0, 10).map(p => ({ name: p.name, units: p.units }));

      out[channel] = { ranked, freeGifts };
    } catch (err) {
      console.error(`[Rankings] ${channel} error:`, err.message);
      out[channel] = { ranked: [], freeGifts: [] };
    }
  }

  res.json({ start, end, channels: out });
});

module.exports = router;
