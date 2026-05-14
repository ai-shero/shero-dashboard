const express = require('express');
const router = express.Router();
const { db } = require('../db');
const { apiFetch } = require('../utils/fetch');

function getDateRange(period) {
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  // MYT = UTC+8
  const myt = new Date(now.getTime() + 8 * 3600000);
  const today = myt.toISOString().slice(0, 10);
  const yesterday = new Date(myt.getTime() - 86400000).toISOString().slice(0, 10);

  if (period === 'today') return { start: yesterday, end: yesterday };
  if (period === 'mtd') return { start: today.slice(0, 8) + '01', end: today };
  if (period === 'ytd') return { start: today.slice(0, 5) + '01-01', end: today };
  // custom: period = "2026-05-01:2026-05-07"
  if (period && period.includes(':')) {
    const [s, e] = period.split(':');
    return { start: s, end: e };
  }
  return { start: today, end: today };
}

async function fetchChannel(url) {
  try {
    const resp = await apiFetch(url);
    if (!resp.ok) return null;
    return await resp.json();
  } catch { return null; }
}

// GET /api/summary?period=today|mtd|ytd
router.get('/', async (req, res) => {
  const period = req.query.period || 'today';
  const { start, end } = getDateRange(period);
  const base = `http://localhost:${process.env.PORT || 3200}`;

  const [shopify, pos, shopee, lazada, manualRaw] = await Promise.all([
    fetchChannel(`${base}/api/shopify?start=${start}&end=${end}`),
    fetchChannel(`${base}/api/pos?start=${start}&end=${end}`),
    fetchChannel(`${base}/api/shopee?start=${start}&end=${end}`),
    fetchChannel(`${base}/api/lazada?start=${start}&end=${end}`),
    fetchChannel(`${base}/api/manual/aggregate?channels=tiktok,parkson,watsons&start=${start}&end=${end}`)
  ]);

  const manualByChannel = {};
  if (Array.isArray(manualRaw)) {
    manualRaw.forEach(r => { manualByChannel[r.channel] = r; });
  }

  // Lazada: use live data if available, fall back to manual. Prefer grossSales over income.
  const lazadaRevenue = lazada?.live ? (lazada.grossSales || lazada.income || 0) : +(manualByChannel['lazada']?.revenue || 0);
  const lazadaOrders  = lazada?.live ? (lazada.orders || 0) : +(manualByChannel['lazada']?.orders  || 0);
  const lazadaLive    = lazada?.live ?? false;

  const channels = [
    { id: 'shopify',  label: 'Shopify',     revenue: shopify?.revenue  || 0, orders: shopify?.orders  || 0, live: shopify?.live  ?? false },
    { id: 'shopee',   label: 'Shopee',      revenue: shopee?.grossSales || shopee?.income || shopee?.revenue || 0, orders: shopee?.orders || 0, live: shopee?.live ?? false },
    { id: 'tiktok',   label: 'TikTok Shop', revenue: +(manualByChannel['tiktok']?.revenue  || 0), orders: +(manualByChannel['tiktok']?.orders  || 0), live: false },
    { id: 'lazada',   label: 'Lazada',      revenue: lazadaRevenue, orders: lazadaOrders, live: lazadaLive },
    { id: 'pos',      label: 'SHERO POS',   revenue: pos?.revenue      || 0, orders: pos?.orders      || 0, live: pos?.live      ?? false },
    { id: 'parkson',  label: 'Parkson',     revenue: +(manualByChannel['parkson']?.revenue || 0), orders: +(manualByChannel['parkson']?.orders || 0), live: false },
    { id: 'watsons',  label: 'Watsons',     revenue: +(manualByChannel['watsons']?.revenue || 0), orders: +(manualByChannel['watsons']?.orders || 0), live: false },
  ];

  const totalRevenue = channels.reduce((s, c) => s + c.revenue, 0);
  const totalOrders  = channels.reduce((s, c) => s + c.orders, 0);

  res.json({
    period,
    start,
    end,
    total: { revenue: +totalRevenue.toFixed(2), orders: totalOrders },
    channels,
    shopifyDetail: shopify?.live ? shopify : null,
  });
});

// GET /api/summary/daily?days=30  — per-date, per-channel breakdown
router.get('/daily', async (req, res) => {
  const days = Math.min(parseInt(req.query.days || '30'), 90);
  const myt = new Date(Date.now() + 8 * 3600000);
  const endDate = new Date(myt.getTime() - 86400000).toISOString().slice(0, 10); // yesterday
  const startDate = new Date(new Date(endDate).getTime() - (days - 1) * 86400000).toISOString().slice(0, 10);

  const result = await db.execute({
    sql: `SELECT entry_date, channel, SUM(revenue) as revenue, SUM(orders) as orders
          FROM (
            SELECT entry_date, channel, revenue, orders FROM cached_data
            UNION ALL
            SELECT entry_date, channel, revenue, orders FROM manual_entries
              WHERE channel NOT IN (SELECT DISTINCT channel FROM cached_data)
          )
          WHERE entry_date >= ? AND entry_date <= ?
          GROUP BY entry_date, channel
          ORDER BY entry_date DESC, channel`,
    args: [startDate, endDate]
  });

  const CHANNELS = ['shopify', 'shopee', 'tiktok', 'lazada', 'pos', 'parkson', 'watsons'];
  const byDate = {};
  result.rows.forEach(r => {
    if (!byDate[r.entry_date]) byDate[r.entry_date] = {};
    byDate[r.entry_date][r.channel] = { revenue: +r.revenue, orders: +r.orders };
  });

  const rows = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(new Date(endDate).getTime() - i * 86400000).toISOString().slice(0, 10);
    const byChannel = byDate[d] || {};
    const totalRevenue = CHANNELS.reduce((s, c) => s + (byChannel[c]?.revenue || 0), 0);
    const totalOrders  = CHANNELS.reduce((s, c) => s + (byChannel[c]?.orders  || 0), 0);
    rows.push({
      date: d,
      total: { revenue: +totalRevenue.toFixed(2), orders: totalOrders },
      channels: CHANNELS.map(c => ({ id: c, revenue: byChannel[c]?.revenue || 0, orders: byChannel[c]?.orders || 0 }))
    });
  }

  res.json({ rows });
});

// GET /api/summary/trend?days=30  — daily totals for sparkline/chart
router.get('/trend', async (req, res) => {
  const days = Math.min(parseInt(req.query.days || '30'), 90);
  const myt = new Date(Date.now() + 8 * 3600000);
  const endDate = myt.toISOString().slice(0, 10);
  const startDate = new Date(myt - (days - 1) * 86400000).toISOString().slice(0, 10);

  const result = await db.execute({
    sql: `SELECT entry_date, SUM(revenue) as revenue, SUM(orders) as orders
          FROM (
            SELECT entry_date, revenue, orders FROM cached_data
            UNION ALL
            SELECT entry_date, revenue, orders FROM manual_entries WHERE channel != 'shopify'
          )
          WHERE entry_date >= ? AND entry_date <= ?
          GROUP BY entry_date ORDER BY entry_date`,
    args: [startDate, endDate]
  });

  // Build full date range with zeros for gaps
  const byDate = {};
  result.rows.forEach(r => { byDate[r.entry_date] = { revenue: +r.revenue, orders: +r.orders }; });

  const trend = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(new Date(startDate).getTime() + i * 86400000).toISOString().slice(0, 10);
    trend.push({ date: d, revenue: byDate[d]?.revenue || 0, orders: byDate[d]?.orders || 0 });
  }

  res.json({ trend });
});

module.exports = router;
