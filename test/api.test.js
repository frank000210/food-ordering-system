'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { openDatabase } = require('../src/db');
const { createApp } = require('../src/app');

const CREDENTIALS = { username: 'boss', password: 'test-secret-123' };

// Seeded demo data: store 1 好食光便當 (items 1–7), store 2 小林茶飲 (items 8–11).
const BENTO = 1;        // 招牌排骨便當 110, store 1
const CHICKEN = 2;      // 香煎雞腿便當 120, store 1
const TEA = 6;          // 古早味紅茶 30, store 1
const MILK_TEA = 10;    // 珍珠奶茶 55, store 2

let mongo;
let conn;
let server;
let base;
let cookie = '';

async function call(path, { method = 'GET', body, auth = false, raw = false } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth) headers.Cookie = cookie;
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (raw) return res;
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  return { status: res.status, data, headers: res.headers };
}

async function listen(app) {
  const s = http.createServer(app.handle);
  await new Promise((r) => s.listen(0, r));
  return { server: s, base: `http://127.0.0.1:${s.address().port}` };
}

before(async () => {
  // Tests never touch a real database: always an in-memory MongoDB.
  mongo = await MongoMemoryServer.create();
  conn = await openDatabase({ uri: mongo.getUri(), dbName: 'food_ordering_test' });
  ({ server, base } = await listen(createApp(conn.db, { credentials: CREDENTIALS })));
});
after(async () => {
  server.close();
  await conn.client.close();
  await mongo.stop();
});

test('storefront lists stores, each with its own menu', async () => {
  const { status, data } = await call('/api/stores');
  assert.equal(status, 200);
  assert.deepEqual(data.stores.map((s) => s.store_name), ['好食光便當', '小林茶飲']);
  assert.equal(data.admin_url, '/admin/');

  const m1 = await call('/api/stores/1/menu');
  assert.equal(m1.data.store.store_name, '好食光便當');
  assert.equal(m1.data.categories.length, 3);
  const m2 = await call('/api/stores/2/menu');
  const ids2 = m2.data.categories.flatMap((c) => c.items.map((i) => i.id));
  assert.ok(ids2.includes(MILK_TEA));
  assert.ok(!ids2.includes(BENTO));

  assert.equal((await call('/api/stores/999/menu')).status, 404);
});

test('order totals are computed from server-side prices', async () => {
  const { status, data } = await call('/api/orders', {
    method: 'POST',
    body: {
      store_id: 1,
      customer_name: '王小明',
      items: [
        { menu_item_id: BENTO, quantity: 2, price: 1 }, // client price is ignored
        { menu_item_id: TEA, quantity: 1 },
        { menu_item_id: BENTO, quantity: 1 },           // duplicate lines merge
      ],
    },
  });
  assert.equal(status, 201);
  assert.match(data.order_no, /^\d{8}-0001$/);
  assert.equal(data.store_id, 1);
  assert.equal(data.store_name, '好食光便當');
  assert.equal(data.items.length, 2);
  const bento = data.items.find((i) => i.menu_item_id === BENTO);
  assert.equal(bento.unit_price, 110);
  assert.equal(bento.quantity, 3);
  assert.equal(bento.subtotal, 330);
  assert.equal(data.total, 330 + 30);
  assert.equal(data.status, 'pending');
  assert.match(data.access_token, /^[0-9a-f]{32}$/);
  // The simplified form no longer stores phone / dining type / pickup time.
  assert.equal(data.customer_phone, undefined);
  assert.equal(data.order_type, undefined);

  // The confirmation page link (order no + token) works; a wrong token does not.
  const view = await call(`/api/orders/view?no=${data.order_no}&t=${data.access_token}`);
  assert.equal(view.status, 200);
  assert.equal(view.data.total, 360);
  const badView = await call(`/api/orders/view?no=${data.order_no}&t=${'0'.repeat(32)}`);
  assert.equal(badView.status, 404);
});

test('an order may only contain items from one store', async () => {
  const mixed = await call('/api/orders', { method: 'POST',
    body: { store_id: 1, customer_name: 'A', items: [{ menu_item_id: BENTO, quantity: 1 }, { menu_item_id: MILK_TEA, quantity: 1 }] } });
  assert.equal(mixed.status, 400);
  assert.match(mixed.data.error, /同一家商家/);

  const wrongStore = await call('/api/orders', { method: 'POST',
    body: { store_id: 1, customer_name: 'A', items: [{ menu_item_id: MILK_TEA, quantity: 1 }] } });
  assert.equal(wrongStore.status, 400);

  const noStore = await call('/api/orders', { method: 'POST',
    body: { customer_name: 'A', items: [{ menu_item_id: BENTO, quantity: 1 }] } });
  assert.equal(noStore.status, 400);
  assert.match(noStore.data.error, /商家/);

  const ok = await call('/api/orders', { method: 'POST',
    body: { store_id: 2, customer_name: '林小姐', items: [{ menu_item_id: MILK_TEA, quantity: 2 }] } });
  assert.equal(ok.status, 201);
  assert.equal(ok.data.store_name, '小林茶飲');
  assert.equal(ok.data.total, 110);
});

test('order validation rejects bad input', async () => {
  const cases = [
    [{ items: [{ menu_item_id: BENTO, quantity: 1 }] }, /顧客名稱/],
    [{ customer_name: 'A', items: [] }, /至少/],
    [{ customer_name: 'A', items: [{ menu_item_id: BENTO, quantity: 0 }] }, /正整數/],
    [{ customer_name: 'A', items: [{ menu_item_id: BENTO, quantity: 1.5 }] }, /正整數/],
    [{ customer_name: 'A', items: [{ menu_item_id: 9999, quantity: 1 }] }, /無法供應/],
    [{ customer_name: 'A', items: [{ menu_item_id: BENTO, quantity: 100 }] }, /上限/],
  ];
  for (const [body, msg] of cases) {
    const { status, data } = await call('/api/orders', { method: 'POST', body: { store_id: 1, ...body } });
    assert.equal(status, 400, JSON.stringify(body));
    assert.match(data.error, msg);
  }
});

test('non-JSON writes are rejected (CSRF guard)', async () => {
  const res = await fetch(base + '/api/orders', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'customer_name=x',
  });
  assert.equal(res.status, 415);
});

async function firstOrderNo() {
  const { data } = await call('/api/admin/orders?q=' + encodeURIComponent('王小明'), { auth: true });
  return data[0].order_no;
}

test('admin endpoints require login', async () => {
  const { status } = await call('/api/admin/orders');
  assert.equal(status, 401);
  const bad = await call('/api/admin/login', { method: 'POST', body: { username: 'boss', password: 'nope' } });
  assert.equal(bad.status, 401);
  // The old built-in default no longer works: credentials come only from ADMIN / ADMIN_PASSWORD.
  const legacy = await call('/api/admin/login', { method: 'POST', body: { username: 'admin', password: 'admin123' } });
  assert.equal(legacy.status, 401);
});

test('ADMIN_AUTH_DISABLED opens the back office without login (testing mode)', async () => {
  const s = await listen(createApp(conn.db, { credentials: CREDENTIALS, authDisabled: true }));
  const res = await fetch(s.base + '/api/admin/me');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).auth_disabled, true);
  assert.equal((await fetch(s.base + '/api/admin/orders')).status, 200);
  s.server.close();
});

test('back office stays locked when ADMIN_PASSWORD is not set', async () => {
  const s = await listen(createApp(conn.db, { credentials: { username: 'admin', password: '' } }));
  const res = await fetch(s.base + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '' }) });
  assert.equal(res.status, 503);
  s.server.close();
});

test('admin login and store management', async () => {
  const res = await call('/api/admin/login', { method: 'POST', body: CREDENTIALS, raw: true });
  assert.equal(res.status, 200);
  cookie = res.headers.get('set-cookie').split(';')[0];
  assert.match(res.headers.get('set-cookie'), /HttpOnly/);

  const list = await call('/api/admin/stores', { auth: true });
  assert.equal(list.data.length, 2);
  assert.equal(list.data[0].item_count, 7);

  const created = await call('/api/admin/stores', { method: 'POST', auth: true,
    body: { store_name: '測試甜點店', store_phone: '02-1111-2222' } });
  assert.equal(created.status, 201);
  assert.equal(created.data.is_open, true);
  assert.equal(created.data.active, true);
  const blank = await call('/api/admin/stores', { method: 'POST', auth: true, body: { store_name: '  ' } });
  assert.equal(blank.status, 400);

  const upd = await call(`/api/admin/stores/${created.data.id}`, { method: 'PUT', auth: true, body: { announcement: '新開幕' } });
  assert.equal(upd.data.announcement, '新開幕');
  assert.equal(upd.data.store_name, '測試甜點店'); // partial update keeps other fields

  // Deactivated stores disappear from the storefront.
  await call(`/api/admin/stores/${created.data.id}`, { method: 'PUT', auth: true, body: { active: false } });
  assert.ok(!(await call('/api/stores')).data.stores.some((s) => s.id === created.data.id));
  assert.equal((await call(`/api/stores/${created.data.id}/menu`)).status, 404);

  // A store without orders can be deleted (with its menu); one with orders cannot.
  const del = await call(`/api/admin/stores/${created.data.id}`, { method: 'DELETE', auth: true, body: {} });
  assert.equal(del.status, 200);
  const delWithOrders = await call('/api/admin/stores/1', { method: 'DELETE', auth: true, body: {} });
  assert.equal(delWithOrders.status, 409);
});

test('menu items and categories are scoped to their store', async () => {
  const cat = await call('/api/admin/categories', { method: 'POST', auth: true, body: { store_id: 2, name: '甜點', sort_order: 9 } });
  assert.equal(cat.status, 201);
  assert.equal(cat.data.store_id, 2);
  const item = await call('/api/admin/items', { method: 'POST', auth: true,
    body: { store_id: 2, name: '紅豆湯', price: 45, category_id: cat.data.id, description: '熱的' } });
  assert.equal(item.status, 201);
  assert.equal(item.data.store_id, 2);

  // A category from another store cannot be used.
  const crossCat = await call('/api/admin/items', { method: 'POST', auth: true,
    body: { store_id: 1, name: 'x', price: 10, category_id: cat.data.id } });
  assert.equal(crossCat.status, 400);
  const noStore = await call('/api/admin/items', { method: 'POST', auth: true, body: { name: 'x', price: 10 } });
  assert.equal(noStore.status, 400);
  const badPrice = await call('/api/admin/items', { method: 'POST', auth: true, body: { store_id: 2, name: 'x', price: -1 } });
  assert.equal(badPrice.status, 400);

  const items1 = await call('/api/admin/items?store_id=1', { auth: true });
  assert.ok(!items1.data.some((i) => i.id === item.data.id));
  const items2 = await call('/api/admin/items?store_id=2', { auth: true });
  assert.ok(items2.data.some((i) => i.id === item.data.id));
  assert.equal((await call('/api/admin/items', { auth: true })).status, 400);

  const upd = await call(`/api/admin/items/${item.data.id}`, { method: 'PUT', auth: true,
    body: { name: '紅豆湯（熱）', price: 50, category_id: cat.data.id } });
  assert.equal(upd.data.price, 50);
  assert.equal(upd.data.store_id, 2);

  // Unavailable items disappear from the public menu and cannot be ordered.
  await call(`/api/admin/items/${item.data.id}/availability`, { method: 'PATCH', auth: true, body: { available: false } });
  const menu = await call('/api/stores/2/menu');
  assert.ok(!menu.data.categories.some((c) => c.items.some((i) => i.id === item.data.id)));
  const order = await call('/api/orders', { method: 'POST',
    body: { store_id: 2, customer_name: 'B', items: [{ menu_item_id: item.data.id, quantity: 1 }] } });
  assert.equal(order.status, 400);

  const del = await call(`/api/admin/items/${item.data.id}`, { method: 'DELETE', auth: true, body: {} });
  assert.equal(del.status, 200);
});

test('closing one store does not affect the others', async () => {
  await call('/api/admin/stores/2', { method: 'PUT', auth: true, body: { is_open: false } });
  const closed = await call('/api/orders', { method: 'POST',
    body: { store_id: 2, customer_name: 'C', items: [{ menu_item_id: MILK_TEA, quantity: 1 }] } });
  assert.equal(closed.status, 409);
  const open = await call('/api/orders', { method: 'POST',
    body: { store_id: 1, customer_name: 'C', items: [{ menu_item_id: CHICKEN, quantity: 1 }] } });
  assert.equal(open.status, 201);
  await call('/api/admin/stores/2', { method: 'PUT', auth: true, body: { is_open: true } });
  // Clean up so the report numbers below stay simple.
  await call(`/api/admin/orders/${open.data.id}/status`, { method: 'PATCH', auth: true, body: { status: 'cancelled' } });
  const rm = await call(`/api/admin/orders/${open.data.id}`, { method: 'DELETE', auth: true, body: {} });
  assert.equal(rm.status, 200);
});

test('customer lookup needs order number and the orderer name', async () => {
  const no = await firstOrderNo();
  const ok = await call('/api/orders/lookup?order_no=' + encodeURIComponent(no) + '&contact=王小明');
  assert.equal(ok.data.orders.length, 1);
  assert.equal(ok.data.orders[0].store_name, '好食光便當');
  assert.equal(ok.data.orders[0].access_token, undefined);
  const wrong = await call('/api/orders/lookup?order_no=' + encodeURIComponent(no) + '&contact=別人');
  assert.equal(wrong.data.orders.length, 0);
  const noContact = await call('/api/orders/lookup?order_no=' + encodeURIComponent(no));
  assert.equal(noContact.status, 400);
  const none = await call('/api/orders/lookup');
  assert.equal(none.status, 400);
});

test('order status workflow, per-store and all-store reports', async () => {
  // Store 1: 2 × 香煎雞腿便當 (120) = 240
  const o2 = await call('/api/orders', { method: 'POST', body: { store_id: 1, customer_name: '李小華', items: [{ menu_item_id: CHICKEN, quantity: 2 }] } });
  // Store 1, later cancelled: excluded from the report.
  const o3 = await call('/api/orders', { method: 'POST', body: { store_id: 1, customer_name: '陳大文', items: [{ menu_item_id: BENTO, quantity: 5 }] } });

  const s = await call(`/api/admin/orders/${o2.data.id}/status`, { method: 'PATCH', auth: true, body: { status: 'completed' } });
  assert.equal(s.data.status, 'completed');
  await call(`/api/admin/orders/${o3.data.id}/status`, { method: 'PATCH', auth: true, body: { status: 'cancelled' } });
  const bad = await call(`/api/admin/orders/${o3.data.id}/status`, { method: 'PATCH', auth: true, body: { status: 'eaten' } });
  assert.equal(bad.status, 400);

  const list = await call('/api/admin/orders?q=李小華', { auth: true });
  assert.equal(list.data.length, 1);
  const store2Orders = await call('/api/admin/orders?store_id=2', { auth: true });
  assert.ok(store2Orders.data.every((o) => o.store_id === 2));

  const { data: r1 } = await call('/api/admin/reports/daily?store_id=1', { auth: true });
  assert.equal(r1.order_count, 2);
  assert.equal(r1.total_revenue, 360 + 240);
  assert.equal(r1.cancelled_count, 1); // o3 (the previous test's order was deleted)
  const bento = r1.items.find((i) => i.name === '招牌排骨便當');
  assert.equal(bento.quantity, 3);
  assert.equal(bento.revenue, 330);
  assert.equal(r1.items.reduce((sum, i) => sum + i.revenue, 0), r1.total_revenue);

  const { data: all } = await call('/api/admin/reports/daily', { auth: true });
  assert.equal(all.order_count, 3);
  assert.equal(all.total_revenue, 600 + 110);
  assert.deepEqual(all.by_store.map((x) => [x.store_name, x.revenue]), [['好食光便當', 600], ['小林茶飲', 110]]);

  const dash = await call('/api/admin/dashboard?store_id=1', { auth: true });
  assert.equal(dash.data.order_count, 2);
  assert.equal(dash.data.active.pending, 1);
  assert.equal(dash.data.store_open, true);
  const dashAll = await call('/api/admin/dashboard', { auth: true });
  assert.equal(dashAll.data.order_count, 3);
  assert.equal(dashAll.data.store_open, null);

  const csv = await call('/api/admin/reports/daily.csv?store_id=1', { auth: true });
  assert.match(csv.data, /招牌排骨便當/);
  assert.match(csv.data, /總營收","600"/);
  assert.match(csv.headers.get('content-disposition'), /store1/);

  const badDate = await call('/api/admin/reports/daily?date=2026-13-40', { auth: true });
  assert.equal(badDate.status, 400);
});

test('only completed or cancelled orders can be deleted', async () => {
  const pending = await call('/api/orders', { method: 'POST', body: { store_id: 1, customer_name: '刪除測試', items: [{ menu_item_id: TEA, quantity: 1 }] } });
  const done = await call('/api/orders', { method: 'POST', body: { store_id: 1, customer_name: '刪除測試', items: [{ menu_item_id: TEA, quantity: 2 }] } });
  await call(`/api/admin/orders/${done.data.id}/status`, { method: 'PATCH', auth: true, body: { status: 'completed' } });

  const single = await call(`/api/admin/orders/${pending.data.id}`, { method: 'DELETE', auth: true, body: {} });
  assert.equal(single.status, 409);

  const bulk = await call('/api/admin/orders/delete', { method: 'POST', auth: true, body: { ids: [pending.data.id, done.data.id] } });
  assert.deepEqual(bulk.data, { deleted: 1, skipped: 1 });
  assert.equal((await call(`/api/admin/orders/${done.data.id}`, { auth: true })).status, 404);
  assert.equal((await call(`/api/admin/orders/${pending.data.id}`, { auth: true })).status, 200);
  await call(`/api/admin/orders/${pending.data.id}/status`, { method: 'PATCH', auth: true, body: { status: 'cancelled' } });
  await call(`/api/admin/orders/${pending.data.id}`, { method: 'DELETE', auth: true, body: {} });
});

test('static pages are served', async () => {
  for (const p of ['/', '/store', '/track', '/order', '/admin/', '/admin/login', '/admin/report', '/admin/stores', '/admin/menu']) {
    const res = await fetch(base + p);
    assert.equal(res.status, 200, p);
    assert.match(res.headers.get('content-type'), /text\/html/);
  }
  const traversal = await fetch(base + '/..%2fpackage.json');
  assert.equal(traversal.status, 404);
  const badEncoding = await fetch(base + '/%E0%A4%A');
  assert.equal(badEncoding.status, 400);
});

test('storefront and back office are split by host when ADMIN_URL is set', async () => {
  const s = await listen(createApp(conn.db, { credentials: CREDENTIALS,
    storefrontUrl: 'https://shop.example.test', adminUrl: 'https://admin.example.test' }));
  const get = (p, host) => new Promise((resolve, reject) => {
    const u = new URL(s.base);
    http.get({ hostname: u.hostname, port: u.port, path: p, headers: { Host: host } }, (res) => {
      res.resume(); resolve(res);
    }).on('error', reject);
  });
  // Customer host: storefront works, back office is hidden.
  assert.equal((await get('/', 'shop.example.test')).statusCode, 200);
  assert.equal((await get('/store?id=1', 'shop.example.test')).statusCode, 200);
  const stores = await (await fetch(s.base + '/api/stores')).json();
  assert.equal(stores.admin_url, 'https://admin.example.test/admin/');
  assert.equal((await get('/admin/', 'shop.example.test')).statusCode, 404);
  assert.equal((await get('/api/admin/me', 'shop.example.test')).statusCode, 404);
  // Admin host: back office works, customer pages redirect.
  assert.equal((await get('/admin/', 'admin.example.test')).statusCode, 200);
  assert.equal((await get('/api/admin/me', 'admin.example.test')).statusCode, 401);
  const root = await get('/', 'admin.example.test');
  assert.equal(root.statusCode, 302);
  assert.equal(root.headers.location, '/admin/');
  const store = await get('/store?id=1', 'admin.example.test');
  assert.equal(store.headers.location, 'https://shop.example.test/store?id=1');
  assert.equal((await get('/assets/common.js', 'admin.example.test')).statusCode, 200);
  s.server.close();
});

test('CSV export neutralises spreadsheet formulas', async () => {
  const item = await call('/api/admin/items', { method: 'POST', auth: true,
    body: { store_id: 2, name: '=HYPERLINK("x")', price: 10 } });
  await call('/api/orders', { method: 'POST', body: { store_id: 2, customer_name: 'D', items: [{ menu_item_id: item.data.id, quantity: 1 }] } });
  const csv = await call('/api/admin/reports/daily.csv?store_id=2', { auth: true });
  assert.match(csv.data, /"'=HYPERLINK\(""x""\)"/);
});

test('legacy single-store data is migrated into store #1', async () => {
  // Simulate a v1 database: settings + categories/items/orders without store_id.
  const legacy = conn.client.db('food_ordering_legacy');
  await legacy.collection('settings').insertMany([
    { _id: 'store_name', value: '老店' }, { _id: 'store_phone', value: '02-0000-0000' }, { _id: 'is_open', value: '0' },
  ]);
  await legacy.collection('categories').insertOne({ _id: 1, name: '主食', sort_order: 1, active: 1 });
  await legacy.collection('menu_items').insertOne({ _id: 1, category_id: 1, name: '炒飯', description: '', price: 90,
    image_url: '', available: 1, sort_order: 1, created_at: '', updated_at: '' });
  await legacy.collection('orders').insertOne({ _id: 1, order_no: '20261001-0001', customer_name: '舊客', customer_phone: '0911',
    order_type: 'takeout', total: 90, status: 'completed', order_date: '2026-10-01', created_at: '2026-10-01 12:00:00',
    items: [{ id: 1, menu_item_id: 1, item_name: '炒飯', unit_price: 90, quantity: 1, subtotal: 90 }] });

  const migrated = await openDatabase({ uri: mongo.getUri(), dbName: 'food_ordering_legacy' });
  const db = migrated.db;
  const stores = await db.collection('stores').find().toArray();
  assert.equal(stores.length, 1);
  assert.equal(stores[0].store_name, '老店');
  assert.equal(stores[0].store_phone, '02-0000-0000');
  assert.equal(stores[0].is_open, false);
  assert.equal((await db.collection('menu_items').findOne({ _id: 1 })).store_id, stores[0]._id);
  const order = await db.collection('orders').findOne({ _id: 1 });
  assert.equal(order.store_id, stores[0]._id);
  assert.equal(order.store_name, '老店');
  // No demo stores are added on top of migrated data, and re-opening is a no-op.
  await migrated.client.close();
  const again = await openDatabase({ uri: mongo.getUri(), dbName: 'food_ordering_legacy' });
  assert.equal(await again.db.collection('stores').countDocuments(), 1);
  await again.client.close();
});
