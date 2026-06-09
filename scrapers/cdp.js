/**
 * Browser provider — self-launches a dedicated Chrome via Playwright's
 * persistent context.
 *
 * WHY: the previous model attached over CDP to an externally-running Chrome on
 * port 9222. On an always-on machine that already has a normal Chrome open,
 * launching a second Chrome for the debug port silently fails to bind 9222, so
 * every nightly scrape aborted (the Jun 4–8 data gap). Playwright launches and
 * drives its own Chrome process directly, with no external port dependency —
 * it works even when the session is locked.
 *
 * The dedicated profile (scrapers/profiles/chrome-cdp) keeps the Shopify /
 * Shopee / Lazada / TikTok logins between runs.
 *
 * Lifecycle:
 *   newPage()      → lazily launches the shared Chrome on first call, opens a tab
 *   page.close()   → each scraper closes ONLY its own tab (never the context)
 *   closeBrowser() → run.js calls this once at the very end; a graceful close
 *                    flushes cookies/sessions back to the profile on disk
 *
 * Re-login (one time, or when a platform session expires):
 *   node scrapers/login.js   (or: npm run login)
 *
 * NOTE: the profile can only be open in ONE Chrome at a time. Don't run a scrape
 * and login.js simultaneously, and make sure no leftover raw Chrome is holding
 * the profile (the old "Chrome CDP" scheduled task must stay disabled).
 */
const { chromium } = require('playwright');
const path = require('path');

const PROFILE_DIR = path.join(__dirname, 'profiles', 'chrome-cdp');

const LAUNCH_OPTS = {
  headless: false,            // headed real Chrome — needed for anti-bot on Shopee/Lazada/TikTok
  channel: 'chrome',         // use the installed Google Chrome, not bundled Chromium
  viewport: { width: 1440, height: 900 },
  args: [
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-session-crashed-bubble',
    '--hide-crash-restore-bubble',
    '--start-maximized',
  ],
};

let _context = null;

/** Lazily launch (or reuse) the single shared persistent context. */
async function getContext() {
  if (_context) return _context;
  _context = await chromium.launchPersistentContext(PROFILE_DIR, LAUNCH_OPTS);
  return _context;
}

/**
 * Open a fresh tab in the shared Chrome. Returns { browser, page } where
 * `browser` is the persistent BrowserContext (kept for signature compatibility —
 * scrapers should only ever touch `page` and call page.close()).
 */
async function newPage() {
  const context = await getContext();
  const page = await context.newPage();
  return { browser: context, page };
}

/** Close the shared Chrome gracefully. Persists sessions. Safe to call twice. */
async function closeBrowser() {
  if (!_context) return;
  try { await _context.close(); } catch { /* already gone */ }
  _context = null;
}

module.exports = { newPage, closeBrowser, getContext, PROFILE_DIR, LAUNCH_OPTS };
