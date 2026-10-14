'use strict';
const { MongoClient } = require('mongodb');
const { nowLocal } = require('./time');

/*
 * Collections (database name from MONGODB_DB, default "food_ordering"):
 *   settings   { _id: key, value }
 *   counters   { _id: name, seq }            — integer ids and per-day order numbers
 *   sessions   { _id: token, username, expires_at: Date }   (TTL index)
 *   categories { _id: int, name, sort_order, active }
 *   menu_items { _id: int, category_id, name, description, price, image_url, available, sort_order, ... }
 *   orders     { _id: int, order_no, access_token, customer_*, items: [...snapshot], total, status, ... }
 */

const DEFAULT_SETTINGS = {
  store_name: '好食光便當',
  store_phone: '02-2345-6789',
  store_address: '台北市信義區松仁路 100 號',
  business_hours: '週一至週六 10:30–20:00',
  store_description: '每日現煮，健康美味的便當與小點。',
  announcement: '',
  is_open: '1',
};

/** Atomically increment and return a named counter. */
async function nextSeq(db, name) {
  const doc = await db.collection('counters').findOneAndUpdate(
    { _id: name }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' });
  return doc.seq;
}

async function seedDemoMenu(db) {
  const now = nowLocal();
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
  for (const [ci, [cat, items]] of menu.entries()) {
    const catId = await nextSeq(db, 'categories');
    await db.collection('categories').insertOne({ _id: catId, name: cat, sort_order: ci + 1, active: 1 });
    for (const [ii, [name, description, price]] of items.entries()) {
      await db.collection('menu_items').insertOne({
        _id: await nextSeq(db, 'menu_items'), category_id: catId, name, description, price,
        image_url: '', available: 1, sort_order: ii + 1, created_at: now, updated_at: now,
      });
    }
  }
}

/**
 * Connect to MongoDB, create indexes and seed defaults.
 * Returns { client, db }.
 */
async function openDatabase({ uri, dbName } = {}) {
  uri = uri || process.env.MONGODB_URI;
  if (!uri) throw new Error('缺少 MONGODB_URI 環境變數');
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
  await client.connect();
  const db = client.db(dbName || process.env.MONGODB_DB || 'food_ordering');

  await Promise.all([
    db.collection('sessions').createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 }),
    db.collection('orders').createIndex({ order_no: 1 }, { unique: true }),
    db.collection('orders').createIndex({ order_date: 1 }),
    db.collection('orders').createIndex({ customer_phone: 1 }),
    db.collection('orders').createIndex({ status: 1 }),
    db.collection('menu_items').createIndex({ category_id: 1 }),
  ]);

  await db.collection('settings').bulkWrite(Object.entries(DEFAULT_SETTINGS).map(([k, v]) => ({
    updateOne: { filter: { _id: k }, update: { $setOnInsert: { value: v } }, upsert: true },
  })));

  const [itemCount, catCount] = await Promise.all([
    db.collection('menu_items').estimatedDocumentCount(),
    db.collection('categories').estimatedDocumentCount(),
  ]);
  if (itemCount === 0 && catCount === 0 && process.env.SEED_DEMO !== '0') await seedDemoMenu(db);

  return { client, db };
}

module.exports = { openDatabase, nextSeq };
