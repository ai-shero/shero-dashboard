require('dotenv').config();
const express = require('express');
const path = require('path');
const { init } = require('./db');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Simple cookie parser (no dependency)
app.use((req, _res, next) => {
  const cookies = {};
  (req.headers.cookie || '').split(';').forEach(c => {
    const [k, ...v] = c.trim().split('=');
    if (k) cookies[k.trim()] = decodeURIComponent(v.join('='));
  });
  req.cookies = cookies;
  next();
});

app.use(express.static(path.join(__dirname, '..', 'client', 'public')));

app.use('/api/settings', require('./routes/settings').router);
app.use('/api/summary', require('./routes/summary'));
app.use('/api/shopify', require('./routes/shopify'));
app.use('/api/pos', require('./routes/pos'));
app.use('/api/shopee', require('./routes/shopee'));
app.use('/api/manual', require('./routes/manual'));

// Shopify OAuth callback — Shopify redirects to the App URL (root) with ?code=&state=
// This must be BEFORE the static file handler
app.get('/', async (req, res, next) => {
  const { code, state } = req.query;
  if (!code || !state) return next(); // normal homepage request

  // Hand off to shopify router's inline handler
  const { handleOAuthCallback } = require('./routes/shopify');
  if (handleOAuthCallback) {
    return handleOAuthCallback(req, res);
  }
  next();
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'client', 'public', 'index.html'));
});

const PORT = process.env.PORT || 3200;

init().then(() => {
  app.listen(PORT, () => {
    console.log(`SHERO Dashboard running on http://localhost:${PORT}`);
  });

  // Daily scrape at midnight MYT (UTC+8 = 16:00 UTC)
  scheduleMidnightScrape();
}).catch(err => {
  console.error('DB init failed:', err);
  process.exit(1);
});

function scheduleMidnightScrape() {
  // Only run scraper if session files exist (i.e. logins have been done)
  const fs = require('fs');
  const sessionsDir = require('path').join(__dirname, '..', 'scrapers', 'sessions');
  if (!fs.existsSync(sessionsDir)) return; // no sessions yet

  function msUntilMidnightMYT() {
    const now = new Date(Date.now() + 8 * 3600000); // MYT
    const midnight = new Date(now);
    midnight.setUTCHours(16, 1, 0, 0); // 16:00 UTC = 00:00 MYT next day
    if (midnight <= new Date()) midnight.setUTCDate(midnight.getUTCDate() + 1);
    return midnight - new Date();
  }

  function scheduleNext() {
    const ms = msUntilMidnightMYT();
    console.log(`[Cron] Next scrape in ${Math.round(ms/3600000)}h`);
    setTimeout(async () => {
      try {
        const { runAll } = require('../scrapers/run');
        await runAll();
      } catch (e) {
        console.error('[Cron] Scrape failed:', e.message);
      }
      scheduleNext(); // reschedule for next midnight
    }, ms);
  }

  scheduleNext();
}
