/**
 * Lazada session keepalive.
 *
 * WHY: Lazada Seller Center logins are short-lived — the t_sid / EGG_SESS session
 * tokens are ~1-hour ROLLING cookies (refreshed on every authenticated page load,
 * but they die ~1h after the last visit). A once-a-day nightly scrape can't keep a
 * 1-hour session alive, so Lazada is logged out by the time the 00:30 run fires
 * (and the 06:00 backstop too). The fix: touch a lightweight authenticated Lazada
 * page every ~45 min to roll the session forward, so it's always alive at 00:30.
 *
 * This only MAINTAINS a live session — it cannot revive a dead one. Arm it with one
 * clean `npm run login`, after which it keeps Lazada logged in indefinitely. If it
 * ever finds Lazada logged out, it logs a loud warning (exit 2) so we re-login.
 *
 * Safe by design: it launches the shared Chrome profile, so if a real scrape is
 * already running, the profile is locked and launch fails — the keepalive just
 * skips that cycle (exit 0) rather than colliding with the nightly / backstop.
 *
 * Run by scrapers/keepalive.ps1 (scheduled every 45 min). Standalone:
 *   node scrapers/keepalive.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const cdp = require('./cdp');

const HOME_URL = 'https://sellercenter.lazada.com.my/';
const onLoginPage = (url) => /\/(login|register|signin)/.test(new URL(url).pathname);

async function touch() {
  // If the profile is locked (a scrape is running), launching fails — skip this cycle.
  let ctx;
  try {
    ctx = await cdp.getContext();
  } catch (e) {
    console.log(`[Keepalive] profile busy (scrape running?) — skipping this cycle: ${e.message}`);
    return 0;
  }

  const page = await ctx.newPage();
  try {
    await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Lazada momentarily lands on /login then auto-redirects to the dashboard when a
    // valid session exists (5-10s). Wait for that to settle before judging login state.
    if (onLoginPage(page.url())) {
      try { await page.waitForURL((u) => !onLoginPage(u.toString()), { timeout: 18000 }); } catch (_) {}
    }
    await page.waitForTimeout(2000);
    const url = page.url();

    if (onLoginPage(url)) {
      console.warn('[Keepalive] LAZADA LOGGED OUT — session lapsed. Re-arm with: npm run login');
      return 2;
    }
    console.log(`[Keepalive] OK — Lazada session refreshed (${url})`);
    return 0;
  } finally {
    await page.close().catch(() => {});
    // Graceful close flushes the refreshed cookies to disk and frees the profile lock
    // for the next scrape / keepalive cycle.
    await cdp.closeBrowser().catch(() => {});
  }
}

// Hard timeout so a hung Lazada page can never leave the keepalive (and its Chrome)
// running between cycles.
async function main() {
  return Promise.race([
    touch(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('keepalive timed out after 90s')), 90000)),
  ]);
}

main()
  .then((code) => process.exit(code))
  .catch((e) => { console.error('[Keepalive] error:', e.message); process.exit(1); });
