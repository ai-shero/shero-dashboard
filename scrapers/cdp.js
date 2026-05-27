/**
 * CDP connector — attaches Playwright to the always-on Chrome instance.
 *
 * Setup (one time):
 *   1. npm run start-browser   ← launches Chrome with remote debugging
 *   2. Log in to Shopify, Shopee, Lazada in that browser window
 *   3. Minimise — never close it
 *
 * The midnight scraper calls newPage() which opens a fresh tab in the
 * already-logged-in browser, scrapes, then closes only the tab.
 * Chrome itself stays open and sessions stay alive indefinitely.
 *
 * IMPORTANT: callers must call page.close() when done — NEVER browser.close().
 */
const { chromium } = require('playwright');

const CDP_URL = 'http://localhost:9222';

/**
 * Open a fresh tab in the running Chrome's default context.
 * Returns { browser, page }.
 */
async function newPage() {
  let browser;
  try {
    browser = await chromium.connectOverCDP(CDP_URL);
  } catch (e) {
    throw new Error(
      `[CDP] Chrome is not running with remote debugging on port 9222.\n` +
      `Start it with:  npm run start-browser\n` +
      `Then log in to Shopify, Shopee, and Lazada in the browser and minimise it.\n` +
      `Error: ${e.message}`
    );
  }

  const contexts = browser.contexts();
  if (!contexts.length) {
    throw new Error('[CDP] No browser context found — is Chrome still starting up?');
  }

  const page = await contexts[0].newPage();
  return { browser, page };
}

module.exports = { newPage };
