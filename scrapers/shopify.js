/**
 * Shopify scraper — scrapes Analytics > Overview for daily revenue & orders.
 *
 * Requires the always-on Chrome to be running:  npm run start-browser
 * Log in to Shopify in that browser once — sessions persist indefinitely.
 */
const cdp        = require('./cdp');
const STORE_URL  = 'https://admin.shopify.com/store/shero-cosmetics-my';
const MONTHS     = ['January','February','March','April','May','June','July','August','September','October','November','December'];

/* ─── shadow-DOM text walker ─────────────────────────────────────────────── */
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

/* ─── shadow-DOM helpers ─────────────────────────────────────────────────── */
// All calendar elements live inside a shadow DOM — must traverse recursively.
// These helpers are stringified into page.evaluate() calls.

const SHADOW_FIND_ALL = `
function findAll(root, sel) {
  const r = Array.from(root.querySelectorAll(sel));
  for (const el of root.querySelectorAll('*')) {
    if (el.shadowRoot) r.push(...findAll(el.shadowRoot, sel));
  }
  return r;
}
`;

const SHADOW_CLICK_ARIA = `
function clickAria(root, prefix) {
  for (const el of root.querySelectorAll('*')) {
    const a = el.getAttribute?.('aria-label') || '';
    if (a.startsWith(prefix)) { el.click(); return a; }
    if (el.shadowRoot) { const r = clickAria(el.shadowRoot, prefix); if (r) return r; }
  }
  return null;
}
`;

/* ─── date range picker ──────────────────────────────────────────────────── */
async function selectDateRange(page, targetDate) {
  const [year, month, day] = targetDate.split('-').map(Number);
  const monthName      = MONTHS[month - 1];
  const targetMonthKey = `${monthName}${year}`;  // "May2026" (no space) — matches .monthyear-text

  // Wait for any RM value (confirms analytics component mounted)
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
    console.warn('[Shopify] Analytics not loaded — cannot select date');
    return false;
  }

  // ── Open date picker ──────────────────────────────────────────────────────
  const opened = await page.evaluate(new Function(`
    ${SHADOW_CLICK_ARIA}
    return clickAria(document.body, 'Date control:') !== null;
  `));
  if (!opened) { console.warn('[Shopify] Date control button not found'); return false; }
  await page.waitForTimeout(1500);

  // ── Navigate calendar to the target month ────────────────────────────────
  console.log(`[Shopify] Navigating calendar to ${targetMonthKey}`);

  for (let attempt = 0; attempt < 24; attempt++) {
    const paneMonths = await page.evaluate(new Function(`
      ${SHADOW_FIND_ALL}
      return findAll(document.body, '.monthyear-text').map(el => el.textContent.replace(/\\s+/g, ''));
    `));
    console.log('[Shopify] Calendar panes:', paneMonths);

    if (paneMonths.includes(targetMonthKey)) break;

    const last = paneMonths[paneMonths.length - 1] || '';
    const parseKey = key => {
      const MLIST = ['January','February','March','April','May','June','July','August','September','October','November','December'];
      const m = key.match(/^([A-Za-z]+)(\d{4})$/);
      return m ? parseInt(m[2]) * 12 + MLIST.indexOf(m[1]) : 0;
    };
    const goBack = (year * 12 + (month - 1)) < parseKey(last);

    const navLabel = goBack ? 'Previous month' : 'Next month';
    const moved = await page.evaluate(new Function('navLabel', `
      ${SHADOW_CLICK_ARIA}
      return clickAria(document.body, navLabel) !== null;
    `), navLabel);

    if (!moved) { console.warn(`[Shopify] Nav button "${navLabel}" not found`); break; }
    await page.waitForTimeout(600);
  }

  // ── Click start day ───────────────────────────────────────────────────────
  // Day buttons span both calendar panes. We use findAll across all shadow DOMs,
  // then index into the correct group by counting days in preceding months.
  const clickDay = new Function('args', `
    const { targetMonthKey, targetDay } = args;
    ${SHADOW_FIND_ALL}
    const MLIST = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const paneMonths = findAll(document.body, '.monthyear-text').map(h => h.textContent.replace(/\\s+/g, ''));
    const paneIdx = paneMonths.indexOf(targetMonthKey);
    if (paneIdx === -1) return 'pane-not-found:' + targetMonthKey;
    let startIdx = 0;
    for (let i = 0; i < paneIdx; i++) {
      const m = paneMonths[i].match(/^([A-Za-z]+)(\\d{4})$/);
      if (m) startIdx += new Date(parseInt(m[2]), MLIST.indexOf(m[1]) + 1, 0).getDate();
    }
    const allBtns = findAll(document.body, '.day-button');
    const btn = allBtns[startIdx + targetDay - 1];
    if (!btn) return 'out-of-range:idx=' + (startIdx + targetDay - 1) + '/total=' + allBtns.length;
    if (btn.disabled) return 'disabled:day=' + targetDay;
    btn.click();
    return 'ok:idx=' + (startIdx + targetDay - 1);
  `);

  const clickedStart = await page.evaluate(clickDay, { targetMonthKey, targetDay: day });
  if (!clickedStart || !clickedStart.startsWith('ok')) {
    console.warn(`[Shopify] Start day click failed: ${clickedStart}`);
    return false;
  }
  console.log(`[Shopify] Clicked start: ${clickedStart}`);
  await page.waitForTimeout(600);

  // ── Click end day (same day → single-day range) ───────────────────────────
  await page.evaluate(clickDay, { targetMonthKey, targetDay: day });
  await page.waitForTimeout(500);

  // ── Click Apply ───────────────────────────────────────────────────────────
  // Apply button: class includes "variant-primary", not disabled, inside .date-picker
  const applied = await page.evaluate(new Function(`
    ${SHADOW_FIND_ALL}
    const pickers = findAll(document.body, '.date-picker');
    for (const p of pickers) {
      for (const btn of p.querySelectorAll('button')) {
        const cls = btn.className || '';
        if (cls.includes('variant-primary') && !btn.disabled) { btn.click(); return true; }
      }
    }
    // Fallback: any non-disabled variant-primary button
    ${SHADOW_FIND_ALL.replace('function findAll', 'function findAll2')}
    for (const btn of findAll2(document.body, 'button')) {
      const cls = btn.className || '';
      if (cls.includes('variant-primary') && !btn.disabled) { btn.click(); return true; }
    }
    return false;
  `));
  console.log(`[Shopify] Apply clicked: ${applied}`);

  // Wait for analytics data to re-render after the date change.
  // After Apply, the SPA briefly clears metrics (loading state) then reloads them.
  // Strategy: wait for "Total sales breakdown" section to appear (up to 60s).
  // Some dates with less cached data take 30-50s to load on Shopify's server side.
  // We only require the section header — not the RM values — so zero-order days work too.
  // First give the SPA 1.5s to start its transition (clear old data).
  await page.waitForTimeout(1500);

  try {
    await page.waitForFunction(() => {
      function t(root) {
        const texts = [];
        const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let n; while ((n = w.nextNode())) { const v = n.nodeValue.trim(); if (v) texts.push(v); }
        for (const el of root.querySelectorAll('*')) { if (el.shadowRoot) texts.push(...t(el.shadowRoot)); }
        return texts;
      }
      const tokens = t(document.body);
      // Accept either full data OR just the breakdown section header (zero-order day)
      return tokens.includes('Total sales breakdown') ||
             tokens.includes('No orders') ||
             tokens.some(x => /^-?RM\s*[\d,]+\.\d{2}$/.test(x));
    }, {}, { timeout: 60000 });
    console.log('[Shopify] Data re-rendered after Apply');
  } catch (_) {
    console.warn('[Shopify] Timed out waiting for data re-render after Apply');
  }

  return !!applied;
}

/* ─── scrape ─────────────────────────────────────────────────────────────── */
async function _scrapeImpl(date) {
  const { page } = await cdp.newPage();

  try {
    // Set a 45s page-level timeout so evaluate/wait calls don't hang indefinitely
    page.setDefaultTimeout(45000);

    // Navigate to analytics WITHOUT date params — fresh page load, then use calendar
    await page.goto(`${STORE_URL}/analytics`, {
      waitUntil: 'domcontentloaded',
      timeout:   30000,
    });

    // Check if logged in
    if (page.url().includes('accounts.shopify.com') || page.url().includes('/login')) {
      throw new Error('NOT_LOGGED_IN: Open the scraper browser and log in to Shopify.');
    }

    console.log('[Shopify] Loaded analytics URL:', page.url());

    // Always use calendar picker for reliable date selection
    const dateSelected = await selectDateRange(page, date);
    if (!dateSelected) {
      throw new Error(`[Shopify] Could not select date ${date} via calendar picker`);
    }

    // Wait for analytics breakdown to render in shadow DOM (up to 45s)
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
      }, {}, { timeout: 45000 });
    } catch (_) { /* proceed */ }

    // Scroll the full page height to trigger all lazy sections
    const pageHeight = await page.evaluate(() => document.body.scrollHeight);
    const steps = Math.ceil(pageHeight / 700);
    for (let s = 0; s <= steps; s++) {
      await page.evaluate(pos => window.scrollTo(0, pos), s * 700);
      await page.waitForTimeout(350);
    }

    // Wait for sessions summary card
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
        for (let i = 0; i < tokens.length; i++) {
          if (tokens[i] === 'Sessions' && /^\d+$/.test(tokens[i+1]) && /^(Increase|Decrease) of/.test(tokens[i+2] || '')) {
            return true;
          }
        }
        return false;
      }, {}, { timeout: 30000 });
    } catch (_) { /* proceed */ }

    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(800);

    const data = await page.evaluate(() => {
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
      const tsoIdx = tokens.lastIndexOf('Total sales over time');
      const tsbIdx = tokens.findIndex(t => t === 'Total sales breakdown');
      const section = (tsoIdx >= 0 && tsbIdx > tsoIdx)
        ? tokens.slice(tsoIdx, tsbIdx)
        : tokens;

      const BREAKDOWN_LABELS = ['Gross sales','Discounts','Returns','Net sales','Shipping charges','Return fees','Taxes','Total sales'];
      const breakdown = {};
      for (let i = 0; i < section.length; i++) {
        if (BREAKDOWN_LABELS.includes(section[i])) {
          const next = section[i + 1] || '';
          if (/^-?RM/.test(next)) breakdown[section[i]] = parseRM(next);
        }
      }

      // ── Card extraction helper ────────────────────────────────────────────
      function cardValue(label) {
        for (let i = 0; i < tokens.length; i++) {
          if (tokens[i] !== label) continue;
          const next = tokens[i+1] || '';
          if (next.toLowerCase().startsWith(label.toLowerCase()) && next.toLowerCase().includes('over time')) {
            return tokens[i+3] || null;
          }
        }
        return null;
      }

      // ── Orders ────────────────────────────────────────────────────────────
      const ordersFulfilledRaw = cardValue('Orders fulfilled');
      const ordersFulfilled = ordersFulfilledRaw && /^\d+$/.test(ordersFulfilledRaw)
        ? parseInt(ordersFulfilledRaw, 10) : null;

      const ordersPlacedRaw = cardValue('Orders');
      const ordersPlaced = ordersPlacedRaw && /^\d+$/.test(ordersPlacedRaw)
        ? parseInt(ordersPlacedRaw, 10) : null;

      // ── Returning customer rate ───────────────────────────────────────────
      let returningCustomerRate = null;
      const rcrIdx = tokens.findIndex(t => t === 'Returning customer rate over time');
      if (rcrIdx >= 0) {
        for (let j = rcrIdx + 1; j < rcrIdx + 15; j++) {
          if (/^\d+\.?\d*%$/.test(tokens[j])) { returningCustomerRate = parsePct(tokens[j]); break; }
        }
      }

      // ── Average order value ───────────────────────────────────────────────
      let avgOrderValue = null;
      const aovIdx = tokens.findIndex(t => t === 'Average order value over time');
      if (aovIdx >= 0) {
        for (let j = aovIdx + 1; j < aovIdx + 20; j++) {
          if (/^RM\s*[\d,]+\.\d{2}$/.test(tokens[j])) { avgOrderValue = parseRM(tokens[j]); break; }
        }
      }

      // ── Sessions ──────────────────────────────────────────────────────────
      let sessions = null;
      for (let i = 0; i < tokens.length; i++) {
        if (tokens[i] === 'Sessions' && /^\d+$/.test(tokens[i+1]) && /^(Increase|Decrease) of/.test(tokens[i+2] || '')) {
          sessions = parseInt(tokens[i+1], 10); break;
        }
      }
      if (sessions === null) {
        const sotIdx = tokens.findIndex(t => t === 'Sessions over time');
        if (sotIdx >= 0 && tokens[sotIdx+1] === 'Sessions over time') {
          const count = tokens[sotIdx + 3];
          if (/^\d+$/.test(count)) sessions = parseInt(count, 10);
        }
      }
      if (sessions === null) {
        for (let i = 0; i < tokens.length; i++) {
          if (tokens[i] === 'Sessions' && tokens[i+1] === '100%' && /^\d+$/.test(tokens[i+2])) {
            sessions = parseInt(tokens[i+2], 10); break;
          }
        }
      }
      if (sessions === null) {
        for (let i = 0; i < tokens.length; i++) {
          if (tokens[i] === 'Sessions' && /^\d{2,}$/.test(tokens[i+1]) && /^[\d.]+%$/.test(tokens[i+2])) {
            sessions = parseInt(tokens[i+1], 10); break;
          }
        }
      }

      // ── Conversion rate ───────────────────────────────────────────────────
      let conversionRate = null;
      const crIdx = tokens.findIndex(t => t === 'Conversion rate over time');
      if (crIdx >= 0) {
        for (let j = crIdx + 1; j < crIdx + 15; j++) {
          if (/^\d+\.?\d*%$/.test(tokens[j])) { conversionRate = parsePct(tokens[j]); break; }
        }
      }

      return {
        totalSales:           breakdown['Total sales']        ?? null,
        grossSales:           breakdown['Total sales']        ?? null,
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

    // Log what we got to verify the date picker worked
    console.log(`[Shopify] Scraped for ${date}: totalSales=${data.totalSales}, orders=${data.ordersPlaced ?? data.ordersFulfilled}, sessions=${data.sessions}`);

    return data;
  } finally {
    await page.close(); // close tab only — never close the browser
  }
}

// Public entry point — wraps _scrapeImpl with a hard 4-minute timeout.
// page.evaluate() has no built-in timeout in Playwright, so we guard here.
async function scrape(date) {
  return Promise.race([
    _scrapeImpl(date),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Shopify scrape timed out after 7 minutes')), 420000)
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
