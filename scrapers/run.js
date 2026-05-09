/**
 * Daily scrape runner — called by the server cron job at midnight MYT.
 * Runs all scrapers, stores results in cached_data table.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { db, init } = require('../server/db');

const SCRAPERS = [
  { id: 'shopify', scraper: require('./shopify') },
  // { id: 'shopee',  scraper: require('./shopee') },   // add when session saved
  // { id: 'lazada',  scraper: require('./lazada') },
  // { id: 'tiktok',  scraper: require('./tiktok') },
];

async function upsertCache(channel, date, result) {
  await db.execute({
    sql: `INSERT INTO cached_data (
            channel, entry_date, revenue, orders,
            gross_sales, discounts, returns, net_sales,
            shipping_charges, return_fees, taxes,
            orders_fulfilled, avg_order_value,
            sessions, conversion_rate, returning_customer_rate,
            fetched_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
          ON CONFLICT(channel, entry_date) DO UPDATE SET
            revenue=excluded.revenue, orders=excluded.orders,
            gross_sales=excluded.gross_sales, discounts=excluded.discounts,
            returns=excluded.returns, net_sales=excluded.net_sales,
            shipping_charges=excluded.shipping_charges, return_fees=excluded.return_fees,
            taxes=excluded.taxes, orders_fulfilled=excluded.orders_fulfilled,
            avg_order_value=excluded.avg_order_value, sessions=excluded.sessions,
            conversion_rate=excluded.conversion_rate,
            returning_customer_rate=excluded.returning_customer_rate,
            fetched_at=excluded.fetched_at`,
    args: [
      channel, date,
      result.totalSales ?? result.revenue ?? 0,
      result.ordersPlaced ?? result.orders ?? 0,
      result.grossSales ?? null, result.discounts ?? null,
      result.returns ?? null, result.netSales ?? null,
      result.shippingCharges ?? null, result.returnFees ?? null,
      result.taxes ?? null, result.ordersFulfilled ?? null,
      result.averageOrderValue ?? null, result.sessions ?? null,
      result.conversionRate ?? null, result.returningCustomerRate ?? null,
    ]
  });
}

async function runAll(date) {
  await init();
  const myt       = new Date(Date.now() + 8 * 3600000);
  const yesterday = new Date(+myt - 86400000).toISOString().slice(0, 10);
  const today     = date || yesterday;
  console.log(`[Scrape] Running for ${today}`);

  for (const { id, scraper } of SCRAPERS) {
    try {
      console.log(`[Scrape] ${id}...`);
      const result = await scraper.scrape(today);

      const revenue = result.totalSales ?? result.revenue;
      const orders  = result.ordersPlaced ?? result.orders;
      if (revenue != null && orders != null) {
        await upsertCache(id, today, result);
        console.log(`[Scrape] ${id} ✓ — RM ${revenue} / ${orders} orders`);
      } else {
        console.warn(`[Scrape] ${id} — could not parse data. Raw:`, result.rawText?.slice(0, 300));
      }
    } catch (err) {
      if (err.message === 'SESSION_EXPIRED') {
        console.error(`[Scrape] ${id} — session expired! Run: npm run login:${id}`);
      } else {
        console.error(`[Scrape] ${id} error:`, err.message);
      }
    }
  }

  console.log('[Scrape] Done.');
}

module.exports = { runAll };

if (require.main === module) runAll(process.argv[2]).catch(console.error);
