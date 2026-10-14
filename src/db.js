'use strict';
const { MongoClient } = require('mongodb');
const { nowLocal } = require('./time');

/*
 * Collections (database name from MONGODB_DB, default "food_ordering"):
 *   stores     { _id: int, store_name, store_phone, store_address, business_hours, store_description,
 *                announcement, is_open, active, sort_order, created_at, updated_at }
 *   categories { _id: int, store_id, name, sort_order, active }
 *   menu_items { _id: int, store_id, category_id, name, description, price, image_url, available, sort_order, ... }
 *   orders     { _id: int, store_id, store_name, order_no, access_token, customer_*, items: [...snapshot], total, status, ... }
 *   counters   { _id: name, seq }            — integer ids and per-day order numbers
 *   sessions   { _id: token, username, expires_at: Date }   (TTL index)
 *   settings   { _id: key, value }           — legacy single-store settings, only read by the migration
 */

const STORE_FIELDS = ['store_name', 'store_phone', 'store_address', 'business_hours', 'store_description',
  'announcement'];

const DEMO_STORES = [
  {
    store_name: '好食光便當',
    store_phone: '02-2345-6789',
    store_address: '台北市信義區松仁路 100 號',
    business_hours: '週一至週六 10:30–20:00',
    store_description: '每日現煮，健康美味的便當與小點。',
    menu: [
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
    ],
  },
  {
    store_name: '小林茶飲',
    store_phone: '02-2765-4321',
    store_address: '台北市信義區松高路 12 號',
    business_hours: '每日 11:00–21:00',
    store_description: '現煮茶湯與手作點心。',
    menu: [
      ['茶飲', [
        ['錫蘭紅茶', '大杯，可調甜度冰塊', 35],
        ['茉莉綠茶', '大杯，可調甜度冰塊', 35],
        ['珍珠奶茶', '手煮黑糖珍珠', 55],
      ]],
      ['點心', [
        ['雞蛋糕', '一份 8 顆', 40],
      ]],
    ],
  },
];

/** Atomically increment and return a named counter. */
async function nextSeq(db, name) {
  const doc = await db.collection('counters').findOneAndUpdate(
    { _id: name }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' });
  return doc.seq;
}

function newStoreDoc(id, fields, sortOrder) {
  const now = nowLocal();
  const doc = { _id: id };
  for (const k of STORE_FIELDS) doc[k] = fields[k] || '';
  return { ...doc, is_open: fields.is_open ?? true, active: true, sort_order: sortOrder,
    created_at: now, updated_at: now };
}

async function seedDemoStores(db) {
  const now = nowLocal();
  for (const [si, demo] of DEMO_STORES.entries()) {
    const storeId = await nextSeq(db, 'stores');
    await db.collection('stores').insertOne(newStoreDoc(storeId, demo, si + 1));
    for (const [ci, [cat, items]] of demo.menu.entries()) {
      const catId = await nextSeq(db, 'categories');
      await db.collection('categories').insertOne({ _id: catId, store_id: storeId, name: cat,
        sort_order: ci + 1, active: 1 });
      for (const [ii, [name, description, price]] of items.entries()) {
        await db.collection('menu_items').insertOne({
          _id: await nextSeq(db, 'menu_items'), store_id: storeId, category_id: catId, name, description,
          price, image_url: '', available: 1, sort_order: ii + 1, created_at: now, updated_at: now,
        });
      }
    }
  }
}

/**
 * v1 -> v2: the single store described in `settings` becomes store #1 and owns every
 * existing category, menu item and order. Idempotent.
 */
async function migrateSingleStore(db) {
  const orphan = { store_id: { $exists: false } };
  const [cats, items, orders] = await Promise.all([
    db.collection('categories').countDocuments(orphan),
    db.collection('menu_items').countDocuments(orphan),
    db.collection('orders').countDocuments(orphan),
  ]);
  if (!cats && !items && !orders) return false;

  let store = await db.collection('stores').findOne({}, { sort: { _id: 1 } });
  if (!store) {
    const legacy = {};
    for (const row of await db.collection('settings').find().toArray()) legacy[row._id] = row.value;
    const fields = { store_name: legacy.store_name || '我的商家', is_open: legacy.is_open !== '0' };
    for (const k of STORE_FIELDS.slice(1)) fields[k] = legacy[k];
    store = newStoreDoc(await nextSeq(db, 'stores'), fields, 1);
    await db.collection('stores').insertOne(store);
  }
  await Promise.all([
    db.collection('categories').updateMany(orphan, { $set: { store_id: store._id } }),
    db.collection('menu_items').updateMany(orphan, { $set: { store_id: store._id } }),
    db.collection('orders').updateMany(orphan, { $set: { store_id: store._id, store_name: store.store_name } }),
  ]);
  console.log(`[db] 已將既有資料移轉至商家 #${store._id}「${store.store_name}」`);
  return true;
}

/**
 * Connect to MongoDB, create indexes, migrate and seed.
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
    db.collection('orders').createIndex({ order_date: 1, store_id: 1 }),
    db.collection('orders').createIndex({ customer_phone: 1 }),
    db.collection('orders').createIndex({ status: 1 }),
    db.collection('categories').createIndex({ store_id: 1 }),
    db.collection('menu_items').createIndex({ store_id: 1, category_id: 1 }),
  ]);

  const migrated = await migrateSingleStore(db);
  // Seed only a brand-new database (a stores counter exists once any store was ever created).
  if (!migrated && process.env.SEED_DEMO !== '0'
    && !(await db.collection('counters').findOne({ _id: 'stores' }))) {
    await seedDemoStores(db);
  }

  return { client, db };
}

module.exports = { openDatabase, nextSeq, newStoreDoc, STORE_FIELDS };
