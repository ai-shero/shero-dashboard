require('dotenv').config();
const express = require('express');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { init } = require('./db');
const { requireAuth } = require('./auth');

const app = express();
app.set('trust proxy', 1); // Render terminates HTTPS; trust one proxy hop
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

// Health check (CORS-open so the SHERO app portal can read true status cross-origin).
// Public — declared before the auth gate.
app.get('/api/health', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.json({ ok: true, service: 'shero-dashboard', ts: new Date().toISOString() });
});

// Auth endpoints must be reachable without a session. Throttle login guesses.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts — please wait a few minutes and try again.' },
});
app.use('/api/auth', authLimiter, require('./routes/auth'));

// The login page (and its assets) must load without a session, so static files
// stay public. Everything else under /api requires a valid session.
app.use(express.static(path.join(__dirname, '..', 'client', 'public')));
app.use('/api', requireAuth);

app.use('/api/settings', require('./routes/settings').router);
app.use('/api/summary', require('./routes/summary'));
app.use('/api/shopify', require('./routes/shopify'));
app.use('/api/pos', require('./routes/pos'));
app.use('/api/shopee', require('./routes/shopee'));
app.use('/api/lazada', require('./routes/lazada'));
app.use('/api/tiktok', require('./routes/tiktok'));
app.use('/api/rankings', require('./routes/rankings'));
app.use('/api/manual', require('./routes/manual'));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'client', 'public', 'index.html'));
});

const PORT = process.env.PORT || 3200;

init().then(() => {
  app.listen(PORT, () => {
    console.log(`SHERO Dashboard running on http://localhost:${PORT}`);
  });

  // NOTE: The nightly scrape is NO LONGER scheduled in-process.
  // It now runs via the Windows "Shero Dashboard - Daily Scrape" task
  // (scrapers/run-daily.ps1), which survives reboots/sleep and catches up
  // on missed nights. An in-process setTimeout did none of those and was the
  // root cause of the May 30–Jun 2 data gap. Install with: npm run install-startup
  // scheduleMidnightScrape();  // ← intentionally disabled
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
        // Save last scrape metadata for dashboard status badge
        const { db } = require('./db');
        const { setSetting } = require('./routes/settings');
        const r = await db.execute('SELECT entry_date, revenue, orders FROM cached_data ORDER BY entry_date DESC LIMIT 1');
        if (r.rows[0]) {
          await setSetting('last_scrape', JSON.stringify({
            date: r.rows[0].entry_date,
            revenue: +r.rows[0].revenue,
            orders: +r.rows[0].orders,
            scraped_at: new Date().toISOString()
          }));
        }
      } catch (e) {
        console.error('[Cron] Scrape failed:', e.message);
      }
      scheduleNext(); // reschedule for next midnight
    }, ms);
  }

  scheduleNext();
}
