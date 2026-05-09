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

  res.json({ channel: 'shopee', revenue: 0, orders: 0, live: false });
});

module.exports = router;
