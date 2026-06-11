/**
 * Daily scrape runner.
 *
 * Invocation modes:
 *   node scrapers/run.js                  → self-healing: backfill any gap since the
 *                                            last scraped day through yesterday, and
 *                                            re-scrape the trailing 3 days (settlement lag).
 *                                            Capped at MAX_SPAN days to avoid runaway.
 *   node scrapers/run.js 2026-06-01       → scrape a single date
 *   node scrapers/run.js 2026-05-30 2026-06-02 → backfill an inclusive date range
 *
 * Scheduled nightly by the "Shero Dashboard - Daily Scrape" Windows task
 * (see scrapers/run-daily.ps1 + install-startup.ps1). Independent of the web server.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { db, init } = require('../server/db');

const TRAILING_DAYS = 3;   // re-scrape the last N days each run (Lazada/Shopee income lag 1-2d)
const MAX_SPAN      = 14;  // never scrape more than this many days in one self-healing run

const ALL_SCRAPERS = [
  { id: 'shopify', scraper: require('./shopify') },
  { id: 'shopee',  scraper: require('./shopee') },
  { id: 'lazada',  scraper: require('./lazada') },
  { id: 'tiktok',  scraper: require('./tiktok') },
];

// Optional channel filter: ONLY=tiktok or ONLY=tiktok,lazada (env var).
// Lets you re-run a single channel for a date/range without redoing the others.
const ONLY = (process.env.ONLY || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const SCRAPERS = ONLY.length ? ALL_SCRAPERS.filter(s => ONLY.includes(s.id)) : ALL_SCRAPERS;

/* ─── date helpers ───────────────────────────────────────────────────────── */
function mytYesterday() {
  const myt = new Date(Date.now() + 8 * 3600000);
  return new Date(+myt - 86400000).toISOString().slice(0, 10);
}
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Self-healing date list: from (last data day + 1) through yesterday, always
 * including the trailing window, capped to MAX_SPAN. Fresh DB → just yesterday.
 */
async function resolveSelfHealingDates() {
  const yesterday = mytYesterday();
  let start;
  try {
    const r = await db.execute('SELECT MAX(entry_date) AS last FROM cached_data');
    const last = r.rows[0]?.last;
    if (!last) {
      start = yesterday;
    } else {
      const gapStart      = addDays(last, 1);                     // day after last data
      const trailingStart = addDays(yesterday, -(TRAILING_DAYS - 1));
      start = gapStart < trailingStart ? gapStart : trailingStart;
      const cap = addDays(yesterday, -(MAX_SPAN - 1));
      if (start < cap) start = cap;
    }
  } catch (e) {
    console.warn('[Scrape] Could not read last date, defaulting to yesterday:', e.message);
    start = yesterday;
  }

  const dates = [];
  for (let d = start; d <= yesterday; d = addDays(d, 1)) dates.push(d);
  return dates.length ? dates : [yesterday];
}

/* ─── DB upsert ──────────────────────────────────────────────────────────── */
async function upsertCache(channel, date, result) {
  await db.execute({
    sql: `INSERT INTO cached_data (
            channel, entry_date, revenue, orders,
            gross_sales, discounts, returns, net_sales,
            shipping_charges, return_fees, taxes,
            orders_fulfilled, avg_order_value,
            sessions, conversion_rate, returning_customer_rate,
            ad_spend, clicks, roas,
            fetched_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
          ON CONFLICT(channel, entry_date) DO UPDATE SET
            revenue=excluded.revenue, orders=excluded.orders,
            gross_sales=excluded.gross_sales, discounts=excluded.discounts,
            returns=excluded.returns, net_sales=excluded.net_sales,
            shipping_charges=excluded.shipping_charges, return_fees=excluded.return_fees,
            taxes=excluded.taxes, orders_fulfilled=excluded.orders_fulfilled,
            avg_order_value=excluded.avg_order_value, sessions=excluded.sessions,
            conversion_rate=excluded.conversion_rate,
            returning_customer_rate=excluded.returning_customer_rate,
            ad_spend=excluded.ad_spend, clicks=excluded.clicks, roas=excluded.roas,
            fetched_at=excluded.fetched_at`,
    args: [
      channel, date,
      result.totalSales ?? result.income ?? result.revenue ?? 0,
      result.ordersPlaced ?? result.orders ?? 0,
      result.grossSales ?? null, result.discounts ?? null,
      result.returns ?? null, result.netSales ?? null,
      result.shippingCharges ?? null, result.returnFees ?? null,
      result.taxes ?? null, result.ordersFulfilled ?? null,
      result.averageOrderValue ?? null, result.sessions ?? null,
      result.conversionRate ?? null, result.returningCustomerRate ?? null,
      result.adSpend ?? null, result.clicks ?? null, result.roas ?? null,
    ]
  });
}

/* ─── product rankings: replace the day's rows atomically ─────────────────── */
async function upsertRankings(channel, date, rankings) {
  // Guard: never wipe existing good rows on an empty/failed product scrape.
  if (!Array.isArray(rankings) || rankings.length === 0) return;
  await db.execute({
    sql: 'DELETE FROM product_rankings WHERE channel = ? AND entry_date = ?',
    args: [channel, date],
  });
  for (const r of rankings) {
    await db.execute({
      sql: `INSERT INTO product_rankings (channel, entry_date, rank, product_name, units, revenue, sku, fetched_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      args: [channel, date, r.rank, r.name, r.units ?? null, r.revenue ?? null, r.sku ?? null],
    });
  }
  console.log(`[Scrape] ${channel} rankings ✓ — ${rankings.length} products`);
}

/* ─── one date, all channels ─────────────────────────────────────────────── */
async function scrapeAndStore(id, scraper, date) {
  const result = await scraper.scrape(date);
  const revenue = result.totalSales ?? result.income ?? result.revenue ?? result.grossSales;
  const orders  = result.ordersPlaced ?? result.orders;
  // Store as long as we got a revenue figure. Previously we required orders too,
  // which dropped whole rows when Lazada's Key-Metrics carousel returned a null
  // order count (intermittent) — losing real revenue. Now revenue alone is enough;
  // a missing order count persists as 0 (upsertCache default) and is logged.
  if (revenue != null) {
    if (orders == null) {
      console.warn(`[Scrape] ${id} — order count unavailable, storing revenue only (orders=0).`);
    }
    await upsertCache(id, date, result);
    console.log(`[Scrape] ${id} ✓ — RM ${revenue} / ${orders ?? 0} orders`);
    await upsertRankings(id, date, result.productRankings);
    return true;
  }
  console.warn(`[Scrape] ${id} — could not parse data (no revenue). Raw:`, result.rawText?.slice(0, 300));
  return false;
}

async function runForDate(date) {
  console.log(`\n[Scrape] ===== ${date} =====`);
  let anySuccess = false;

  for (const { id, scraper } of SCRAPERS) {
    try {
      console.log(`[Scrape] ${id}...`);
      if (await scrapeAndStore(id, scraper, date)) anySuccess = true;
    } catch (err) {
      if (err.message?.startsWith('NOT_LOGGED_IN')) {
        // Try an unattended re-login (credentials in .env), then retry once.
        const { autoLogin } = require('./auto-login');
        if (await autoLogin(id)) {
          try {
            if (await scrapeAndStore(id, scraper, date)) anySuccess = true;
            continue;
          } catch (e2) {
            console.error(`[Scrape] ${id} retry after auto-login failed:`, e2.message);
          }
        }
        console.error(`[Scrape] ${id} — not logged in. Re-login with: npm run login  (log in to ${id}, press ENTER)`);
      } else if (err.message?.includes('remote debugging')) {
        console.error(`[Scrape] ${id} — browser launch problem. Try: npm run login`);
      } else {
        console.error(`[Scrape] ${id} error:`, err.message);
      }
    }
  }
  return anySuccess;
}

/* ─── heartbeat for dashboard staleness badge ────────────────────────────── */
async function writeHeartbeat() {
  try {
    const { setSetting } = require('../server/routes/settings');
    const r = await db.execute(
      'SELECT entry_date, revenue, orders FROM cached_data ORDER BY entry_date DESC LIMIT 1'
    );
    await setSetting('last_scrape', JSON.stringify({
      date:       r.rows[0]?.entry_date ?? null,
      revenue:    r.rows[0] ? +r.rows[0].revenue : null,
      orders:     r.rows[0] ? +r.rows[0].orders  : null,
      scraped_at: new Date().toISOString(),
    }));
  } catch (e) {
    console.warn('[Scrape] Could not write heartbeat:', e.message);
  }
}

/* ─── entry point ────────────────────────────────────────────────────────── */
async function runAll(arg1, arg2) {
  await init();

  let dates;
  if (arg1 && arg2) {
    // explicit inclusive range
    dates = [];
    for (let d = arg1; d <= arg2; d = addDays(d, 1)) dates.push(d);
    console.log(`[Scrape] Backfill range ${arg1} → ${arg2} (${dates.length} days)`);
  } else if (arg1) {
    dates = [arg1];
    console.log(`[Scrape] Single date ${arg1}`);
  } else {
    dates = await resolveSelfHealingDates();
    console.log(`[Scrape] Self-healing — ${dates.length} day(s): ${dates[0]}..${dates[dates.length - 1]}`);
  }

  const cdp = require('./cdp');
  let wroteAny = false;
  try {
    for (const date of dates) {
      if (await runForDate(date)) wroteAny = true;
    }
    // Only refresh the staleness heartbeat when real data landed. If every
    // channel failed (e.g. expired logins), leave the old heartbeat so the
    // dashboard's "data stale" badge surfaces the problem instead of hiding it.
    if (wroteAny) {
      await writeHeartbeat();
    } else {
      console.error('[Scrape] No channel produced data — heartbeat left untouched so the dashboard flags it. Re-login may be needed: node scrapers/login.js');
    }
  } finally {
    // Graceful close flushes cookies/sessions back to the profile on disk.
    await cdp.closeBrowser();
  }
  console.log(`\n[Scrape] Done. ${wroteAny ? '' : '(no data written)'}`);
}

module.exports = { runAll };

if (require.main === module) {
  // Force exit on completion. Playwright's persistent CDP connection and the
  // libSQL client keep open handles that otherwise leave the process alive
  // ("zombie node"), which holds Chrome resources and degrades later scrapes.
  runAll(process.argv[2], process.argv[3])
    .then(() => process.exit(0))
    .catch(err => { console.error(err); process.exit(1); });
}
