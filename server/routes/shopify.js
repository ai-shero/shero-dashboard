const express = require('express');
const router  = express.Router();

// ── GET /api/shopify?start=YYYY-MM-DD&end=YYYY-MM-DD ─────────────────────────
// Reads from cached_data table, populated nightly by scrapers/shopify.js
router.get('/', async (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) return res.status(400).json({ error: 'start and end required' });

  const { db } = require('../db');
  try {
    const result = await db.execute({
      sql: `SELECT
              SUM(revenue)                  AS revenue,
              SUM(orders)                   AS orders,
              SUM(gross_sales)              AS gross_sales,
              SUM(discounts)                AS discounts,
              SUM(returns)                  AS returns,
              SUM(net_sales)                AS net_sales,
              SUM(shipping_charges)         AS shipping_charges,
              SUM(return_fees)              AS return_fees,
              SUM(taxes)                    AS taxes,
              SUM(orders_fulfilled)         AS orders_fulfilled,
              AVG(avg_order_value)          AS avg_order_value,
              SUM(sessions)                 AS sessions,
              AVG(conversion_rate)          AS conversion_rate,
              AVG(returning_customer_rate)  AS returning_customer_rate
            FROM cached_data
            WHERE channel = 'shopify' AND entry_date >= ? AND entry_date <= ?`,
      args: [start, end]
    });
    const row = result.rows[0];
    if (row && row.revenue != null) {
      const n = (v, d = 2) => v != null ? +Number(v).toFixed(d) : null;
      return res.json({
        channel: 'shopify', live: true,
        revenue:               n(row.revenue),
        orders:                row.orders != null ? Number(row.orders) : null,
        grossSales:            n(row.gross_sales),
        discounts:             n(row.discounts),
        returns:               n(row.returns),
        netSales:              n(row.net_sales),
        shippingCharges:       n(row.shipping_charges),
        returnFees:            n(row.return_fees),
        taxes:                 n(row.taxes),
        ordersFulfilled:       row.orders_fulfilled != null ? Number(row.orders_fulfilled) : null,
        averageOrderValue:     n(row.avg_order_value),
        sessions:              row.sessions != null ? Number(row.sessions) : null,
        conversionRate:        n(row.conversion_rate, 2),
        returningCustomerRate: n(row.returning_customer_rate, 2),
      });
    }
  } catch (err) {
    console.error('[Shopify] DB error:', err.message);
  }

  const mock = generateMock(start, end, 4200, 38);
  res.json({ channel: 'shopify', ...mock, live: false, note: 'mock — run: npm run login:shopify' });
});

function generateMock(start, end, baseRevenue, baseOrders) {
  const days = Math.max(1, (new Date(end) - new Date(start)) / 86400000 + 1);
  const v    = () => 0.7 + Math.random() * 0.6;
  return { revenue: +(baseRevenue * days * v() / 30).toFixed(2), orders: Math.round(baseOrders * days * v() / 30) };
}

module.exports = router;
