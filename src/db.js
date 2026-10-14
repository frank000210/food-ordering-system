'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { hashPassword } = require('./auth');
const { nowLocal } = require('./time');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS admins (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  admin_id   INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS menu_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price       INTEGER NOT NULL CHECK (price >= 0),
  image_url   TEXT NOT NULL DEFAULT '',
  available   INTEGER NOT NULL DEFAULT 1,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no       TEXT NOT NULL UNIQUE,
  customer_name  TEXT NOT NULL,
  customer_phone TEXT NOT NULL DEFAULT '',
  order_type     TEXT NOT NULL DEFAULT 'takeout',
  pickup_time    TEXT NOT NULL DEFAULT '',
  note           TEXT NOT NULL DEFAULT '',
  total          INTEGER NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending',
  order_date     TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_date ON orders(order_date);
CREATE INDEX IF NOT EXISTS idx_orders_phone ON orders(customer_phone);

CREATE TABLE IF NOT EXISTS order_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id     INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  menu_item_id INTEGER REFERENCES menu_items(id) ON DELETE SET NULL,
  item_name    TEXT NOT NULL,
  unit_price   INTEGER NOT NULL,
  quantity     INTEGER NOT NULL CHECK (quantity > 0),
  subtotal     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
`;

const DEFAULT_SETTINGS = {
  store_name: '好食光便當',
  store_phone: '02-2345-6789',
  store_address: '台北市信義區松仁路 100 號',
  business_hours: '週一至週六 10:30–20:00',
  store_description: '每日現煮，健康美味的便當與小點。',
  announcement: '',
  is_open: '1',
};

function seedDemoMenu(db) {
  const now = nowLocal();
  const insertCat = db.prepare('INSERT INTO categories (name, sort_order) VALUES (?, ?)');
  const insertItem = db.prepare(`INSERT INTO menu_items
    (category_id, name, description, price, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const menu = [
    ['便當', [
      ['招牌排骨便當', '酥炸大排骨、三樣時蔬、滷蛋', 110],
      ['香煎雞腿便當', '去骨雞腿排、三樣時蔬、滷蛋', 120],
      ['滷肉飯便當', '古早味滷肉、滷蛋、兩樣時蔬', 85],
    ]],
    ['麵食', [
      ['紅燒牛肉麵', '慢燉牛腱與牛筋，湯頭濃郁', 160],
      ['麻醬涼麵', '芝麻醬、小黃瓜絲、紅蘿蔔絲', 70],
    ]],
    ['飲料與湯品', [
      ['古早味紅茶', '大杯，微糖', 30],
      ['味噌湯', '豆腐、海帶芽', 25],
    ]],
  ];
  menu.forEach(([cat, items], ci) => {
    const { lastInsertRowid: catId } = insertCat.run(cat, ci + 1);
    items.forEach(([name, desc, price], ii) => {
      insertItem.run(catId, name, desc, price, ii + 1, now, now);
    });
  });
}

function openDatabase(file) {
  const dbFile = file || process.env.DB_FILE || path.join(__dirname, '..', 'data', 'ordering.db');
  if (dbFile !== ':memory:') fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);
  db.exec('PRAGMA foreign_keys = ON;');
  if (dbFile !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);

  const setSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) setSetting.run(k, v);

  const adminCount = db.prepare('SELECT COUNT(*) AS n FROM admins').get().n;
  if (adminCount === 0) {
    const username = process.env.ADMIN_USERNAME || 'admin';
    const password = process.env.ADMIN_PASSWORD || 'admin123';
    db.prepare('INSERT INTO admins (username, password_hash, created_at) VALUES (?, ?, ?)')
      .run(username, hashPassword(password), nowLocal());
  }

  const itemCount = db.prepare('SELECT COUNT(*) AS n FROM menu_items').get().n;
  const catCount = db.prepare('SELECT COUNT(*) AS n FROM categories').get().n;
  if (itemCount === 0 && catCount === 0 && process.env.SEED_DEMO !== '0') seedDemoMenu(db);

  return db;
}

/** Run fn inside a transaction; rolls back on error. */
function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { openDatabase, transaction };
