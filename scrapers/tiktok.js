/**
 * TikTok Shop scraper — scrapes Analytics > Overview for daily GMV, orders, and visitors.
 *
 * Requires the always-on Chrome to be running:  npm run start-browser
 * Log in to TikTok Seller Centre in that browser once — sessions persist.
 *
 * Strategy:
 *   1. Set up API response listener BEFORE navigating (to catch initial page load response)
 *   2. Navigate to compass/data-overview — page auto-loads "yesterday" data via us_overview_stats
 *   3. If the initial response matches the target date → done
 *   4. Otherwise open the arco-picker date calendar and click the target date twice
 *   5. Parse metrics: GMV (pay_amt), orders (pay_main_order_cnt), visitors (product_page_show_ucnt)
 *
 * Date API format: start_date is "YYYY-MM-DD" (date only, no time).
 * Exclusive end: clicking May 26 → {start_date:"2026-05-26", end_date:"2026-05-27"}
 */
const cdp = require('./cdp');

const BASE_URL = 'https://seller-my.tiktok.com';

async function _scrapeImpl(date) {
  const { page } = await cdp.newPage();

  try {
    page.setDefaultTimeout(45000);

    const [year, month, day] = date.split('-').map(Number);

    // ── Set up listener BEFORE goto so we catch the initial page-load response ─
    let statsResolve, statsReject;
    const statsPromise = new Promise((res, rej) => {
      statsResolve = res;
      statsReject  = rej;
    });

    const onResponse = async (res) => {
      if (!res.url().includes('us_overview_stats')) return;
      try {
        const json = await res.json().catch(() => null);
        if (!json?.data) return;
        const interval = json.data[0]?.intervals?.[0];
        if (!interval) return;
        // Match target date (API uses exclusive end: start_date === our target date)
        if (interval.start_date === date) {
          statsResolve(interval);
        }
      } catch (_) {}
    };
    page.on('response', onResponse);

    // ── Navigate ──────────────────────────────────────────────────────────────
    // domcontentloaded, NOT networkidle — TikTok runs constant background polling
    // so networkidle frequently never fires and the goto times out.
    await page.goto(`${BASE_URL}/compass/data-overview?shop_region=MY`, {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });

    if (page.url().includes('login') || page.url().includes('passport')) {
      throw new Error('NOT_LOGGED_IN: Open the scraper browser and log in to TikTok Seller Centre.');
    }

    console.log('[TikTok] Loaded:', page.url());
    await page.waitForTimeout(3000);

    // ── Check if initial page load already delivered the target date ───────────
    // Give it 1s to settle — if the default "yesterday" happens to be our date,
    // statsPromise may already be resolved.
    const alreadyResolved = await Promise.race([
      statsPromise.then(() => true),
      new Promise(r => setTimeout(() => r(false), 1500)),
    ]);

    if (!alreadyResolved) {
      // Need to use the date picker
      console.log('[TikTok] Opening date picker for', date);
      await page.click('.arco-picker');
      await page.waitForTimeout(1500);

      // ── Navigate calendar to correct month ──────────────────────────────────
      // Header icons (Arco): double-left = prev YEAR, left = prev MONTH,
      // right = next MONTH, double-right = next YEAR. We MUST target the
      // single-month arrows by their svg icon class — selecting by position
      // hits the prev/next-YEAR arrow and silently jumps 12 months.
      for (let attempt = 0; attempt < 24; attempt++) {
        const headers = await page.evaluate(() =>
          Array.from(document.querySelectorAll('.arco-picker-header-label'))
            .map(el => parseInt(el.textContent.trim(), 10))
        );
        // headers = [leftMonth, leftYear, rightMonth, rightYear]
        const leftMonth = headers[0];
        const leftYear  = headers[1];
        if (leftYear === year && leftMonth === month) break;

        const target  = year * 12 + (month - 1);
        const current = leftYear * 12 + (leftMonth - 1);
        const dir = target < current ? 'prev' : 'next';

        const moved = await page.evaluate((dir) => {
          // '.arco-icon-left' matches ONLY the single-month arrow, not
          // '.arco-icon-double-left' (different class token = the year arrow).
          const want = dir === 'prev' ? '.arco-icon-left' : '.arco-icon-right';
          const icons = Array.from(document.querySelectorAll(
            '.arco-picker-header-icon:not(.arco-picker-header-icon-hidden)'
          ));
          const btn = icons.find(ic => ic.querySelector(want));
          if (!btn) return false;
          btn.click();
          return true;
        }, dir);

        if (!moved) break;
        await page.waitForTimeout(500);
      }

      // ── Click target day twice (start = end = single-day range) ─────────────
      const clickDay = async (d) => page.evaluate((targetDay) => {
        const cells = Array.from(document.querySelectorAll('.arco-picker-cell'));
        // Left pane = first 42 cells, right pane = next 42. Check both.
        const allInView = [...cells.slice(0, 84)].filter(c =>
          c.classList.contains('arco-picker-cell-in-view') &&
          !c.classList.contains('arco-picker-cell-disabled')
        );
        const target = allInView.find(c =>
          c.querySelector('.arco-picker-date-value')?.textContent.trim() === String(targetDay)
        );
        if (!target) return 'not-found:' + targetDay;
        target.click();
        return 'ok:' + targetDay;
      }, d);

      const r1 = await clickDay(day);
      console.log('[TikTok] Clicked start:', r1);
      if (!r1.startsWith('ok')) throw new Error(`[TikTok] Start day click failed: ${r1}`);

      await page.waitForTimeout(700);

      const r2 = await clickDay(day);
      console.log('[TikTok] Clicked end:', r2);
      if (!r2.startsWith('ok')) throw new Error(`[TikTok] End day click failed: ${r2}`);
    } else {
      console.log('[TikTok] Date matched initial page load response');
    }

    // ── Wait for stats API (30s window) ───────────────────────────────────────
    const interval = await Promise.race([
      statsPromise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('[TikTok] Stats API timed out after 30s')), 30000)
      ),
    ]);

    page.off('response', onResponse);
    console.log('[TikTok] Stats received for', interval.start_date, '-', interval.end_date);

    // ── Parse metrics ─────────────────────────────────────────────────────────
    const vals = interval.rows?.[0]?.values || {};

    function parseVal(key) {
      const v = vals[key];
      if (v === undefined || v === null || v === '') return null;
      if (typeof v === 'number') return v;
      if (typeof v === 'string') {
        try {
          const parsed = JSON.parse(v);
          const raw = parsed.amount ?? parsed.value;
          const n = parseFloat(raw);
          return isNaN(n) ? null : n;
        } catch (_) {
          const n = parseFloat(v);
          return isNaN(n) ? null : n;
        }
      }
      return null;
    }

    // Named keys (stable) with numeric metric ID fallbacks
    const gmv      = parseVal('pay_amt')                 ?? parseVal('4024');
    const orders   = parseVal('pay_main_order_cnt')      ?? parseVal('4027');
    const visitors = parseVal('product_page_show_ucnt')  ?? parseVal('6070');
    const aov      = parseVal('aov')                     ?? parseVal('8024');

    console.log(`[TikTok] Scraped for ${date}: gmv=${gmv}, orders=${orders}, visitors=${visitors}, aov=${aov}`);

    // ── Product rankings (units sold) ─────────────────────────────────────────
    const productRankings = await fetchProductRankings(page, date);

    return {
      totalSales:       gmv,
      grossSales:       gmv,
      orders:           orders  !== null ? Math.round(orders)   : null,
      sessions:         visitors !== null ? Math.round(visitors) : null,
      averageOrderValue: aov,
      productRankings,
      url:              page.url(),
    };

  } finally {
    await page.close();
  }
}

/**
 * Top products by units sold for a single day.
 * The product-analysis page takes the date range directly in the URL
 * (timeRange=YYYY-MM-DD|YYYY-MM-DD), so no calendar interaction is needed.
 * We intercept /insights/seller/ttp/product/list and read stats_v3.total.items_sold.
 * Returns [{rank, name, units, revenue, sku}] sorted by units desc (units > 0 only).
 */
async function fetchProductRankings(page, date) {
  try {
    let resolveList;
    const listPromise = new Promise(res => { resolveList = res; });
    const onList = async (res) => {
      if (!res.url().includes('/insights/seller/ttp/product/list')) return;
      try {
        const j = await res.json().catch(() => null);
        if (j?.data?.items) resolveList(j.data.items);
      } catch (_) {}
    };
    page.on('response', onList);

    await page.goto(
      `${BASE_URL}/compass/product-analysis?shop_region=MY&timeRange=${date}%7C${date}`,
      { waitUntil: 'domcontentloaded', timeout: 45000 }
    );

    const items = await Promise.race([
      listPromise,
      new Promise(res => setTimeout(() => res(null), 20000)),
    ]);
    page.off('response', onList);

    if (!items) {
      console.warn('[TikTok] Product list not captured for', date);
      return [];
    }

    const num = (v) => {
      if (v == null) return null;
      if (typeof v === 'object') { const n = parseFloat(v.amount_delimited ?? v.amount); return isNaN(n) ? null : n; }
      const n = parseFloat(v); return isNaN(n) ? null : n;
    };

    const ranked = items
      .map(it => ({
        name:    it.meta?.product_name || '(unknown)',
        sku:     it.meta?.product_id || null,
        units:   Math.round(num(it.stats_v3?.total?.items_sold) || 0),
        revenue: num(it.stats_v3?.total?.gmv) || 0,
      }))
      .filter(p => p.units > 0)
      .sort((a, b) => b.units - a.units || b.revenue - a.revenue)
      .slice(0, 10)
      .map((p, i) => ({ rank: i + 1, ...p }));

    console.log(`[TikTok] Product rankings for ${date}: ${ranked.length} products`);
    return ranked;
  } catch (e) {
    console.warn('[TikTok] Product rankings failed:', e.message);
    return [];
  }
}

// Public entry point with 7-minute hard timeout
async function scrape(date) {
  return Promise.race([
    _scrapeImpl(date),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('TikTok scrape timed out after 7 minutes')), 420000)
    ),
  ]);
}

module.exports = { scrape };

/* ─── CLI ────────────────────────────────────────────────────────────────── */
if (require.main === module) {
  const myt       = new Date(Date.now() + 8 * 3600000);
  const yesterday = new Date(+myt - 86400000).toISOString().slice(0, 10);
  scrape(process.argv[2] || yesterday)
    .then(d => console.log(JSON.stringify(d, null, 2)))
    .catch(console.error);
}
