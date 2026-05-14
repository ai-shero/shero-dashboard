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

const SESSION_FILE  = path.join(__dirname, 'sessions', 'shopee.json');
const LOGIN_URL     = 'https://seller.shopee.com.my/portal/login';
const HOME_URL      = 'https://seller.shopee.com.my/';
const INSIGHT_URL   = 'https://seller.shopee.com.my/datacenter/';

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
  console.log('[Shopee] Session will be saved automatically once you reach the Seller Centre.');

  // Wait until the browser navigates away from the login page (up to 5 minutes)
  await page.waitForURL(
    url => !url.toString().includes('/login') && !url.toString().includes('/verify'),
    { timeout: 300000 }
  );
  // Let the landing page settle
  await page.waitForTimeout(2000);

  fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
  await context.storageState({ path: SESSION_FILE });
  console.log('[Shopee] ✓ Session saved to', SESSION_FILE);
  await browser.close();
}

/* ─── date selection ─────────────────────────────────────────────────────── */
async function selectDate(page, targetDate) {
  // Shopee datacenter has preset buttons: Real-Time, Yesterday, Past 7 Days, etc.
  // For daily scraping we always want "Yesterday". For older dates we use the calendar.
  const myt       = new Date(Date.now() + 8 * 3600000);
  const yesterday = new Date(+myt - 86400000).toISOString().slice(0, 10);

  try {
    if (targetDate === yesterday) {
      // Click the "Yesterday" preset — simplest and most reliable
      const clicked = await page.evaluate(() => {
        for (const el of document.querySelectorAll('div, span, button, li')) {
          if (el.textContent?.trim() === 'Yesterday' && !el.querySelector('*')) {
            el.click(); return true;
          }
        }
        // Fallback: any element with exactly "Yesterday" text
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
    // Open the date picker
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

    // Click the target day in the calendar
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

    // Click same day again (start = end)
    await page.evaluate((d) => {
      for (const el of document.querySelectorAll('td, [class*="day"], [class*="Day"]')) {
        if (el.childElementCount === 0 && el.textContent?.trim() === String(d)) {
          el.click(); return true;
        }
      }
      return false;
    }, day);

    // Confirm
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

  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({
    storageState: SESSION_FILE,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });

  const page = await context.newPage();

  // Load home first to establish SPA context, then navigate to Business Insights
  await page.goto(HOME_URL, { waitUntil: 'networkidle', timeout: 30000 });

  // Session expired check
  if (page.url().includes('/login') || page.url().includes('/accounts.shopee')) {
    await browser.close();
    throw new Error('SESSION_EXPIRED');
  }

  await page.goto(INSIGHT_URL, { waitUntil: 'networkidle', timeout: 30000 });
  console.log('[Shopee] On page:', page.url());

  // Wait for Key Metrics section to render
  try {
    await page.waitForFunction(
      () => document.body.innerText.includes('Key Metrics'),
      { timeout: 20000 }
    );
  } catch (_) {
    console.warn('[Shopee] Key Metrics did not load in time — proceeding anyway');
  }

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

    // Anchor to "Key Metrics" so we skip nav/tab duplicates of the same labels
    const anchor = Math.max(0, tokens.indexOf('Key Metrics'));

    // RM value: label → [description...] → "RM" → "1,234.56"  (two separate tokens)
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

    // Integer count: label → [description...] → integer (no decimal)
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

    // Percentage: label → [description...] → "3.89" → "%"
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

    // ── Extract ───────────────────────────────────────────────────────────
    const revenue        = findRM('Sales', anchor);
    const orders         = findCount('Orders', anchor);
    const sessions       = findCount('Visitors', anchor);
    const clicks         = findCount('Product Clicks', anchor);
    const conversionRate = findPct('Order Conversion Rate', anchor);
    const adSpend        = findRM('Ad Expense', anchor)
                        ?? findRM('Total Ad Spend', anchor);
    const roas = (() => {
      for (let i = anchor; i < tokens.length; i++) {
        if (tokens[i] === 'ROAS') {
          for (let j = i + 1; j < Math.min(i + 20, tokens.length); j++) {
            if (/^\d+\.?\d*x?$/.test(tokens[j])) return parseFloat(tokens[j]);
          }
        }
      }
      return null;
    })();

    return {
      revenue, orders, sessions, clicks, conversionRate, adSpend, roas,
      rawTokens: tokens.slice(0, 400),
      url:       window.location.href,
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
