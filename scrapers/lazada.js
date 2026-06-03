/**
 * Lazada Malaysia Seller Centre scraper.
 *
 * Requires the always-on Chrome to be running:  npm run start-browser
 * Log in to Lazada in that browser once — sessions persist indefinitely.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const cdp = require('./cdp');

const HOME_URL = 'https://sellercenter.lazada.com.my/';

/* ─── scrapeIncome ───────────────────────────────────────────────────────── */
async function scrapeIncome(page, date) {
  const INCOME_URL = 'https://sellercenter.lazada.com.my/portal/apps/finance/myIncome/index';
  console.log('[Lazada] Navigating to My Income...');

  let incomeData = null;
  const responseHandler = async (res) => {
    if (!res.url().includes('queryreleasedagg')) return;
    try {
      const body = await res.text();
      console.log('[Lazada] Income API response:', body.slice(0, 500));
      try { incomeData = JSON.parse(body); } catch (_) {}
    } catch (_) {}
  };
  page.on('response', responseHandler);

  try {
    await page.goto(INCOME_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(4000);
    console.log('[Lazada] Income URL:', page.url());
  } finally {
    page.off('response', responseHandler);
  }

  // Parse intercepted data
  if (incomeData) {
    const yyyymmdd = parseInt(date.replace(/-/g, ''), 10);
    const list = incomeData.data?.data?.list || [];
    console.log('[Lazada] Income list entries:', list.map(e => ({ date: e.settleDate, amount: e.amount })));
    const entry = list.find(e => e.sortTime === yyyymmdd);
    return entry?.amount ?? null;
  }

  // Fallback: call API manually from page context
  const result = await page.evaluate(async (targetDate) => {
    const yyyymmdd = parseInt(targetDate.replace(/-/g, ''), 10);
    const t = Date.now();
    const url = `https://acs-m.lazada.com.my/h5/mtop.lazada.finance.sellerfund3.release.queryreleasedagg/1.0/?jsv=2.6.1&appKey=4272&t=${t}&v=1.0&H5Request=true&api=mtop.lazada.finance.sellerfund3.release.queryreleasedagg`;
    try {
      const r = await fetch(url, { credentials: 'include' });
      const d = await r.json();
      const list = d.data?.data?.list || [];
      const entry = list.find(e => e.sortTime === yyyymmdd);
      return { ok: true, amount: entry?.amount ?? null, list: list.map(e => ({ date: e.settleDate, amount: e.amount })) };
    } catch (e) { return { ok: false, error: e.message }; }
  }, date);

  console.log('[Lazada] Income fallback result:', JSON.stringify(result));
  return result.amount;
}

/* ─── scrapeMetrics (Business Advisor) ──────────────────────────────────── */
async function scrapeMetrics(page, date) {
  const BA_URL = `https://sellercenter.lazada.com.my/ba/dashboard?dateRange=${date}%7C${date}&dateType=recent1`;
  console.log('[Lazada] Navigating to BA dashboard:', BA_URL);

  await page.goto(BA_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(4000);
  console.log('[Lazada] BA URL:', page.url());

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(3000);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(1000);

  // Key Metrics Slick carousel slides
  const kmSlides = await page.evaluate(() => {
    const textOf = (el) => {
      const out = [];
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = w.nextNode())) {
        const p = n.parentElement;
        if (['SCRIPT','STYLE'].includes(p?.tagName)) continue;
        const v = n.nodeValue.trim();
        if (v && v.length > 0 && v.length < 200) out.push(v);
      }
      return out;
    };

    for (const el of document.querySelectorAll('*')) {
      if (el.childElementCount === 0 && el.textContent.trim() === 'Key Metrics') {
        let c = el;
        for (let i = 0; i < 8; i++) c = c?.parentElement;
        if (!c) return [];
        const slides = Array.from(c.querySelectorAll('.slick-slide'));
        return slides.map((s, i) => ({
          idx: i,
          active: s.classList.contains('slick-active'),
          tokens: textOf(s)
        }));
      }
    }
    return [];
  });
  console.log('[Lazada] KM slides:', JSON.stringify(kmSlides.map(s => ({ idx: s.idx, active: s.active, tokens: s.tokens.slice(0, 20) }))));

  const tokens = await page.evaluate(() => {
    const SKIP = new Set(['SCRIPT','STYLE','NOSCRIPT','SVG']);
    const out = [];
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) {
      if (SKIP.has(n.parentElement?.tagName)) continue;
      const v = n.nodeValue.trim();
      if (v && v.length > 0 && v.length < 300) out.push(v);
    }
    return [...new Set(out)];
  });

  // Ads page
  const ADS_URL = `https://sellercenter.lazada.com.my/ba/ads?dateRange=${date}%7C${date}&dateType=recent1`;
  console.log('[Lazada] Navigating to BA Ads:', ADS_URL);
  await page.goto(ADS_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(4000);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(3000);

  const adsTokens = await page.evaluate(() => {
    const SKIP = new Set(['SCRIPT','STYLE','NOSCRIPT','SVG']);
    const out = [];
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) {
      if (SKIP.has(n.parentElement?.tagName)) continue;
      const v = n.nodeValue.trim();
      if (v && v.length > 0 && v.length < 300) out.push(v);
    }
    return [...new Set(out)];
  });
  console.log('[Lazada] Ads tokens:', JSON.stringify(adsTokens.slice(0, 80)));

  return parseBaData(tokens, adsTokens, kmSlides);
}

/* ─── parseBaData ────────────────────────────────────────────────────────── */
function parseBaData(tokens, adsTokens, kmSlides) {
  const result = {};

  if (kmSlides && kmSlides.length > 0) {
    const findLabel = (toks, ...names) =>
      toks.findIndex(t => names.some(n => t.trim().toLowerCase() === n.toLowerCase()));

    const firstIntAfter = (toks, idx) => {
      for (let i = idx + 1; i < Math.min(idx + 6, toks.length); i++) {
        if (!toks[i].includes('%') && !/[a-z]/i.test(toks[i])) {
          const n = parseInt(toks[i], 10);
          if (!isNaN(n) && n >= 0) return n;
        }
      }
      return null;
    };

    const firstFloatAfter = (toks, idx) => {
      for (let i = idx + 1; i < Math.min(idx + 6, toks.length); i++) {
        const n = parseFloat(toks[i].replace('%', ''));
        if (!isNaN(n)) return n;
      }
      return null;
    };

    const firstIntIn = (toks) => {
      for (const t of toks) {
        if (!t.includes('%') && !/[a-z]/i.test(t)) {
          const n = parseInt(t, 10);
          if (!isNaN(n) && n >= 0) return n;
        }
      }
      return null;
    };

    for (const slide of kmSlides) {
      const toks = slide.tokens;

      const viIdx = findLabel(toks, 'Visitors', 'Unique Visitors', 'Buyer Visits');
      if (viIdx !== -1 && result.sessions == null) {
        const v = firstIntAfter(toks, viIdx);
        if (v != null) result.sessions = v;
      }

      const orIdx = findLabel(toks, 'Orders', 'Orders Placed', 'Total Orders');
      if (orIdx !== -1 && result.orders == null) {
        const v = firstIntAfter(toks, orIdx);
        if (v != null) result.orders = v;
      }

      const cvrIdx = findLabel(toks, 'Conversion Rate', 'CVR');
      if (cvrIdx !== -1 && result.conversionRate == null) {
        const v = firstFloatAfter(toks, cvrIdx);
        if (v != null) result.conversionRate = v;
      }
    }

    if (result.sessions == null && kmSlides[0]) {
      const v = firstIntIn(kmSlides[0].tokens);
      if (v != null) { result.sessions = v; console.log('[Lazada] sessions (slide-0 positional):', v); }
    }
    if (result.orders == null && kmSlides[1]) {
      const v = firstIntIn(kmSlides[1].tokens);
      if (v != null) { result.orders = v; console.log('[Lazada] orders (slide-1 positional):', v); }
    }

    if (result.conversionRate == null) {
      const kmIdx = tokens.indexOf('Key Metrics');
      if (kmIdx !== -1) {
        const section = tokens.slice(kmIdx);
        const ci = section.indexOf('Conversion Rate');
        if (ci !== -1) {
          const v = parseFloat(section[ci + 1]);
          if (!isNaN(v)) result.conversionRate = v;
        }
      }
    }
  } else {
    const kmIdx = tokens.indexOf('Key Metrics');
    if (kmIdx !== -1) {
      const section = tokens.slice(kmIdx);
      const cvrIdx = section.indexOf('Conversion Rate');
      if (cvrIdx !== -1) {
        const v = parseFloat(section[cvrIdx + 1]);
        if (!isNaN(v)) result.conversionRate = v;
      }
    }
  }

  // Gross sales from Ranking by Revenue
  const kmIdx2 = tokens.indexOf('Key Metrics');
  if (kmIdx2 !== -1) {
    const section = tokens.slice(kmIdx2);
    const rrIdx = section.indexOf('Ranking by Revenue');
    if (rrIdx !== -1) {
      let sum = 0; let count = 0; let nonNumericRun = 0;
      for (let i = rrIdx + 1; i < section.length; i++) {
        const n = parseFloat(section[i]);
        if (!isNaN(n) && n > 0 && n < 100000) {
          sum += n; count++; nonNumericRun = 0;
        } else {
          nonNumericRun++;
          if (count > 0 && nonNumericRun >= 2) break;
        }
      }
      if (count > 0) result.grossSales = Math.round(sum * 100) / 100;
    }
  }

  // Ad spend from Sponsored Services
  const spendIdx = adsTokens.findIndex(t => /^Est\.?\s*Spend$/i.test(t));
  if (spendIdx !== -1) {
    for (let i = spendIdx + 1; i < Math.min(spendIdx + 5, adsTokens.length); i++) {
      const v = adsTokens[i];
      if (v === '-' || v === '0' || v === '0.00') { result.adSpend = 0; break; }
      const n = parseFloat(v);
      if (!isNaN(n)) { result.adSpend = n; break; }
    }
  }
  if (result.adSpend === undefined) result.adSpend = 0;

  console.log('[Lazada] Parsed metrics:', JSON.stringify(result));
  return Object.keys(result).length > 0 ? result : null;
}

/* ─── product rankings (units sold) ──────────────────────────────────────── */
// Maps the BA product-performance items into [{rank,name,units,revenue,sku}],
// sorted by units desc, units > 0 only, top 10.
function parseProductRankings(items) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const val = (f) => (f && typeof f === 'object' ? f.value : f);
  return items
    .map(it => ({
      name:    val(it.productName) || '(unknown)',
      sku:     val(it.itemId) != null ? String(val(it.itemId)) : null,
      units:   Math.round(Number(val(it.productUnitsSold)) || 0),
      revenue: Number(val(it.productRevenue)) || 0,
    }))
    .filter(p => p.units > 0)
    .sort((a, b) => b.units - a.units || b.revenue - a.revenue)
    .slice(0, 10)
    .map((p, i) => ({ rank: i + 1, ...p }));
}

/* ─── scrape ─────────────────────────────────────────────────────────────── */
async function scrape(date) {
  const { page } = await cdp.newPage();

  try {
    await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
    console.log('[Lazada] Landed on:', page.url());

    // Check if logged in
    if (page.url().includes('/login') || page.url().includes('/register')) {
      throw new Error('NOT_LOGGED_IN: Open the scraper browser and log in to Lazada.');
    }

    // Capture per-product units sold from the BA "Product Performance" report
    // (date-filtered XHR that fires when scrapeMetrics loads the dashboard).
    let perfItems = null;
    const onPerf = async (res) => {
      if (!res.url().includes('product/performance/batch/itemV2')) return;
      try { const j = await res.json().catch(() => null); if (j?.data?.data) perfItems = j.data.data; } catch (_) {}
    };
    page.on('response', onPerf);

    const income  = await scrapeIncome(page, date);
    const metrics = await scrapeMetrics(page, date);

    page.off('response', onPerf);
    const productRankings = parseProductRankings(perfItems);

    console.log('\n[Lazada] Final result:');
    console.log('  income:', income);
    console.log('  metrics:', metrics);
    console.log('  product rankings:', productRankings.length);

    return { income, ...(metrics || {}), productRankings };
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
    .then(d => console.log('[Result]', JSON.stringify(d, null, 2)))
    .catch(console.error);
}
