/**
 * Shopify scraper — scrapes Analytics > Overview for daily revenue & orders.
 *
 * Requires the always-on Chrome to be running:  npm run start-browser
 * Log in to Shopify in that browser once — sessions persist indefinitely.
 */
const cdp        = require('./cdp');
const STORE_URL  = 'https://admin.shopify.com/store/shero-cosmetics-my';

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
  const { page } = await cdp.newPage();

  try {
    await page.goto(`${STORE_URL}/analytics`, {
      waitUntil: 'domcontentloaded',
      timeout:   30000,
    });

    // Check if logged in
    if (page.url().includes('accounts.shopify.com') || page.url().includes('/login')) {
      throw new Error('NOT_LOGGED_IN: Open the scraper browser and log in to Shopify.');
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
      }, {}, { timeout: 20000 });
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

    return data;
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
