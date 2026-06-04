/**
 * Shopee gross-sales backfill from the Orders list.
 *
 * Why: Shopee Business Insights only exposes Real-Time / Yesterday / Past-7 / Past-30,
 * so historical per-day gross sales can't be read there (backfills froze to a
 * constant). The Orders list IS date-accurate — order_sn encodes the order date
 * (YYMMDD) and each order carries payment_info.total_price. We paginate all orders
 * back to a cutoff, bucket by date, and sum PAID orders (excluding cancelled/unpaid).
 *
 *   gross sales = sum of paid orders' sales value, by order date.
 *
 * Usage:  node scrapers/shopee-gross-backfill.js [sinceDate] [untilDate]
 *         defaults: since 2026-05-01, until = yesterday (MYT)
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { db, init } = require('../server/db');
const cdp = require('./cdp');

const SHOP_ID = 462723093;
const ORDER_URL = 'https://seller.shopee.com.my/portal/sale/order';

async function fetchOrderTotals(page, spc, cutoff) {
  return page.evaluate(async ({ spc, SHOP_ID, cutoff }) => {
    async function indexPage(n) {
      const r = await fetch(`/api/v3/order/search_order_list_index?SPC_CDS=${spc}&SPC_CDS_VER=2`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order_list_tab: 100, entity_type: 1,
          pagination: { from_page_number: 1, page_number: n, page_size: 40 },
          filter: { fulfillment_type: 0, is_drop_off: 0, fulfillment_source: 0, action_filter: 0 },
          sort: { sort_type: 3, ascending: false } }) });
      const j = await r.json(); return (j?.data?.index_list || []).map(o => o.order_id);
    }
    async function cards(ids) {
      const all = [];
      for (let i = 0; i < ids.length; i += 5) {            // 5 per call (endpoint limit)
        const chunk = ids.slice(i, i + 5);
        const r = await fetch(`/api/v3/order/get_order_list_card_list?SPC_CDS=${spc}&SPC_CDS_VER=2`, {
          method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ order_list_tab: 100, need_count_down_desc: false,
            order_param_list: chunk.map(id => ({ order_id: id, shop_id: SHOP_ID, region_id: 'MY' })) }) });
        const j = await r.json(); (j?.data?.card_list || []).forEach(c => all.push(c));
        await new Promise(r => setTimeout(r, 80));
      }
      return all;
    }
    const days = {}; let scanned = 0, oldest = null;
    for (let p = 1; p <= 120; p++) {
      const ids = await indexPage(p); if (!ids.length) break;
      const cl = await cards(ids);
      for (const c of cl) {
        const s = JSON.stringify(c);
        const sn = (s.match(/"order_sn":"([^"]+)"/) || [])[1]; if (!sn) continue;
        const price = +((s.match(/"total_price":(\d+)/) || [])[1] || 0);
        const desc = ((s.match(/"status_description":\{"[^"]*":"([^"]+)"/) || [])[1] || '').toLowerCase();
        const dt = `20${sn.slice(0,2)}-${sn.slice(2,4)}-${sn.slice(4,6)}`;
        oldest = dt; scanned++;
        const paid = !/cancel/.test(desc) && !/unpaid|to pay|to be paid/.test(desc);
        days[dt] = days[dt] || { gross: 0, orders: 0 };
        if (paid) { days[dt].gross += price / 100000; days[dt].orders++; }
      }
      if (oldest && oldest < cutoff) break;
    }
    return { days, scanned, oldest };
  }, { spc, SHOP_ID, cutoff });
}

async function main() {
  await init();
  const myt = new Date(Date.now() + 8 * 3600000);
  const yesterday = new Date(+myt - 86400000).toISOString().slice(0, 10);
  const since = process.argv[2] || '2026-05-01';
  const until = process.argv[3] || yesterday;

  const { page } = await cdp.newPage();
  let spc = null;
  page.on('request', req => { const m = req.url().match(/[?&]SPC_CDS=([^&]+)/); if (m && req.url().includes('/api/v3/order/')) spc = m[1]; });

  try {
    await page.goto(ORDER_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(6000);
    if (page.url().includes('/login')) throw new Error('NOT_LOGGED_IN: log in to Shopee.');
    if (!spc) throw new Error('Could not capture SPC_CDS token.');

    console.log(`[ShopeeGross] Fetching orders back to ${since}...`);
    const { days, scanned, oldest } = await fetchOrderTotals(page, spc, since);
    console.log(`[ShopeeGross] Scanned ${scanned} orders (oldest ${oldest}).`);

    let updated = 0;
    for (const d of Object.keys(days).sort()) {
      if (d < since || d > until) continue;
      const { gross, orders } = days[d];
      const r = await db.execute({
        sql: `UPDATE cached_data SET gross_sales = ?, orders = ?
              WHERE channel = 'shopee' AND entry_date = ?`,
        args: [+gross.toFixed(2), orders, d],
      });
      if (r.rowsAffected > 0) { updated++; console.log(`  ${d}: RM${gross.toFixed(2)} / ${orders} orders ✓`); }
      else console.log(`  ${d}: RM${gross.toFixed(2)} / ${orders} orders — (no cached_data row to update)`);
    }
    console.log(`[ShopeeGross] Updated ${updated} day(s).`);
  } finally {
    await page.close();
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
