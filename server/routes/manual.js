const express = require('express');
const router = express.Router();
const { db } = require('../db');

// GET /api/manual?channel=tiktok&start=2026-05-01&end=2026-05-07
router.get('/', async (req, res) => {
  const { channel, start, end } = req.query;
  let query = 'SELECT * FROM manual_entries WHERE entry_date >= ? AND entry_date <= ?';
  const params = [start || '2000-01-01', end || '2099-12-31'];
  if (channel) { query += ' AND channel = ?'; params.push(channel); }
  query += ' ORDER BY entry_date DESC';
  const result = await db.execute({ sql: query, args: params });
  res.json(result.rows);
});

// POST /api/manual — upsert a single day entry
router.post('/', async (req, res) => {
  const { channel, entry_date, revenue, orders, notes } = req.body;
  if (!channel || !entry_date) return res.status(400).json({ error: 'channel and entry_date required' });
  await db.execute({
    sql: `INSERT INTO manual_entries (channel, entry_date, revenue, orders, notes, updated_at)
          VALUES (?, ?, ?, ?, ?, datetime('now'))
          ON CONFLICT(channel, entry_date) DO UPDATE SET
            revenue = excluded.revenue,
            orders = excluded.orders,
            notes = excluded.notes,
            updated_at = datetime('now')`,
    args: [channel, entry_date, revenue || 0, orders || 0, notes || null]
  });
  res.json({ ok: true });
});

// DELETE /api/manual/:id
router.delete('/:id', async (req, res) => {
  await db.execute({ sql: 'DELETE FROM manual_entries WHERE id = ?', args: [req.params.id] });
  res.json({ ok: true });
});

// GET /api/manual/aggregate?channels=tiktok,lazada,parkson,watsons&start=...&end=...
router.get('/aggregate', async (req, res) => {
  const { channels, start, end } = req.query;
  const ch = (channels || 'tiktok,lazada,parkson,watsons').split(',');
  const placeholders = ch.map(() => '?').join(',');
  const result = await db.execute({
    sql: `SELECT channel, SUM(revenue) as revenue, SUM(orders) as orders
          FROM manual_entries
          WHERE channel IN (${placeholders}) AND entry_date >= ? AND entry_date <= ?
          GROUP BY channel`,
    args: [...ch, start || '2000-01-01', end || '2099-12-31']
  });
  res.json(result.rows);
});

module.exports = router;
