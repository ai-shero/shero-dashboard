/**
 * Shopify scraper — scrapes Analytics > Overview for today's revenue & orders.
 *
 * Login : npm run login:shopify
 *   Opens a visible browser. Log in to Shopify manually, then press Enter.
 *   Session saved to scrapers/sessions/shopify.json
 *
 * Scrape: node scrapers/shopify.js  (or called by scrapers/run.js)
 *   Uses saved session headlessly.
 */
const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const path = require('path');
const fs   = require('fs');

// Apply full stealth — hides all Playwright/automation detection markers
chromium.use(StealthPlugin());

const SESSION_FILE = path.join(__dirname, 'sessions', 'shopify.json');
const STORE_URL    = 'https://admin.shopify.com/store/shero-cosmetics-my';

/* ─── login ─────────────────────────────────────────────────────────────── */
async function login() {
  console.log('');
  console.log('[Shopify] Opening browser for manual login...');
  console.log('[Shopify] Log in to Shopify, then come back here and press Enter.');
  console.log('');

  const browser = await chromium.launch({
    headless: false,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--start-maximized',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });

  const context = await browser.newContext({
    viewport: null,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });

  const page = await context.newPage();

  try {
    await page.goto(`${STORE_URL}/analytics`, {
      waitUntil: 'domcontentloaded',
      timeout:   30000,
    });
  } catch (_) {
    // May redirect to login — that's fine, user will log in
  }

  console.log('[Shopify] Browser is open.');
  console.log('[Shopify] Log in using "Continue with Google" (info.sheroglobal@gmail.com)');
  console.log('[Shopify] Once you can see the Analytics page, press Enter here.');

  await new Promise(resolve => {
    process.stdin.resume();
    process.stdin.once('data', () => { process.stdin.pause(); resolve(); });
  });

  fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
  await context.storageState({ path: SESSION_FILE });
  console.log('[Shopify] ✓ Session saved to', SESSION_FILE);
  await browser.close();
}

/* ─── date range picker ──────────────────────────────────────────────────── */
async function selectDateRange(page, targetDate) {
  const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const [year, month, day] = targetDate.split('-').map(Number);
  const monthName = MONTHS[month - 1];

  // Wait for RM values — analytics component only mounts after data loads
  try {
    await page.waitForFunction(() => {
      function t(root) {
        const texts = [];
        const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let n; while ((n = w.nextNode())) { const v = n.nodeValue.trim(); if (v) texts.push(v); }
        for (const el of root.querySelectorAll('*')) { if (el.shadowRoot) texts.push(...t(el.shadowRoot)); }
        return texts;
      }
      return t(document.body).some(x => /^-?RM\s*[\d,]+\.\d{2}$/.test(x));
    }, {}, { timeout: 30000 });
  } catch (_) {
    console.warn('[Shopify] Analytics not loaded — skipping date selection');
    return;
  }

  // Click the date control button to open the calendar
  const opened = await page.evaluate(() => {
    function click(root) {
      for (const el of root.querySelectorAll('*')) {
        if (el.getAttribute?.('aria-label')?.startsWith('Date control:')) { el.click(); return true; }
        if (el.shadowRoot && click(el.shadowRoot)) return true;
      }
      return false;
    }
    return click(document.body);
  });
  if (!opened) { console.warn('[Shopify] Date control button not found'); return; }
  await page.waitForTimeout(1200);

  // Click the target day — match ariaLabel "[DayOfWeek] [Month] [Day] [Year]"
  // The calendar shows two months simultaneously; use month name + year to avoid
  // clicking the same day number in the adjacent month.
  const dayFragment = `${monthName} ${day} ${year}`;
  const clickedDay = await page.evaluate((fragment) => {
    function click(root) {
      for (const el of root.querySelectorAll('button')) {
        const a = el.getAttribute('aria-label') || '';
        const cls = el.className || '';
        if (cls.includes('DatePicker__Day') && a.includes(fragment) && !el.disabled) {
          el.click(); return a;
        }
      }
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) { const r = click(el.shadowRoot); if (r) return r; }
      }
      return null;
    }
    return click(document.body);
  }, dayFragment);

  if (!clickedDay) {
    console.warn(`[Shopify] Day button for "${dayFragment}" not found — calendar may need navigation`);
    // Dismiss picker and proceed with whatever date is loaded
    await page.evaluate(() => {
      function click(root) {
        for (const el of root.querySelectorAll('button')) {
          if (el.textContent?.trim() === 'Cancel') { el.click(); return true; }
        }
        for (const el of root.querySelectorAll('*')) {
          if (el.shadowRoot && click(el.shadowRoot)) return true;
        }
        return false;
      }
      click(document.body);
    });
    return;
  }
  await page.waitForTimeout(500);

  // Click the same day again to set end = start (single-day range)
  await page.evaluate((fragment) => {
    function click(root) {
      for (const el of root.querySelectorAll('button')) {
        const a = el.getAttribute('aria-label') || '';
        const cls = el.className || '';
        if (cls.includes('DatePicker__Day') && a.includes(fragment) && !el.disabled) {
          el.click(); return true;
        }
      }
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot && click(el.shadowRoot)) return true;
      }
      return false;
    }
    click(document.body);
  }, dayFragment);
  await page.waitForTimeout(400);

  // Click Apply
  await page.evaluate(() => {
    function click(root) {
      for (const el of root.querySelectorAll('button')) {
        if (el.textContent?.trim() === 'Apply') { el.click(); return true; }
      }
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot && click(el.shadowRoot)) return true;
      }
      return false;
    }
    click(document.body);
  });

  await page.waitForTimeout(2000);
}

/* ─── scrape ─────────────────────────────────────────────────────────────── */
async function scrape(date) {
  if (!fs.existsSync(SESSION_FILE)) {
    throw new Error('No session found. Run: npm run login:shopify');
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    storageState: SESSION_FILE,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });

  const page = await context.newPage();

  await page.goto(`${STORE_URL}/analytics`, {
    waitUntil: 'domcontentloaded',
    timeout:   30000,
  });

  if (page.url().includes('accounts.shopify.com') || page.url().includes('/login')) {
    await browser.close();
    throw new Error('SESSION_EXPIRED');
  }

  // Select the target date via the date picker UI
  await selectDateRange(page, date);

  // Wait for analytics breakdown to render in shadow DOM (up to 25s)
  try {
    await page.waitForFunction(() => {
      function allTextNodes(root) {
        const texts = [];
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          const v = node.nodeValue.trim();
          if (v) texts.push(v);
        }
        for (const el of root.querySelectorAll('*')) {
          if (el.shadowRoot) texts.push(...allTextNodes(el.shadowRoot));
        }
        return texts;
      }
      const tokens = allTextNodes(document.body);
      return tokens.includes('Total sales breakdown') &&
             tokens.some(t => /^-?RM\s*[\d,]+\.\d{2}$/.test(t));
    }, {}, { timeout: 25000 });
  } catch (_) { /* proceed */ }

  // Scroll the full page height to trigger all lazy sections
  const pageHeight = await page.evaluate(() => document.body.scrollHeight);
  const steps = Math.ceil(pageHeight / 700);
  for (let s = 0; s <= steps; s++) {
    await page.evaluate(pos => window.scrollTo(0, pos), s * 700);
    await page.waitForTimeout(350);
  }

  // Wait for sessions summary card to appear (distinct from chart axis "Sessions")
  try {
    await page.waitForFunction(() => {
      function allTextNodes(root) {
        const texts = [];
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          const v = node.nodeValue.trim();
          if (v) texts.push(v);
        }
        for (const el of root.querySelectorAll('*')) {
          if (el.shadowRoot) texts.push(...allTextNodes(el.shadowRoot));
        }
        return texts;
      }
      const tokens = allTextNodes(document.body);
      // Sessions summary card: "Sessions" → count → "Increase/Decrease of..."
      for (let i = 0; i < tokens.length; i++) {
        if (tokens[i] === 'Sessions' && /^\d+$/.test(tokens[i+1]) && /^(Increase|Decrease) of/.test(tokens[i+2] || '')) {
          return true;
        }
      }
      return false;
    }, {}, { timeout: 20000 });
  } catch (_) { /* proceed */ }

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(800);

  const data = await page.evaluate(() => {
    // Shopify analytics renders values inside shadow DOM — must pierce all shadow roots
    function allTextNodes(root) {
      const texts = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const v = node.nodeValue.trim();
        if (v && !v.startsWith('.') && !v.startsWith('html,') && v.length < 200) texts.push(v);
      }
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) texts.push(...allTextNodes(el.shadowRoot));
      }
      return texts;
    }

    const tokens = allTextNodes(document.body);

    function parseRM(s) {
      if (!s) return null;
      const n = parseFloat(s.replace(/[^\d.\-]/g, ''));
      return isNaN(n) ? null : n;
    }
    function parsePct(s) {
      if (!s) return null;
      const n = parseFloat(s.replace('%', ''));
      return isNaN(n) ? null : n;
    }

    // ── Total sales breakdown ──────────────────────────────────────────────
    // DOM order: breakdown rows appear BEFORE the "Total sales breakdown" heading.
    // Anchor: find "Total sales over time" (the chart section headline) then read
    // the breakdown rows that follow until "Total sales breakdown" heading.
    const tsoIdx = tokens.lastIndexOf('Total sales over time');
    const tsbIdx = tokens.findIndex(t => t === 'Total sales breakdown');
    const section = (tsoIdx >= 0 && tsbIdx > tsoIdx)
      ? tokens.slice(tsoIdx, tsbIdx)
      : tokens; // fallback: search whole page

    const BREAKDOWN_LABELS = ['Gross sales','Discounts','Returns','Net sales','Shipping charges','Return fees','Taxes','Total sales'];
    const breakdown = {};
    for (let i = 0; i < section.length; i++) {
      if (BREAKDOWN_LABELS.includes(section[i])) {
        const next = section[i + 1] || '';
        if (/^-?RM/.test(next)) breakdown[section[i]] = parseRM(next);
      }
    }

    // ── Card extraction helper ────────────────────────────────────────────
    // Card DOM pattern: "Label" → "Label over time" → description → VALUE [→ change]
    // Must search all occurrences because nav items share the same label text (e.g. "Orders").
    function cardValue(label) {
      for (let i = 0; i < tokens.length; i++) {
        if (tokens[i] !== label) continue;
        const next = tokens[i+1] || '';
        // The analytics card's next token is always "Label over time"
        if (next.toLowerCase().startsWith(label.toLowerCase()) && next.toLowerCase().includes('over time')) {
          return tokens[i+3] || null;
        }
      }
      return null;
    }

    // ── Orders fulfilled & Orders placed ─────────────────────────────────
    const ordersFulfilledRaw = cardValue('Orders fulfilled');
    const ordersFulfilled = ordersFulfilledRaw && /^\d+$/.test(ordersFulfilledRaw)
      ? parseInt(ordersFulfilledRaw, 10) : null;

    const ordersPlacedRaw = cardValue('Orders');
    const ordersPlaced = ordersPlacedRaw && /^\d+$/.test(ordersPlacedRaw)
      ? parseInt(ordersPlacedRaw, 10) : null;

    // ── Returning customer rate ───────────────────────────────────────────
    // Pattern: "Returning customer rate over time" → description → "Returning customer rate"
    //          → formula tokens → "XX.XX%"
    let returningCustomerRate = null;
    const rcrIdx = tokens.findIndex(t => t === 'Returning customer rate over time');
    if (rcrIdx >= 0) {
      for (let j = rcrIdx + 1; j < rcrIdx + 15; j++) {
        if (/^\d+\.?\d*%$/.test(tokens[j])) { returningCustomerRate = parsePct(tokens[j]); break; }
      }
    }

    // ── Average order value ───────────────────────────────────────────────
    // Pattern: "Average order value over time" (×2) → description → formula → ... → RM value
    let avgOrderValue = null;
    const aovIdx = tokens.findIndex(t => t === 'Average order value over time');
    if (aovIdx >= 0) {
      for (let j = aovIdx + 1; j < aovIdx + 20; j++) {
        if (/^RM\s*[\d,]+\.\d{2}$/.test(tokens[j])) { avgOrderValue = parseRM(tokens[j]); break; }
      }
    }

    // ── Sessions ──────────────────────────────────────────────────────────
    // Primary: summary card pattern "Sessions" → count → "Increase/Decrease of..."
    // Fallback: conversion funnel "Sessions" → "100%" → count (always renders)
    let sessions = null;
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i] === 'Sessions' && /^\d+$/.test(tokens[i+1]) && /^(Increase|Decrease) of/.test(tokens[i+2] || '')) {
        sessions = parseInt(tokens[i+1], 10); break;
      }
    }
    // Fallback 2: "Sessions over time" × 2 → description → count (same as breakdown pattern)
    if (sessions === null) {
      const sotIdx = tokens.findIndex(t => t === 'Sessions over time');
      if (sotIdx >= 0 && tokens[sotIdx+1] === 'Sessions over time') {
        const count = tokens[sotIdx + 3];
        if (/^\d+$/.test(count)) sessions = parseInt(count, 10);
      }
    }
    // Fallback 3: conversion funnel "Sessions" → "100%" → count
    if (sessions === null) {
      for (let i = 0; i < tokens.length; i++) {
        if (tokens[i] === 'Sessions' && tokens[i+1] === '100%' && /^\d+$/.test(tokens[i+2])) {
          sessions = parseInt(tokens[i+2], 10); break;
        }
      }
    }
    // Fallback 4: "Sessions" → number → "%" (summary card without "Increase of" text)
    if (sessions === null) {
      for (let i = 0; i < tokens.length; i++) {
        if (tokens[i] === 'Sessions' && /^\d{2,}$/.test(tokens[i+1]) && /^[\d.]+%$/.test(tokens[i+2])) {
          sessions = parseInt(tokens[i+1], 10); break;
        }
      }
    }

    // ── Conversion rate ───────────────────────────────────────────────────
    // Pattern: "Conversion rate over time" → description → "Conversion rate" → formula → "X.XX%"
    let conversionRate = null;
    const crIdx = tokens.findIndex(t => t === 'Conversion rate over time');
    if (crIdx >= 0) {
      for (let j = crIdx + 1; j < crIdx + 15; j++) {
        if (/^\d+\.?\d*%$/.test(tokens[j])) { conversionRate = parsePct(tokens[j]); break; }
      }
    }

    return {
      totalSales:           breakdown['Total sales']        ?? null,
      grossSales:           breakdown['Total sales']        ?? null,  // no income tab — use Total sales as gross sales
      discounts:            breakdown['Discounts']          ?? null,
      returns:              breakdown['Returns']            ?? null,
      netSales:             breakdown['Net sales']          ?? null,
      shippingCharges:      breakdown['Shipping charges']   ?? null,
      returnFees:           breakdown['Return fees']        ?? null,
      taxes:                breakdown['Taxes']              ?? null,
      ordersPlaced,
      ordersFulfilled,
      averageOrderValue:    avgOrderValue,
      sessions,
      conversionRate,
      returningCustomerRate,
      url: window.location.href,
    };
  });

  await browser.close();
  return data;
}

module.exports = { login, scrape };

/* ─── CLI ────────────────────────────────────────────────────────────────── */
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args[0] === '--login') {
    login().catch(console.error);
  } else {
    const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
    scrape(today)
      .then(d => console.log(JSON.stringify(d, null, 2)))
      .catch(console.error);
  }
}
