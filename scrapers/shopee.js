/**
 * Shopee Seller Centre scraper — scrapes Business Insight for daily metrics.
 *
 * Requires the always-on Chrome to be running:  npm run start-browser
 * Log in to Shopee in that browser once — sessions persist indefinitely.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const cdp = require('./cdp');

const HOME_URL    = 'https://seller.shopee.com.my/';
const INSIGHT_URL = 'https://seller.shopee.com.my/datacenter/';

/* ─── date selection ─────────────────────────────────────────────────────── */
async function selectDate(page, targetDate) {
  const myt       = new Date(Date.now() + 8 * 3600000);
  const yesterday = new Date(+myt - 86400000).toISOString().slice(0, 10);

  try {
    if (targetDate === yesterday) {
      const clicked = await page.evaluate(() => {
        for (const el of document.querySelectorAll('div, span, button, li')) {
          if (el.textContent?.trim() === 'Yesterday' && !el.querySelector('*')) {
            el.click(); return true;
          }
        }
        for (const el of document.querySelectorAll('*')) {
          if (el.childElementCount === 0 && el.textContent?.trim() === 'Yesterday') {
            el.click(); return true;
          }
        }
        return false;
      });
      if (clicked) {
        await page.waitForTimeout(2000);
        return;
      }
    }

    // For non-yesterday dates: open picker and select from calendar
    const opened = await page.evaluate(() => {
      for (const el of document.querySelectorAll('*')) {
        if (el.childElementCount === 0 && /Real-Time|Yesterday|Past \d+ Days/i.test(el.textContent?.trim())) {
          el.click(); return true;
        }
      }
      return false;
    });
    if (!opened) return;
    await page.waitForTimeout(600);

    const [, , day] = targetDate.split('-').map(Number);
    await page.evaluate((d) => {
      for (const el of document.querySelectorAll('td, [class*="day"], [class*="Day"]')) {
        if (el.childElementCount === 0 && el.textContent?.trim() === String(d)) {
          el.click(); return true;
        }
      }
      return false;
    }, day);
    await page.waitForTimeout(400);

    await page.evaluate((d) => {
      for (const el of document.querySelectorAll('td, [class*="day"], [class*="Day"]')) {
        if (el.childElementCount === 0 && el.textContent?.trim() === String(d)) {
          el.click(); return true;
        }
      }
      return false;
    }, day);

    await page.evaluate(() => {
      for (const btn of document.querySelectorAll('button')) {
        const t = btn.textContent?.trim();
        if (t === 'Apply' || t === 'Confirm' || t === 'OK') { btn.click(); return true; }
      }
      return false;
    });
    await page.waitForTimeout(2000);
  } catch (_) {
    // Date selection failed — proceed with default shown
  }
}

/* ─── order type selection ───────────────────────────────────────────────── */
async function selectOrderType(page) {
  const clicked = await page.evaluate(() => {
    for (const el of document.querySelectorAll('div, span, button, li')) {
      if (el.childElementCount === 0 && el.textContent?.trim() === 'Paid Order') {
        el.click(); return true;
      }
    }
    return false;
  });
  if (clicked) {
    await page.waitForTimeout(2000);
    console.log('[Shopee] Order type → Paid Order');
  } else {
    console.warn('[Shopee] Could not find Paid Order option');
  }
}

/* ─── Ad spend from Shopee Ads (PAS) report API ─────────────────────────── */
const PAS_BASE_URL = 'https://seller.shopee.com.my/portal/marketing/pas/index';

async function scrapeAdSpend(page, date) {
  try {
    const [yr, mo, dy] = date.split('-').map(Number);
    const dayStartMYT  = Date.UTC(yr, mo - 1, dy, 0, 0, 0) - 8 * 3600000;
    const tstStart     = Math.floor(dayStartMYT / 1000);
    const tstEnd       = tstStart + 86400 - 1;

    const pasUrl = `${PAS_BASE_URL}?from=${tstStart}&to=${tstEnd}`;
    await page.goto(pasUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);
    console.log('[Shopee] PAS URL:', page.url());
    await page.waitForTimeout(1000);

    const rawTotal = await page.evaluate(async ({ tstStart, tstEnd }) => {
      const csrf = document.cookie.match(/csrftoken=([^;]+)/)?.[1] || '';
      const resp = await fetch('/api/pas/v1/report/get_time_graph/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-csrftoken': csrf },
        body: JSON.stringify({
          agg_interval:  1,
          campaign_type: 'new_cpc_homepage',
          start_time:    tstStart,
          end_time:      tstEnd,
        }),
      });
      const data = await resp.json();
      if (data.code !== 0) {
        console.error('[PAS API] code:', data.code, data.msg);
        return null;
      }
      const items = data.data?.report_by_time || [];
      return items.reduce((s, i) => s + (i.metrics?.cost || 0), 0);
    }, { tstStart, tstEnd });

    if (rawTotal == null) return null;
    return rawTotal / 100000;
  } catch (err) {
    console.warn('[Shopee] Ad spend scrape failed:', err.message);
    return null;
  }
}

/* ─── Daily income from Finance > My Income ─────────────────────────────── */
const FINANCE_URL = 'https://seller.shopee.com.my/portal/finance/income';

async function handleFinancePin(page, pin) {
  const pwInput = await page.$('input[type="password"]');
  if (!pwInput || !pin) return;
  console.log('[Shopee] Finance — entering payment password');
  await pwInput.fill(pin);
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    for (const btn of document.querySelectorAll('button'))
      if (btn.textContent?.trim() === 'Verify') { btn.click(); return; }
  });
  await page.waitForTimeout(3000);
}

async function scrapeIncome(page, date) {
  const pin = process.env.SHOPEE_FINANCE_PIN;
  try {
    await page.goto(FINANCE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
    await page.waitForTimeout(2000);
    await handleFinancePin(page, pin);
    await page.waitForTimeout(2000);

    console.log('[Shopee] Finance URL after verify:', page.url());

    const INCOME_DETAIL_PATH = '/api/v4/accounting/pc/seller_income/income_overview/get_income_detail';

    const rawTotal = await page.evaluate(async ({ targetDate, apiPath }) => {
      const csrfToken = document.cookie.match(/csrftoken=([^;]+)/)?.[1] || '';
      let total = 0;
      let cursor = null;
      let iters  = 0;

      do {
        const body = {
          source_type: 0,
          income_category: 2,
          pagination_info: {
            direction: 0,
            limit: 100,
            ...(cursor ? { cursor } : {}),
          },
          local_query_condition: {
            start_date: targetDate,
            end_date:   targetDate,
          },
        };

        const resp = await fetch(apiPath, {
          method:  'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-csrftoken': csrfToken,
          },
          body: JSON.stringify(body),
        });
        const data = await resp.json();
        if (data.code !== 0) {
          console.error('[Finance API] code:', data.code, data.message);
          break;
        }

        const list = data.data?.list || [];
        for (const item of list) {
          total += (item.local_income_detail?.income_amount || 0);
        }

        const nextPage = data.data?.next_page;
        cursor = (list.length === 100 && nextPage?.cursor) ? nextPage.cursor : null;
        iters++;
      } while (cursor && iters < 20);

      return total;
    }, { targetDate: date, apiPath: INCOME_DETAIL_PATH });

    const income = rawTotal / 100000;
    console.log('[Shopee] Finance income from API:', income, '(raw units:', rawTotal, ')');
    return income > 0 ? income : null;
  } catch (err) {
    console.warn('[Shopee] Income scrape failed:', err.message);
    return null;
  }
}

/* ─── Dashboard APIs (key metrics + product rankings) ─────────────────────── */
// The datacenter/overview dashboard is backed by /api/mydata/v3/dashboard/* APIs
// that take a unix day range. This is far more reliable than scraping the page
// text (which intermittently returned nothing for older dates). A single past day
// is period=day with start=MYT-midnight and end=NEXT-day-midnight (exclusive end).

function dayRangeUnix(date) {
  const [y, m, d] = date.split('-').map(Number);
  const start = Math.floor(Date.UTC(y, m - 1, d) / 1000) - 28800; // 00:00 MYT
  return { start, end: start + 86400 };                            // exclusive end
}

// Shopee's dashboard API rejects period=day for YESTERDAY (the most recent
// complete day) with code 60001 — yesterday must use period=yesterday_realtime.
// Older days use period=day. (yesterday_realtime ignores the date range and
// always returns yesterday, so it must NOT be used for older days.)
function shopeePeriod(date) {
  const yesterday = new Date(Date.now() + 8 * 3600000 - 86400000).toISOString().slice(0, 10);
  return date === yesterday ? 'yesterday_realtime' : 'day';
}

// Orders / gross / visitors / AOV / conversion for the day, from the API.
async function scrapeKeyMetrics(page, date, spc) {
  if (!spc) { console.warn('[Shopee] No SPC_CDS — cannot fetch key metrics'); return {}; }
  const { start, end } = dayRangeUnix(date);
  const period = shopeePeriod(date);
  const r = await page.evaluate(async ({ spc, start, end, period }) => {
    const url = `/api/mydata/v3/dashboard/key-metrics/?SPC_CDS=${spc}&SPC_CDS_VER=2`
      + `&start_time=${start}&end_time=${end}&period=${period}&fetag=fetag`;
    try { const j = await fetch(url, { credentials: 'include' }).then(r => r.json()); return j.code === 0 ? j.result : { __err: j.code }; }
    catch (e) { return { __err: e.message }; }
  }, { spc, start, end, period });

  if (!r || r.__err != null) { console.warn('[Shopee] key-metrics API failed:', r && r.__err); return {}; }
  const v = k => (r[k] && typeof r[k].value === 'number') ? r[k].value : null;
  const convRatio = v('shop_uv_to_paid_buyers_rate'); // API returns a 0..1 ratio
  return {
    grossSales:        v('paid_gmv'),
    orders:            v('paid_orders'),
    sessions:          v('shop_uv'),
    clicks:            v('product_clicks'),
    averageOrderValue: v('paid_sales_per_order'),
    conversionRate:    convRatio != null ? +(convRatio * 100).toFixed(2) : null,
  };
}

// Top products by paid units for the day. paid (not confirmed) so it reflects
// the day's actual sales; confirmed_* lags and read 0 for recent days.
async function scrapeProductRankings(page, date, spc) {
  try {
    if (!spc) { console.warn('[Shopee] No SPC_CDS — skipping product rankings'); return []; }
    const { start, end } = dayRangeUnix(date);
    const period = shopeePeriod(date);
    const items = await page.evaluate(async ({ spc, start, end, period }) => {
      const url = `/api/mydata/v3/dashboard/product-rankings/?SPC_CDS=${spc}&SPC_CDS_VER=2`
        + `&start_time=${start}&end_time=${end}&period=${period}`
        + `&category_type=shopee&category_id=-1&page_size=20&page_num=1`
        + `&order_type=paid&order_by=paid_units.desc`;
      try { const r = await fetch(url, { credentials: 'include' }); const j = await r.json(); return j?.result?.items || null; }
      catch (_) { return null; }
    }, { spc, start, end, period });

    if (!items) { console.warn('[Shopee] Product rankings fetch failed'); return []; }

    const ranked = items
      .map(it => ({
        name:    it.name || '(unknown)',
        sku:     it.id != null ? String(it.id) : null,
        units:   Math.round(Number(it.paid_units) || 0),
        revenue: Number(it.paid_sales) || 0,
      }))
      .filter(p => p.units > 0)
      .sort((a, b) => b.units - a.units || b.revenue - a.revenue)
      .slice(0, 10)
      .map((p, i) => ({ rank: i + 1, ...p }));

    console.log(`[Shopee] Product rankings for ${date}: ${ranked.length} products`);
    return ranked;
  } catch (e) {
    console.warn('[Shopee] Product rankings failed:', e.message);
    return [];
  }
}

/* ─── scrape ─────────────────────────────────────────────────────────────── */
async function scrape(date) {
  const { page } = await cdp.newPage();

  // Capture the SPC_CDS session token from any Shopee API request during the
  // whole scrape — far more reliable than a short window on one page.
  let spcCds = null;
  page.on('request', (req) => {
    const mm = req.url().match(/[?&]SPC_CDS=([^&]+)/);
    if (mm && req.url().includes('seller.shopee.com.my')) spcCds = mm[1];
  });

  try {
    // Load home first to establish SPA context.
    // Use domcontentloaded — Shopee has persistent WebSocket/polling that prevents networkidle.
    await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    // Check if logged in
    if (page.url().includes('/login') || page.url().includes('/accounts.shopee')) {
      throw new Error('NOT_LOGGED_IN: Open the scraper browser and log in to Shopee.');
    }

    // Visit the overview dashboard so its mydata APIs (and the SPC_CDS token) are
    // available, then read the day's metrics straight from the API — no fragile
    // date-picker / DOM scraping.
    await page.goto(INSIGHT_URL + 'overview', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(4000);
    console.log('[Shopee] On page:', page.url());

    const data = await scrapeKeyMetrics(page, date, spcCds);
    console.log(`[Shopee] Key metrics for ${date}: orders=${data.orders}, gross=${data.grossSales}, visitors=${data.sessions}, aov=${data.averageOrderValue}, cvr=${data.conversionRate}`);

    console.log('[Shopee] Scraping ad spend...');
    const adSpend = await scrapeAdSpend(page, date);
    console.log('[Shopee] Ad spend:', adSpend);

    console.log('[Shopee] Scraping daily income...');
    const totalIncome = await scrapeIncome(page, date);
    console.log('[Shopee] Daily income:', totalIncome);

    const productRankings = await scrapeProductRankings(page, date, spcCds);

    return {
      ...data,
      income: totalIncome,
      adSpend,
      productRankings,
    };
  } finally {
    await page.close(); // close tab only — never close the browser
  }
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
