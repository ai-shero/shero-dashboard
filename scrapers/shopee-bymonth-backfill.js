/**
 * Shopee gross-sales + orders backfill from Business Insights "By Month".
 *
 * This is Shopee's AUTHORITATIVE figure — the headline "Sales" (Paid Order) you
 * see in Business Insights > Overview > By Month. The realtime endpoints only
 * return today's data, and order-list totals are the post-rebate amount; this
 * By-Month key-metrics call returns pre-rebate gross (paid_gmv) per day.
 *
 * Endpoint:  /api/mydata/v3/dashboard/key-metrics/?period=month&start_time&end_time
 *   paid_gmv.value           = the month's "Sales" total (matches Shopee exactly)
 *   paid_gmv.points[]        = daily Sales (timestamps are MYT day-starts)
 *   paid_orders.value/points = paid order count, monthly + daily
 *
 * Usage:  node scrapers/shopee-bymonth-backfill.js 2026-05            (one month)
 *         node scrapers/shopee-bymonth-backfill.js 2026-05 2026-06    (range, inclusive)
 *         node scrapers/shopee-bymonth-backfill.js                    (current month)
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { db, init } = require('../server/db');
const cdp = require('./cdp');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// MYT date label for a unix-second day-start (timestamps come back as MYT 00:00)
const mytLabel = ts => new Date((ts + 8 * 3600) * 1000).toISOString().slice(0, 10);

async function fetchMonth(page, spc, y, m) {
  const start = Math.floor(Date.UTC(y, m - 1, 1, -8, 0, 0) / 1000);
  const end   = Math.floor(Date.UTC(y, m, 1, -8, 0, 0) / 1000);
  return page.evaluate(async ({ spc, start, end }) => {
    const url = `/api/mydata/v3/dashboard/key-metrics/?SPC_CDS=${spc}&SPC_CDS_VER=2&start_time=${start}&end_time=${end}&period=month&fetag=fetag`;
    const r = await fetch(url, { credentials: 'include' }); const j = await r.json();
    const g = j?.result?.paid_gmv, o = j?.result?.paid_orders;
    return {
      code: j.code,
      grossTotal: g?.value,
      ordersTotal: o?.value,
      gross: (g?.points || []).map(p => ({ ts: p.timestamp, v: p.value })),
      orders: (o?.points || []).map(p => ({ ts: p.timestamp, v: p.value })),
    };
  }, { spc, start, end });
}

async function main() {
  await init();
  const myt = new Date(Date.now() + 8 * 3600000);
  const curMonth = myt.toISOString().slice(0, 7);
  const since = process.argv[2] || curMonth;
  const until = process.argv[3] || since;

  // build month list
  const months = [];
  let [sy, sm] = since.split('-').map(Number);
  const [uy, um] = until.split('-').map(Number);
  while (sy < uy || (sy === uy && sm <= um)) { months.push([sy, sm]); sm++; if (sm > 12) { sm = 1; sy++; } }

  const { page } = await cdp.newPage();
  let spc = null;
  page.on('request', req => { const mm = req.url().match(/[?&]SPC_CDS=([^&]+)/); if (mm && req.url().includes('/api/mydata/')) spc = mm[1]; });

  try {
    await page.goto('https://seller.shopee.com.my/datacenter/overview', { waitUntil: 'domcontentloaded', timeout: 30000 });
    for (let i = 0; i < 20 && !spc; i++) await sleep(1500);
    if (page.url().includes('/login')) throw new Error('NOT_LOGGED_IN: log in to Shopee.');
    if (!spc) throw new Error('Could not capture SPC_CDS token.');

    const yesterday = new Date(+myt - 86400000).toISOString().slice(0, 10);
    for (const [y, m] of months) {
      const label = `${y}-${String(m).padStart(2, '0')}`;
      const r = await fetchMonth(page, spc, y, m);
      if (r.code !== 0 || !r.gross.length) { console.log(`[Shopee] ${label}: no data (code ${r.code})`); continue; }
      console.log(`\n[Shopee] ${label}: Sales RM${(+r.grossTotal).toFixed(2)} / ${r.ordersTotal} orders`);

      // index orders points by MYT date for lookup
      const ordersByDate = {};
      r.orders.forEach(p => { ordersByDate[mytLabel(p.ts)] = Math.round(+p.v); });

      let updated = 0;
      for (const p of r.gross) {
        const d = mytLabel(p.ts);
        if (d.slice(0, 7) !== label) continue;        // ignore stray edge point
        if (d > yesterday) continue;                  // skip today / incomplete
        const gross = +(+p.v).toFixed(2);
        const orders = ordersByDate[d] ?? null;
        const res = await db.execute({
          sql: `UPDATE cached_data SET gross_sales = ?, orders = COALESCE(?, orders)
                WHERE channel = 'shopee' AND entry_date = ?`,
          args: [gross, orders, d],
        });
        if (res.rowsAffected > 0) updated++;
        else {
          // no row yet (e.g. a day we never scraped) — insert a minimal one
          await db.execute({
            sql: `INSERT OR IGNORE INTO cached_data (channel, entry_date, revenue, orders, gross_sales, fetched_at)
                  VALUES ('shopee', ?, 0, ?, ?, datetime('now'))`,
            args: [d, orders ?? 0, gross],
          });
          updated++;
        }
      }
      console.log(`[Shopee] ${label}: updated ${updated} day(s).`);
    }
  } finally {
    await page.close();
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
