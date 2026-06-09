/**
 * One-time interactive login for the scraper's Chrome profile.
 *
 * Run this whenever a platform session has expired (Lazada/TikTok expire most
 * often). It opens the dedicated scraper Chrome with one tab per platform; you
 * log in by hand, then press ENTER here to save and close. A graceful close
 * flushes the cookies into scrapers/profiles/chrome-cdp so the nightly scrape
 * reuses them.
 *
 *   node scrapers/login.js          (or: npm run login)
 *
 * Do NOT run this while a scrape is in progress — the profile allows only one
 * Chrome at a time.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const cdp = require('./cdp');

const LOGINS = [
  { id: 'shopify', url: 'https://admin.shopify.com/store/shero-cosmetics-my/analytics' },
  { id: 'shopee',  url: 'https://seller.shopee.com.my' },
  { id: 'lazada',  url: 'https://sellercenter.lazada.com.my' },
  { id: 'tiktok',  url: 'https://seller-my.tiktok.com/compass/data-overview?shop_region=MY' },
];

(async () => {
  console.log('[Login] Opening the scraper Chrome…');
  const ctx = await cdp.getContext();

  for (const l of LOGINS) {
    const page = await ctx.newPage();
    await page.goto(l.url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    console.log(`[Login]   ${l.id.padEnd(8)} → ${l.url}`);
  }

  console.log('\n[Login] Log in to each tab (Shopify, Shopee, Lazada, TikTok).');
  console.log('[Login] When all four show their dashboards, come back here and press ENTER.');

  await new Promise(resolve => {
    process.stdin.resume();
    process.stdin.once('data', resolve);
  });

  console.log('[Login] Saving sessions and closing…');
  await cdp.closeBrowser();
  console.log('[Login] Done. Sessions saved to the profile. You can close this window.');
  process.exit(0);
})().catch(err => { console.error('[Login] Failed:', err); process.exit(1); });
