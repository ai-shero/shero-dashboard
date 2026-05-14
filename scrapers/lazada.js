/**
 * Lazada Malaysia Seller Centre scraper.
 *
 * Login : npm run login:lazada
 *   Opens a persistent browser profile. Log in manually once (with OTP).
 *   Profile saved to scrapers/profiles/lazada/ — device is then "remembered".
 *
 * Scrape: node scrapers/lazada.js [YYYY-MM-DD]
 *   Auto-logs in with email+password (OTP skipped if device is trusted).
 *   Defaults to yesterday (MYT).
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { chromium } = require('playwright');
const path = require('path');
const fs   = require('fs');

const PROFILE_DIR = path.join(__dirname, 'profiles', 'lazada');
const HOME_URL    = 'https://sellercenter.lazada.com.my/';
const LOGIN_URL   = 'https://sellercenter.lazada.com.my/apps/seller/login';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/* ─── login (manual — run once to register device) ──────────────────────── */
async function login() {
  console.log('[Lazada] Opening persistent browser for manual login...');
  console.log('[Lazada] Log in with email + password + OTP.');
  console.log('[Lazada] Once you see the Seller Centre dashboard, press Enter here.\n');

  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    args: ['--disable-blink-features=AutomationControlled', '--start-maximized', '--no-first-run'],
    userAgent: UA, viewport: null,
  });

  const page = await context.newPage();
  try { await page.goto('https://sellercenter.lazada.com.my/apps/register/index', { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch (_) {}

  console.log('[Lazada] Browser open. Click "Log In", complete login, then press Enter here.');
  context.on('page', p => { p.on('load', () => console.log('[Lazada] Tab:', p.url())); });

  await new Promise(resolve => {
    process.stdin.resume();
    process.stdin.once('data', () => { process.stdin.pause(); resolve(); });
  });
  await page.waitForTimeout(2000);
  await context.close();
  console.log('[Lazada] ✓ Profile saved to', PROFILE_DIR);
}

/* ─── auto-login ─────────────────────────────────────────────────────────── */
async function autoLogin(page) {
  const email    = process.env.LAZADA_EMAIL;
  const password = process.env.LAZADA_PASSWORD;
  if (!email || !password) throw new Error('LAZADA_EMAIL / LAZADA_PASSWORD not set in .env');

  console.log('[Lazada] Auto-logging in...');
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);

  // Fill email
  const emailInput = await page.$('input[name="loginName"], input[type="email"], input[placeholder*="email" i], input[placeholder*="Email" i]');
  if (!emailInput) throw new Error('Login: email input not found');
  await emailInput.fill(email);
  await page.waitForTimeout(500);

  // Click "Login with Password" if that tab exists
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('*'))
      if (el.childElementCount === 0 && /login with password/i.test(el.textContent?.trim())) { el.click(); return; }
  });
  await page.waitForTimeout(800);

  // Fill password
  const pwInput = await page.$('input[name="password"], input[type="password"]');
  if (!pwInput) throw new Error('Login: password input not found');
  await pwInput.fill(password);
  await page.waitForTimeout(500);

  // Click Login / Submit button
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('button, [role="button"]')) {
      const t = el.textContent?.trim();
      if (/^(Login|Log In|Sign In|Submit)$/i.test(t)) { el.click(); return; }
    }
  });
  await page.waitForTimeout(4000);

  const url = page.url();
  console.log('[Lazada] After login attempt:', url);

  // Handle OTP if it appears
  const needsOtp = await page.evaluate(() =>
    document.body.innerText.includes('verification') ||
    document.body.innerText.includes('OTP') ||
    document.body.innerText.includes('code sent') ||
    !!document.querySelector('input[name="otp"], input[placeholder*="code" i]')
  );

  if (needsOtp) {
    console.log('[Lazada] OTP required — enter it in the browser window, then press Enter here.');
    await new Promise(resolve => {
      process.stdin.resume();
      process.stdin.once('data', () => { process.stdin.pause(); resolve(); });
    });
    await page.waitForTimeout(3000);
  }

  // Wait for redirect to dashboard
  try {
    await page.waitForURL(u => !u.includes('/login') && !u.includes('/register'), { timeout: 15000 });
  } catch (_) {}

  if (page.url().includes('/login') || page.url().includes('/register')) {
    throw new Error('Auto-login failed — check LAZADA_EMAIL / LAZADA_PASSWORD in .env');
  }
  console.log('[Lazada] ✓ Logged in, on:', page.url());
}

/* ─── open context ───────────────────────────────────────────────────────── */
async function openContext() {
  if (!fs.existsSync(PROFILE_DIR)) throw new Error('No profile. Run: npm run login:lazada');
  // Remove stale lock file if present
  const lockFile = path.join(PROFILE_DIR, 'Default', 'LOCK');
  if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
  return chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,   // keep visible for now while building scraper
    args: ['--disable-blink-features=AutomationControlled', '--start-maximized'],
    userAgent: UA, viewport: null,
  });
}

/* ─── scrapeIncome ───────────────────────────────────────────────────────── */
async function scrapeIncome(page, date) {
  const INCOME_URL = 'https://sellercenter.lazada.com.my/portal/apps/finance/myIncome/index';
  console.log('[Lazada] Navigating to My Income...');

  // Intercept the actual queryreleasedagg response the page sends
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
  // dateType=recent1 = "yesterday" on the BA dashboard (confirmed)
  const BA_URL = `https://sellercenter.lazada.com.my/ba/dashboard?dateRange=${date}%7C${date}&dateType=recent1`;
  console.log('[Lazada] Navigating to BA dashboard:', BA_URL);

  // Use domcontentloaded — networkidle never fires (BA has continuous WebSocket polling)
  await page.goto(BA_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(4000);
  console.log('[Lazada] BA URL:', page.url());

  // Scroll the full page to trigger lazy-loaded metric sections
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(3000);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(1000);

  // ── Query Key Metrics Slick carousel slides directly ───────────────────
  // Both slides are in the DOM simultaneously — no click needed.
  // We get text from each slide independently so we can label them correctly.
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

    // Find the Key Metrics container
    for (const el of document.querySelectorAll('*')) {
      if (el.childElementCount === 0 && el.textContent.trim() === 'Key Metrics') {
        let c = el;
        for (let i = 0; i < 8; i++) c = c?.parentElement;
        if (!c) return [];

        // Get all slick slides in this container
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

  // ── Collect full page tokens (for gross sales product ranking + CVR) ───
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

  // ── ads page (Sponsored Services) ─────────────────────────────────────
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

  // ── Key Metrics from Slick carousel slides ────────────────────────────
  // Both slides live in the DOM simultaneously.
  // Strategy: match against known label text inside each slide; if labels aren't
  // present as text nodes (they may be SVG-rendered) fall back to positional rules:
  //   Slide 0 (active/first): Visitors, Conversion Rate
  //   Slide 1 (next/hidden):  Orders, …
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

    // ── Try label-based matching across ALL slides ─────────────────────
    for (const slide of kmSlides) {
      const toks = slide.tokens;

      // Visitors
      const viIdx = findLabel(toks, 'Visitors', 'Unique Visitors', 'Buyer Visits');
      if (viIdx !== -1 && result.sessions == null) {
        const v = firstIntAfter(toks, viIdx);
        if (v != null) result.sessions = v;
      }

      // Orders
      const orIdx = findLabel(toks, 'Orders', 'Orders Placed', 'Total Orders');
      if (orIdx !== -1 && result.orders == null) {
        const v = firstIntAfter(toks, orIdx);
        if (v != null) result.orders = v;
      }

      // Conversion Rate
      const cvrIdx = findLabel(toks, 'Conversion Rate', 'CVR');
      if (cvrIdx !== -1 && result.conversionRate == null) {
        const v = firstFloatAfter(toks, cvrIdx);
        if (v != null) result.conversionRate = v;
      }
    }

    // ── Positional fallback if labels weren't found ────────────────────
    // Slide 0 = first integer → Visitors
    // Slide 1 = first integer → Orders
    // This is correct per May-13 live observation (63 = visitors, orders on slide 1)
    if (result.sessions == null && kmSlides[0]) {
      const v = firstIntIn(kmSlides[0].tokens);
      if (v != null) { result.sessions = v; console.log('[Lazada] sessions (slide-0 positional):', v); }
    }
    if (result.orders == null && kmSlides[1]) {
      const v = firstIntIn(kmSlides[1].tokens);
      if (v != null) { result.orders = v; console.log('[Lazada] orders (slide-1 positional):', v); }
    }

    // CVR fallback from main tokens
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
    // ── Full fallback: main page tokens only (pre-slides discovery path) ──
    const kmIdx = tokens.indexOf('Key Metrics');
    if (kmIdx !== -1) {
      const section = tokens.slice(kmIdx);

      // CVR
      const cvrIdx = section.indexOf('Conversion Rate');
      if (cvrIdx !== -1) {
        const v = parseFloat(section[cvrIdx + 1]);
        if (!isNaN(v)) result.conversionRate = v;
      }
    }
  }

  // ── Gross sales: sum numeric values in "Ranking by Revenue" section ───
  // Works from full-page tokens regardless of carousel slide.
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

  // ── Ad spend from Sponsored Services (/ba/ads) ───────────────────────
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

/* ─── scrape ─────────────────────────────────────────────────────────────── */
async function scrape(date) {
  const context = await openContext();
  const page = await context.newPage();

  try {
    await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
    console.log('[Lazada] Landed on:', page.url());

    // Auto-login if session expired
    if (page.url().includes('/login') || page.url().includes('/register')) {
      console.log('[Lazada] Session expired — auto-logging in...');
      await autoLogin(page);
      // Give SPA time to fully initialize after login before navigating sub-pages
      await page.waitForTimeout(3000);
    }

    console.log('[Lazada] On page:', page.url());

    const income  = await scrapeIncome(page, date);
    const metrics = await scrapeMetrics(page, date);

    console.log('\n[Lazada] Final result:');
    console.log('  income:', income);
    console.log('  metrics:', metrics);

    return { income, ...(metrics || {}) };
  } finally {
    await context.close();
  }
}

module.exports = { login, scrape };

/* ─── CLI ────────────────────────────────────────────────────────────────── */
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args[0] === '--login') {
    login().catch(console.error);
  } else {
    const myt       = new Date(Date.now() + 8 * 3600000);
    const yesterday = new Date(+myt - 86400000).toISOString().slice(0, 10);
    scrape(args[0] || yesterday)
      .then(d => console.log('[Result]', JSON.stringify(d, null, 2)))
      .catch(console.error);
  }
}
