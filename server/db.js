require('dotenv').config();
const { createClient } = require('@libsql/client');
const path = require('path');

let db;

if (process.env.TURSO_URL && process.env.TURSO_TOKEN) {
  db = createClient({ url: process.env.TURSO_URL, authToken: process.env.TURSO_TOKEN });
} else {
  db = createClient({ url: `file:${path.join(__dirname, '..', 'shero.db')}` });
}

async function init() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS manual_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel TEXT NOT NULL,
      entry_date TEXT NOT NULL,
      revenue REAL NOT NULL DEFAULT 0,
      orders INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(channel, entry_date)
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS cached_data (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel TEXT NOT NULL,
      entry_date TEXT NOT NULL,
      revenue REAL NOT NULL DEFAULT 0,
      orders INTEGER NOT NULL DEFAULT 0,
      ad_spend REAL DEFAULT 0,
      fetched_at TEXT DEFAULT (datetime('now')),
      UNIQUE(channel, entry_date)
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);
}

module.exports = { db, init };
