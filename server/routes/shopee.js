const express = require('express');
const router = express.Router();

// Returns Shopee revenue/orders — Phase 1: reads Ada's Google Sheet
// Sheet ID: 1_yiM1ZVILY_6j-D4ipV-_8WvhGpb97VyQpUeAzJIwq8
// Phase 2: Shopee Open Platform API
router.get('/', async (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) return res.status(400).json({ error: 'start and end required' });

  if (process.env.SHEETS_ID && process.env.SHEETS_CREDENTIALS) {
    try {
      // TODO: implement Google Sheets API read using service account
      // Sheet has daily rows: date | orders | revenue per Ada's automation
      throw new Error('Sheets integration not yet wired');
    } catch (err) {
      console.error('Sheets error:', err.message);
    }
  }

  const mock = generateMock(start, end, 8500, 110);
  res.json({ ...mock, channel: 'shopee', live: false, note: 'mock — add SHEETS_CREDENTIALS to .env' });
});

function generateMock(start, end, baseRevenue, baseOrders) {
  const days = Math.max(1, (new Date(end) - new Date(start)) / 86400000 + 1);
  const v = () => 0.7 + Math.random() * 0.6;
  return { revenue: +(baseRevenue * days * v() / 30).toFixed(2), orders: Math.round(baseOrders * days * v() / 30) };
}

module.exports = router;
