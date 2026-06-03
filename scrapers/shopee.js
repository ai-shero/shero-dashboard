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

/* ─── product rankings (units sold) ──────────────────────────────────────── */
// Business Insights → Product Performance. The /api/mydata/v4/product/performance/
// endpoint is date-filterable via unix start/end, so we grab the session token
// (SPC_CDS) from the page then fetch the target day directly. paid_units = units sold.
async function scrapeProductRankings(page, date) {
  try {
    const [y, m, d] = date.split('-').map(Number);
    const start = Math.floor(Date.UTC(y, m - 1, d, -8, 0, 0) / 1000); // 00:00 MYT
    const end = start + 86399;

    let spc = null;
    const onReq = (req) => {
      const mm = req.url().match(/[?&]SPC_CDS=([^&]+)/);
      if (mm && req.url().includes('/api/mydata/')) spc = mm[1];
    };
    page.on('request', onReq);
    await page.goto('https://seller.shopee.com.my/datacenter/product/performance',
      { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(5000);
    page.off('request', onReq);

    if (!spc) { console.warn('[Shopee] No SPC_CDS — skipping product rankings'); return []; }

    const items = await page.evaluate(async ({ spc, start, end }) => {
      const url = `/api/mydata/v4/product/performance/?SPC_CDS=${spc}&SPC_CDS_VER=2`
        + `&start_time=${start}&end_time=${end}&period=real_time&keyword=`
        + `&category_type=shopee&category_id=-1&page_size=50&page_num=1`
        + `&order_type=confirmed&order_by=confirmed_sales.desc`;
      try { const r = await fetch(url, { credentials: 'include' }); const j = await r.json(); return j?.result?.items || null; }
      catch (_) { return null; }
    }, { spc, start, end });

    if (!items) { console.warn('[Shopee] Product performance fetch failed'); return []; }

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

  try {
    // Load home first to establish SPA context.
    // Use domcontentloaded — Shopee has persistent WebSocket/polling that prevents networkidle.
    await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    // Check if logged in
    if (page.url().includes('/login') || page.url().includes('/accounts.shopee')) {
      throw new Error('NOT_LOGGED_IN: Open the scraper browser and log in to Shopee.');
    }

    await page.goto(INSIGHT_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
    console.log('[Shopee] On page:', page.url());

    // Wait for Key Metrics section
    try {
      await page.waitForFunction(
        () => document.body.innerText.includes('Key Metrics'),
        { timeout: 20000 }
      );
    } catch (_) {
      console.warn('[Shopee] Key Metrics did not load in time — proceeding anyway');
    }

    await selectDate(page, date);
    await selectOrderType(page);

    // Scroll to trigger lazy-loaded sections
    const pageHeight = await page.evaluate(() => document.body.scrollHeight);
    const steps = Math.ceil(pageHeight / 600);
    for (let s = 0; s <= steps; s++) {
      await page.evaluate(pos => window.scrollTo(0, pos), s * 600);
      await page.waitForTimeout(300);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(1000);

    const data = await page.evaluate(() => {
      const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG']);
      function allTextNodes(root) {
        const texts = [];
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          if (SKIP_TAGS.has(node.parentElement?.tagName)) continue;
          const v = node.nodeValue.trim();
          if (v && v.length < 300) texts.push(v);
        }
        for (const el of root.querySelectorAll('*')) {
          if (el.shadowRoot) texts.push(...allTextNodes(el.shadowRoot));
        }
        return texts;
      }

      const tokens = allTextNodes(document.body);
      const anchor = Math.max(0, tokens.indexOf('Key Metrics'));

      function findRM(label, from) {
        for (let i = from; i < tokens.length; i++) {
          if (tokens[i] !== label) continue;
          for (let j = i + 1; j < Math.min(i + 25, tokens.length); j++) {
            if (tokens[j] === 'RM' && /^[\d,]+\.?\d*$/.test(tokens[j + 1] || '')) {
              return parseFloat(tokens[j + 1].replace(/,/g, ''));
            }
          }
        }
        return null;
      }

      function findCount(label, from) {
        for (let i = from; i < tokens.length; i++) {
          if (tokens[i] !== label) continue;
          for (let j = i + 1; j < Math.min(i + 25, tokens.length); j++) {
            if (/^\d{1,7}$/.test(tokens[j].replace(/,/g, ''))) {
              const n = parseInt(tokens[j].replace(/,/g, ''), 10);
              if (n < 10000000) return n;
            }
          }
        }
        return null;
      }

      function findPct(label, from) {
        for (let i = from; i < tokens.length; i++) {
          if (tokens[i] !== label) continue;
          for (let j = i + 1; j < Math.min(i + 25, tokens.length); j++) {
            if (/^\d+\.?\d*$/.test(tokens[j]) && tokens[j + 1] === '%') {
              return parseFloat(tokens[j]);
            }
          }
        }
        return null;
      }

      const revenue        = findRM('Sales', anchor);
      const orders         = findCount('Orders', anchor);
      const sessions       = findCount('Visitors', anchor);
      const clicks         = findCount('Product Clicks', anchor);
      const conversionRate = findPct('Order Conversion Rate', anchor);

      return {
        grossSales: revenue,
        orders, sessions, clicks, conversionRate,
      };
    });

    console.log('[Shopee] Scraping ad spend...');
    const adSpend = await scrapeAdSpend(page, date);
    console.log('[Shopee] Ad spend:', adSpend);

    console.log('[Shopee] Scraping daily income...');
    const totalIncome = await scrapeIncome(page, date);
    console.log('[Shopee] Daily income:', totalIncome);

    const productRankings = await scrapeProductRankings(page, date);

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
