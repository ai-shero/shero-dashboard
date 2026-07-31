# SHERO Dashboard (SHERO OPS) — Context for Claude Code

Consolidated **sales dashboard** for SHERO Cosmetics (Amber Aspire Sdn Bhd) — one screen showing
revenue + orders across **7 sales channels**, plus the daily morning review. Sister app to SHERO POS
(`Claude/shero-pos/bloom-pos`), Invoicing, HR, CRM, and Inventory.

**Core idea: this app does NOT own any sales data.** It is a read/aggregation layer. Each night a set
of headless-browser scrapers pull yesterday's numbers from each platform into a local cache
(`cached_data`); the web server just reads that cache and sums it. Channels with no scrape are entered
by hand (`manual_entries`).

## The 7 channels
| Channel | How it's collected | Notes |
|---|---|---|
| **Shopify** | Admin API + scraper | richest metrics (sessions, conversion, AOV, returns…) |
| **Shopee** | Playwright scraper | authoritative gross via Business Insights "By Month" API; needs `SHOPEE_FINANCE_PIN` |
| **Lazada** | Playwright scraper | date-accurate gross from BA `overviewV2` payAmount; **falls back to manual** if login expired |
| **TikTok Shop** | Playwright scraper | **falls back to manual** if not live |
| **SHERO POS** | POS API pull | `GET {POS_API_URL}/api/sales/summary?start&end`; falls back to `manual_entries` |
| **Parkson** | **manual only** | physical counter — keyed in on the Manual tab |
| **Watsons** | **manual only** | physical counter — keyed in on the Manual tab |

## Stack
- **Backend**: Node.js + Express (`server/`). Entry `server/index.js`, mounts routes + serves the SPA.
- **DB**: Turso (hosted libsql / SQLite) via `@libsql/client`. Falls back to local `file:shero.db`
  when `TURSO_URL`/`TURSO_TOKEN` aren't set.
- **Frontend**: single-file vanilla HTML/JS/CSS at `client/public/index.html`. No build step, no framework.
- **Scrapers**: Playwright + `playwright-extra` + `puppeteer-extra-plugin-stealth`, driven over CDP
  against a **persistent Chrome profile** (`scrapers/profiles/`, sessions in `scrapers/sessions/`).
  Run out-of-process by a Windows Scheduled Task — **not** by the web server (see Scraping below).
- **Deploy**: Render, auto-deploy. ⚠️ **Deploy branch is `master`, not `main`** (see `render.yaml` /
  `origin/HEAD → master`). Node ≥ 20.

## Running Locally
```bash
npm install
npm run dev          # nodemon, serves http://localhost:3200
```
`.env.example` defaults `PORT=3200` — **this collides with SHERO Invoicing (also 3200)**; set a
different `PORT` if you run both at once. No Turso needed locally (file-backed `shero.db`).

Scraper commands (run on the machine that holds the logged-in Chrome profile — i.e. Sher Min's PC,
not Render):
```bash
npm run login            # opens Chrome, log in to each platform, press ENTER to save the session
npm run login:tiktok     # TikTok-only login
npm run scrape           # self-healing scrape (see below)
npm run install-startup  # register the nightly Windows Scheduled Task
```

## Data Model (`server/db.js#init`)
- **`cached_data`** — one row per `(channel, entry_date)`. `revenue` + `orders` core, plus scaffolded
  Shopify columns (`gross_sales, discounts, returns, net_sales, shipping_charges, return_fees, taxes,
  orders_fulfilled, avg_order_value, sessions, conversion_rate, returning_customer_rate`) and Shopee
  columns (`clicks, roas`). Added as idempotent `ALTER TABLE` in `init()`.
- **`manual_entries`** — hand-keyed numbers, one row per `(channel, entry_date)`. Source for
  Parkson/Watsons and the fallback for POS/Lazada/TikTok.
- **`product_rankings`** — top-N units-sold per `(channel, entry_date, rank)`. Replaced atomically per
  day by the scrapers.
- **`settings`** — key/value single rows (e.g. `last_scrape` heartbeat, `pos_api_url`).

> ⚠️ **Money is stored as `REAL` ringgit here**, not cents. This deviates from the rest of the SHERO
> suite (cents/INTEGER). Don't "fix" it silently — a migration would have to rewrite every cached row.

## Scraping architecture (read this before touching the scrapers)
- **Scheduled out-of-process.** The nightly run is the Windows task *"Shero Dashboard - Daily Scrape"*
  (`scrapers/run-daily.ps1`, installed via `install-startup.ps1`). The old in-process `setTimeout`
  cron in `index.js` is **intentionally disabled** — it didn't survive reboot/sleep and caused the
  May 30–Jun 2 2026 data gap. Don't re-enable it.
- **Self-healing** (`scrapers/run.js`): with no args it backfills from `(last cached day + 1)` through
  MYT-yesterday **and** always re-scrapes the trailing 3 days (marketplace income settles 1–2 days
  late), capped at `MAX_SPAN=14`. Args: `run.js 2026-06-01` (single day) or `run.js 2026-05-30 2026-06-02`
  (inclusive range). `ONLY=lazada,tiktok` env filters channels.
- **Merge, never clobber.** `upsertCache` keeps the existing value whenever a re-scrape returns 0/null,
  so a partially-failed scrape can't overwrite good data with zeros. `upsertRankings` skips entirely on
  an empty result rather than wiping the day's rows.
- **Auto-relogin.** On `NOT_LOGGED_IN`, `scrapers/auto-login.js` retries an unattended login using the
  platform creds in `.env` (known-device profile skips OTP); if OTP/captcha appears, fall back to
  `npm run login`.
- **Heartbeat / staleness.** A successful run writes `settings.last_scrape`. If *every* channel fails,
  the heartbeat is **left untouched on purpose** so the dashboard's per-channel "no data for Nd — login
  may have expired" warning surfaces instead of a falsely-green badge.
- **All dates are MYT (UTC+8).** "Today" on the dashboard is really *yesterday* (data lags a day).
- Always let the browser **close gracefully** (`cdp.closeBrowser()`) — it flushes cookies/session back
  to the profile. Hard-killing Chrome drops the logins.

## Key API Endpoints
- `GET /api/summary?period=today|mtd|ytd|<start>:<end>` — the main aggregate; fans out to every channel
  route in parallel and sums. `today` = yesterday MYT.
- `GET /api/{shopify,pos,shopee,lazada,tiktok}?start=&end=` — per-channel figure (`{revenue, orders, live}`).
- `GET /api/rankings?channel=&date=` — product rankings.
- `GET /api/manual` (CRUD) + `GET /api/manual/aggregate?channels=parkson,watsons&start=&end=` — manual entries.
- `GET /api/settings` / `POST` — key/value; **secret/token/password keys are redacted** on read.
- `GET /api/health` — **CORS-open** (`Access-Control-Allow-Origin: *`) so the SHERO Portal can read
  true status cross-origin.

## Environment Variables
`TURSO_URL`, `TURSO_TOKEN`, `SHOPIFY_STORE`, `SHOPIFY_TOKEN` (Admin API — note `render.yaml` uses the
OAuth `SHOPIFY_CLIENT_ID`/`SHOPIFY_CLIENT_SECRET` pair instead), `POS_API_URL`, `SHOPEE_FINANCE_PIN`,
and optional auto-login creds (`LAZADA_/TIKTOK_/SHOPEE_/SHOPIFY_ EMAIL`+`PASSWORD`). `PORT` (default 3200).

## Conventions
- Commit style: `feat:`, `fix:`, `style:` — short, imperative, no trailing period. Channel-scoped is
  common here (`feat(lazada): …`, `fix(shopee): …`).
- No TypeScript, no bundler. Keep the frontend a single HTML file.
- Migrations = idempotent `ALTER TABLE` in `server/db.js#init()`, wrapped in try/catch. Never destructive.
- Money = **REAL ringgit** in this app (see Data Model note); display `RM x.xx`. Dates ISO `YYYY-MM-DD`, MYT.
- Brand: black primary, white bg, red accent **`#DA0046`** (never pink).

## Guardrails
- **Don't re-enable the in-process cron.** Scraping runs via the Windows Scheduled Task only.
- **Don't overwrite good data with zeros** — preserve the merge semantics in `upsertCache`/`upsertRankings`.
- **Don't hard-kill the scraper Chrome** — graceful close only, or the platform logins are lost.
- **Don't touch the heartbeat when a run produced no data** — it's how stale-data surfaces.
- Never log or expose platform passwords, finance PINs, or tokens; `/api/settings` already redacts them.
- Render auto-deploys **`master`** — verify before pushing.

## Known state / gaps (as of 2026-08 audit)
- **No server-side auth on `master`.** There's a cookie parser but no login/bcrypt/JWT — the API is
  currently open. A `feat/auth` branch exists but is **not merged**. (The Shopify OAuth commits on
  master are for Shopify Admin API access, not user auth.) Treat adding auth as the top open item.
- `render.yaml` still points `repo:` at the old `ai-shero/shero-dashboard`; the live remote is
  `Amber-Aspire-Sdn-Bhd/shero-dashboard`.
- Shopify is collected two ways (Admin API route + scraper) — know which path you're editing.
