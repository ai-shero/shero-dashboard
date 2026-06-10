/**
 * Automatic re-login fallback.
 *
 * When a scraper throws NOT_LOGGED_IN, run.js calls autoLogin(channel) before
 * giving up. With credentials configured in .env, this fills the platform's
 * login form and submits. Because the scraper Chrome is a persistent profile
 * (a "known device"), platforms usually skip OTP — so this succeeds silently
 * most of the time. When a platform DOES demand OTP/captcha, we bail out
 * gracefully: the scrape stays failed and the existing per-channel health
 * warnings + `npm run login` flow take over. Strictly an upgrade, never worse.
 *
 * Credentials (.env — NEVER commit; .env is gitignored):
 *   LAZADA_EMAIL / LAZADA_PASSWORD     (already present)
 *   TIKTOK_EMAIL / TIKTOK_PASSWORD
 *   SHOPEE_EMAIL / SHOPEE_PASSWORD
 *   SHOPIFY_EMAIL / SHOPIFY_PASSWORD
 *
 * Safety: at most ONE attempt per channel per process — repeated failed
 * password attempts risk an account lockout, which is worse than a stale day.
 */
const path = require('path');
const fs = require('fs');
const cdp = require('./cdp');

const LOG_DIR = path.join(__dirname, 'logs');

const PLATFORMS = {
  lazada: {
    loginUrl: 'https://sellercenter.lazada.com.my/apps/seller/login',
    userSel: ['input[name="account"]', 'input[type="text"]', 'input[placeholder*="mail" i]', 'input[placeholder*="phone" i]'],
    passSel: ['input[name="password"]', 'input[type="password"]'],
    submitSel: ['button[type="submit"]', 'button:has-text("Login")', 'button:has-text("LOG IN")', 'button:has-text("Sign in")'],
    loggedOutRe: /\/(login|register|signin)/i,
    captchaSel: ['.nc-container', '#baxia-dialog-content', 'iframe[src*="captcha" i]', '[class*="slider" i][class*="captcha" i]'],
  },
  tiktok: {
    loginUrl: 'https://seller-my.tiktok.com/account/login',
    // TikTok passport often defaults to phone/QR — try to switch to email tab first.
    preSteps: async (page) => {
      for (const sel of ['text=Email', 'text=Log in with email', '[class*="email" i]']) {
        try { await page.locator(sel).first().click({ timeout: 3000 }); break; } catch (_) {}
      }
    },
    userSel: ['input[name="email"]', 'input[type="text"]', 'input[placeholder*="mail" i]'],
    passSel: ['input[name="password"]', 'input[type="password"]'],
    submitSel: ['button[type="submit"]', 'button:has-text("Log in")', 'button:has-text("Login")'],
    loggedOutRe: /(login|passport)/i,
    captchaSel: ['[id*="captcha" i]', '.captcha_verify_container', 'iframe[src*="captcha" i]'],
  },
  shopee: {
    loginUrl: 'https://accounts.shopee.com.my/seller/login',
    userSel: ['input[name="loginKey"]', 'input[type="text"]', 'input[placeholder*="mail" i]'],
    passSel: ['input[name="password"]', 'input[type="password"]'],
    submitSel: ['button[type="submit"]', 'button:has-text("Log In")', 'button:has-text("Log in")'],
    loggedOutRe: /(\/login|accounts\.shopee)/i,
    captchaSel: ['[class*="captcha" i]', 'iframe[src*="captcha" i]'],
  },
  shopify: {
    loginUrl: 'https://accounts.shopify.com/lookup',
    // Shopify is two-step: email -> Continue -> password -> Log in.
    twoStep: true,
    userSel: ['input[type="email"]', 'input[name="account[email]"]'],
    passSel: ['input[type="password"]', 'input[name="account[password]"]'],
    submitSel: ['button[type="submit"]'],
    loggedOutRe: /(accounts\.shopify\.com|\/login)/i,
    captchaSel: ['iframe[src*="captcha" i]', 'iframe[src*="challenge" i]'],
  },
};

const attempted = new Set();   // one attempt per channel per process

async function fillFirst(page, selectors, value) {
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      await loc.waitFor({ state: 'visible', timeout: 4000 });
      await loc.fill(value);
      return true;
    } catch (_) { /* try next */ }
  }
  return false;
}

async function clickFirst(page, selectors) {
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      await loc.waitFor({ state: 'visible', timeout: 4000 });
      await loc.click();
      return true;
    } catch (_) { /* try next */ }
  }
  return false;
}

async function hasCaptcha(page, selectors) {
  for (const sel of selectors) {
    try { if (await page.locator(sel).first().isVisible({ timeout: 500 })) return true; } catch (_) {}
  }
  return false;
}

async function snapshot(page, channel, tag) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const file = path.join(LOG_DIR, `auto-login-${channel}-${tag}-${Date.now()}.png`);
    await page.screenshot({ path: file });
    console.log(`[AutoLogin] ${channel} — screenshot saved: ${file}`);
  } catch (_) {}
}

/**
 * Attempt an unattended re-login for `channel`.
 * Returns true if we end up off the login page (session restored).
 */
async function autoLogin(channel) {
  const p = PLATFORMS[channel];
  const C = channel.toUpperCase();
  const user = process.env[`${C}_EMAIL`] || process.env[`${C}_USER`];
  const pass = process.env[`${C}_PASSWORD`] || process.env[`${C}_PASS`];

  if (!p) return false;
  if (!user || !pass) {
    console.log(`[AutoLogin] ${channel} — no credentials in .env (${C}_EMAIL/${C}_PASSWORD), skipping.`);
    return false;
  }
  if (attempted.has(channel)) {
    console.log(`[AutoLogin] ${channel} — already attempted this run, not retrying (lockout safety).`);
    return false;
  }
  attempted.add(channel);

  console.log(`[AutoLogin] ${channel} — attempting unattended re-login…`);
  const { page } = await cdp.newPage();
  try {
    await page.goto(p.loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    // Session may have silently recovered (e.g. device-token refresh on visit).
    if (!p.loggedOutRe.test(page.url())) {
      console.log(`[AutoLogin] ${channel} — already logged in after visiting login URL.`);
      return true;
    }

    if (p.preSteps) await p.preSteps(page);

    if (!await fillFirst(page, p.userSel, user)) {
      console.log(`[AutoLogin] ${channel} — could not find username field.`);
      await snapshot(page, channel, 'no-user-field');
      return false;
    }

    if (p.twoStep) {
      // email -> Continue, then wait for the password step to render
      await clickFirst(page, p.submitSel);
      await page.waitForTimeout(4000);
    }

    if (!await fillFirst(page, p.passSel, pass)) {
      console.log(`[AutoLogin] ${channel} — could not find password field.`);
      await snapshot(page, channel, 'no-pass-field');
      return false;
    }

    if (await hasCaptcha(page, p.captchaSel)) {
      console.log(`[AutoLogin] ${channel} — captcha present, cannot proceed unattended. Run: npm run login`);
      await snapshot(page, channel, 'captcha');
      return false;
    }

    if (!await clickFirst(page, p.submitSel)) {
      console.log(`[AutoLogin] ${channel} — could not find submit button.`);
      await snapshot(page, channel, 'no-submit');
      return false;
    }

    // Wait for the login page to go away (redirect to dashboard).
    try {
      await page.waitForURL(url => !p.loggedOutRe.test(typeof url === 'string' ? url : url.href), { timeout: 25000 });
    } catch (_) { /* judged below */ }
    await page.waitForTimeout(3000);

    if (p.loggedOutRe.test(page.url())) {
      const why = await hasCaptcha(page, p.captchaSel) ? 'captcha/OTP challenge' : 'still on login page';
      console.log(`[AutoLogin] ${channel} — failed (${why}). Manual login needed: npm run login`);
      await snapshot(page, channel, 'failed');
      return false;
    }

    console.log(`[AutoLogin] ${channel} — SUCCESS, session restored.`);
    return true;
  } catch (e) {
    console.log(`[AutoLogin] ${channel} — error: ${e.message}`);
    return false;
  } finally {
    await page.close().catch(() => {});
  }
}

module.exports = { autoLogin };
