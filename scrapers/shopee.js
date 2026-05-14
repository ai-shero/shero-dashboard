/**
 * Shopee Seller Centre scraper — scrapes Business Insight for daily metrics.
 *
 * Login : npm run login:shopee
 *   Opens a visible browser. Log in with email + password + email OTP.
 *   Session saved to scrapers/sessions/shopee.json
 *
 * Scrape: node scrapers/shopee.js  (or called by scrapers/run.js)
 *   Uses saved session headlessly.
 */
const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const path = require('path');
const fs   = require('fs');

chromium.use(StealthPlugin());

const SESSION_FILE = path.join(__dirname, 'sessions', 'shopee.json');
const LOGIN_URL    = 'https://seller.shopee.com.my/portal/login';
const INSIGHT_URL  = 'https://seller.shopee.com.my/portal/business-insight';

/* ─── login ─────────────────────────────────────────────────────────────── */
async function login() {
  console.log('');
  console.log('[Shopee] Opening browser for manual login...');
  console.log('[Shopee] Log in with your email + password, then enter the email OTP.');
  console.log('[Shopee] Once you can see the Seller Centre dashboard, press Enter here.');
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
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (_) {}

  console.log('[Shopee] Browser is open. Complete login (email → password → OTP).');
  console.log('[Shopee] Press Enter once you see the Seller Centre home page.');

  await new Promise(resolve => {
    process.stdin.resume();
    process.stdin.once('data', () => { process.stdin.pause(); resolve(); });
  });

  fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
  await context.storageState({ path: SESSION_FILE });
  console.log('[Shopee] ✓ Session saved to', SESSION_FILE);
  await browser.close();
}

/* ─── date selection ─────────────────────────────────────────────────────── */
async function selectDate(page, targetDate) {
  // Shopee Business Insight has a date range picker at the top.
  // We look for the date trigger button and set both start + end to targetDate.
  try {
    // Open the date picker — button typically shows current range or a calendar icon
    const opened = await page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll('button, [role="button"]'));
      for (const el of candidates) {
        const text = el.textContent?.trim() || '';
        if (/\d{4}[-\/]\d{2}[-\/]\d{2}/.test(text) || /Yesterday|Today|Last \d+ days|Custom/i.test(text)) {
          el.click(); return true;
        }
      }
      // Fallback: look for calendar icon wrapper
      for (const el of document.querySelectorAll('[class*="date"], [class*="Date"], [class*="picker"], [class*="Picker"]')) {
        if (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') {
          el.click(); return true;
        }
      }
      return false;
    });

    if (!opened) return;
    await page.waitForTimeout(600);

    // Click "Custom" / "Custom Range" option if the picker shows presets
    await page.evaluate(() => {
      for (const el of document.querySelectorAll('li, [role="option"], [class*="option"], [class*="item"]')) {
        const t = el.textContent?.trim();
        if (t === 'Custom' || t === 'Custom Range' || t === 'Customise') {
          el.click(); return true;
        }
      }
      return false;
    });
    await page.waitForTimeout(400);

    // Fill both start and end inputs with targetDate
    const inputs = await page.$$('input[type="text"], input[class*="date"], input[class*="Date"]');
    for (const input of inputs.slice(0, 2)) {
      await input.triple_click?.() || await input.click({ clickCount: 3 });
      await input.fill(targetDate);
      await page.waitForTimeout(200);
    }

    // Confirm — try Apply / Confirm / OK in that order
    await page.evaluate(() => {
      for (const btn of document.querySelectorAll('button')) {
        const t = btn.textContent?.trim();
        if (t === 'Apply' || t === 'Confirm' || t === 'OK' || t === 'Search') {
          btn.click(); return true;
        }
      }
      return false;
    });
    await page.waitForTimeout(2000);
  } catch (_) {
    // Date selection failed — proceed with whatever date range is already shown
  }
}

/* ─── text extraction ────────────────────────────────────────────────────── */
function allTextNodes(root) {
  const texts = [];
  const walker = root.ownerDocument
    ? root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    : document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const v = node.nodeValue.trim();
    if (v && v.length < 300) texts.push(v);
  }
  for (const el of root.querySelectorAll('*')) {
    if (el.shadowRoot) texts.push(...allTextNodes(el.shadowRoot));
  }
  return texts;
}

/* ─── scrape ─────────────────────────────────────────────────────────────── */
async function scrape(date) {
  if (!fs.existsSync(SESSION_FILE)) {
    throw new Error('No session found. Run: npm run login:shopee');
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    storageState: SESSION_FILE,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });

  const page = await context.newPage();

  await page.goto(INSIGHT_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Session expired check
  if (page.url().includes('/login') || page.url().includes('/accounts.shopee')) {
    await browser.close();
    throw new Error('SESSION_EXPIRED');
  }

  // Wait for initial render
  await page.waitForTimeout(3000);

  // Set date range to target date
  await selectDate(page, date);

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
    function allTextNodes(root) {
      const texts = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const v = node.nodeValue.trim();
        if (v && v.length < 300) texts.push(v);
      }
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) texts.push(...allTextNodes(el.shadowRoot));
      }
      return texts;
    }

    const tokens = allTextNodes(document.body);

    function parseNum(s) {
      if (!s) return null;
      const clean = s.replace(/[^\d.\-]/g, '');
      const n = parseFloat(clean);
      return isNaN(n) ? null : n;
    }
    function parsePct(s) {
      if (!s) return null;
      const n = parseFloat(s.replace(/[^\d.\-]/g, ''));
      return isNaN(n) ? null : n;
    }
    function parseInt2(s) {
      if (!s) return null;
      const n = parseInt(s.replace(/[^\d]/g, ''), 10);
      return isNaN(n) ? null : n;
    }

    // Find the value that follows a given label in the token stream.
    // Looks up to `window` tokens ahead for something that looks like a number.
    function findAfterLabel(label, window = 6) {
      for (let i = 0; i < tokens.length; i++) {
        if (tokens[i] !== label) continue;
        for (let j = i + 1; j < Math.min(i + 1 + window, tokens.length); j++) {
          const t = tokens[j];
          // RM 1,234.56 | 1,234 | 12.34% | 1.23x
          if (/^RM[\s\d,]+/.test(t) || /^[\d,]+\.?\d*$/.test(t) || /^\d+\.?\d*%$/.test(t) || /^\d+\.?\d*x$/.test(t)) {
            return t;
          }
        }
      }
      return null;
    }

    // ── Metric extraction ─────────────────────────────────────────────────
    const totalIncomeRaw  = findAfterLabel('Total Income');
    const salesMyrRaw     = findAfterLabel('Sales (MYR)');
    const visitorsRaw     = findAfterLabel('Visitors');
    const ordersRaw       = findAfterLabel('Orders');
    const clicksRaw       = findAfterLabel('Clicks');
    // Conv% label may vary across Shopee UI versions
    const convRaw         = findAfterLabel('Conv.%')
                         ?? findAfterLabel('Conv%')
                         ?? findAfterLabel('Conv. Rate')
                         ?? findAfterLabel('Conversion Rate');
    const adExpenseRaw    = findAfterLabel('Ad Expense');
    const roasRaw         = findAfterLabel('ROAS');

    return {
      revenue:        totalIncomeRaw ? parseNum(totalIncomeRaw)  : null,
      grossSales:     salesMyrRaw    ? parseNum(salesMyrRaw)     : null,
      sessions:       visitorsRaw    ? parseInt2(visitorsRaw)    : null,  // stored in sessions col
      orders:         ordersRaw      ? parseInt2(ordersRaw)      : null,
      clicks:         clicksRaw      ? parseInt2(clicksRaw)      : null,
      conversionRate: convRaw        ? parsePct(convRaw)         : null,
      adSpend:        adExpenseRaw   ? parseNum(adExpenseRaw)    : null,
      roas:           roasRaw        ? parseNum(roasRaw)         : null,
      // Debug: first 200 tokens so we can inspect if parsing breaks
      rawTokens:      tokens.slice(0, 200),
      url:            window.location.href,
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
    scrape(args[0] || today)
      .then(d => console.log(JSON.stringify(d, null, 2)))
      .catch(console.error);
  }
}
