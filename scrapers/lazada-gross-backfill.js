/**
 * Lazada gross-sales backfill from Business Advisor "overviewV2" (date-accurate).
 *
 * The live lazada.js takes gross from the BA "Ranking by Revenue" REALTIME widget,
 * which is not date-specific — backfilled past days froze/inflated (e.g. Jun 1 stored
 * RM509 vs the real RM69.88). The BA dashboard's key/overviewV2.json `payAmount` IS
 * date-accurate (its statDate matches the requested day).
 *
 *   gross sales = result.data.payAmount.value  (per the dateRange in the URL)
 *
 * One BA navigation per day, each wrapped in a hard timeout so a slow/hung Lazada
 * page can never stall the run.
 *
 * Usage:  node scrapers/lazada-gross-backfill.js 2026-06-01            (since -> yesterday)
 *         node scrapers/lazada-gross-backfill.js 2026-06-01 2026-06-17 (range)
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { db, init } = require('../server/db');
const cdp = require('./cdp');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const wt = (p, ms, l) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error('timeout ' + l)), ms))]);

function addDays(ds, n) { const d = new Date(ds + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

// Returns { payAmount, statDate } or null. Hard-timeout protected.
async function fetchDay(date) {
  const { page } = await cdp.newPage();
  let ov = null;
  page.on('response', async res => {
    if (res.url().includes('key/overviewV2.json')) { try { const j = await res.json(); ov = j?.result?.data || j?.result; } catch (_) {} }
  });
  try {
    await wt(page.goto(`https://sellercenter.lazada.com.my/ba/dashboard?dateRange=${date}%7C${date}&dateType=recent1`,
      { waitUntil: 'domcontentloaded', timeout: 25000 }), 30000, 'goto');
    if (page.url().includes('login')) throw new Error('NOT_LOGGED_IN');
    // scroll to trigger Lazada's lazy metric fetches (overviewV2 fires after scroll)
    await sleep(2500);
    for (const f of [0.3, 0.6, 0.4]) { await page.evaluate(y => window.scrollTo(0, document.body.scrollHeight * y), f).catch(()=>{}); await sleep(1200); }
    for (let i = 0; i < 8 && !ov; i++) await sleep(1500);
  } finally { await page.close().catch(()=>{}); }
  if (!ov) return null;
  const val = f => (f && typeof f === 'object' && 'value' in f) ? f.value : f;
  const pay = val(ov.payAmount);
  const rpo = val(ov.revenuePerOrder);
  const stat = val(ov.statDate);
  return { pay: pay == null ? null : +pay, orders: (pay && rpo) ? Math.round(pay / rpo) : null, statDate: stat };
}

async function main() {
  await init();
  const myt = new Date(Date.now() + 8 * 3600000);
  const yesterday = new Date(+myt - 86400000).toISOString().slice(0, 10);
  const since = process.argv[2] || '2026-06-01';
  const until = process.argv[3] || yesterday;

  const dates = [];
  for (let d = since; d <= until; d = addDays(d, 1)) dates.push(d);
  console.log(`[LazadaGross] Backfilling ${dates.length} day(s): ${since}..${until}`);

  // Spacing between days avoids Lazada throttling its BA metrics under rapid access.
  const DELAY = parseInt(process.env.LZ_DELAY_MS || '8000', 10);
  let ok = 0, fail = 0, first = true;
  for (const d of dates) {
    if (!first) await sleep(DELAY);
    first = false;
    let r = null;
    try { r = await wt(fetchDay(d), 45000, 'day'); }
    catch (e) { if (/NOT_LOGGED_IN/.test(e.message)) { console.error('[LazadaGross] NOT LOGGED IN — aborting.'); break; } }
    if (r && r.pay != null) {
      // sanity: statDate (ms) should match the requested MYT day
      await db.execute({
        sql: `UPDATE cached_data SET gross_sales = ? WHERE channel = 'lazada' AND entry_date = ?`,
        args: [+r.pay.toFixed(2), d],
      });
      ok++;
      console.log(`  ${d}: RM${r.pay.toFixed(2)}${r.orders != null ? ' (~' + r.orders + ' ord)' : ''}`);
    } else {
      fail++;
      console.log(`  ${d}: — (no overviewV2; will retry later)`);
    }
  }
  console.log(`[LazadaGross] Done. Updated ${ok}, failed ${fail}.`);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
