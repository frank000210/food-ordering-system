'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { openDatabase } = require('../src/db');
const { createApp } = require('../src/app');

const CREDENTIALS = { username: 'boss', password: 'test-secret-123' };

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

test('public menu lists seeded store and items', async () => {
  const { status, data } = await call('/api/menu');
  assert.equal(status, 200);
  assert.equal(data.store.store_name, '好食光便當');
  assert.ok(data.categories.length >= 3);
  assert.ok(data.categories[0].items.length > 0);
  assert.equal(data.admin_url, '/admin/');
});

test('order totals are computed from server-side prices', async () => {
  const { status, data } = await call('/api/orders', {
    method: 'POST',
    body: {
      customer_name: '王小明', customer_phone: '0912345678',
      items: [
        { menu_item_id: 1, quantity: 2, price: 1 }, // client price is ignored
        { menu_item_id: 6, quantity: 1 },
        { menu_item_id: 1, quantity: 1 },           // duplicate lines merge
      ],
    },
  });
  assert.equal(status, 201);
  assert.match(data.order_no, /^\d{8}-0001$/);
  assert.equal(data.items.length, 2);
  const bento = data.items.find((i) => i.menu_item_id === 1);
  assert.equal(bento.unit_price, 110);
  assert.equal(bento.quantity, 3);
  assert.equal(bento.subtotal, 330);
  assert.equal(data.total, 330 + 30);
  assert.equal(data.status, 'pending');
  assert.match(data.access_token, /^[0-9a-f]{32}$/);

  // The confirmation page link (order no + token) works; a wrong token does not.
  const view = await call(`/api/orders/view?no=${data.order_no}&t=${data.access_token}`);
  assert.equal(view.status, 200);
  assert.equal(view.data.total, 360);
  const badView = await call(`/api/orders/view?no=${data.order_no}&t=${'0'.repeat(32)}`);
  assert.equal(badView.status, 404);
});

test('order validation rejects bad input', async () => {
  const cases = [
    [{ items: [{ menu_item_id: 1, quantity: 1 }] }, /顧客名稱/],
    [{ customer_name: 'A', items: [] }, /至少/],
    [{ customer_name: 'A', items: [{ menu_item_id: 1, quantity: 0 }] }, /正整數/],
    [{ customer_name: 'A', items: [{ menu_item_id: 1, quantity: 1.5 }] }, /正整數/],
    [{ customer_name: 'A', items: [{ menu_item_id: 9999, quantity: 1 }] }, /無法供應/],
    [{ customer_name: 'A', items: [{ menu_item_id: 1, quantity: 100 }] }, /上限/],
  ];
  for (const [body, msg] of cases) {
    const { status, data } = await call('/api/orders', { method: 'POST', body });
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

test('customer lookup requires matching contact', async () => {
  const ok = await call('/api/orders/lookup?order_no=' + encodeURIComponent((await latestOrderNo())) + '&contact=王小明');
  assert.equal(ok.data.orders.length, 1);
  const wrong = await call('/api/orders/lookup?order_no=' + encodeURIComponent((await latestOrderNo())) + '&contact=別人');
  assert.equal(wrong.data.orders.length, 0);
  assert.equal(ok.data.orders[0].access_token, undefined);
  // A phone number alone is not enough; it must come with the matching name.
  const phoneOnly = await call('/api/orders/lookup?phone=0912345678');
  assert.equal(phoneOnly.status, 400);
  const byPhone = await call('/api/orders/lookup?phone=0912345678&name=' + encodeURIComponent('王小明'));
  assert.equal(byPhone.data.orders.length, 1);
  const wrongName = await call('/api/orders/lookup?phone=0912345678&name=' + encodeURIComponent('路人'));
  assert.equal(wrongName.data.orders.length, 0);
  const none = await call('/api/orders/lookup');
  assert.equal(none.status, 400);
});

async function latestOrderNo() {
  const { data } = await call('/api/orders/lookup?phone=0912345678&name=' + encodeURIComponent('王小明'));
  return data.orders[0].order_no;
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

test('admin login, store settings and menu CRUD', async () => {
  const res = await call('/api/admin/login', { method: 'POST', body: CREDENTIALS, raw: true });
  assert.equal(res.status, 200);
  cookie = res.headers.get('set-cookie').split(';')[0];
  assert.match(res.headers.get('set-cookie'), /HttpOnly/);

  const store = await call('/api/admin/store', { method: 'PUT', auth: true, body: { store_name: '測試小館', store_phone: '02-1111-2222' } });
  assert.equal(store.data.store_name, '測試小館');
  const blank = await call('/api/admin/store', { method: 'PUT', auth: true, body: { store_name: '  ' } });
  assert.equal(blank.status, 400);

  const cat = await call('/api/admin/categories', { method: 'POST', auth: true, body: { name: '甜點', sort_order: 9 } });
  assert.equal(cat.status, 201);
  const item = await call('/api/admin/items', { method: 'POST', auth: true,
    body: { name: '紅豆湯', price: 45, category_id: cat.data.id, description: '熱的' } });
  assert.equal(item.status, 201);
  assert.equal(item.data.price, 45);

  const badPrice = await call('/api/admin/items', { method: 'POST', auth: true, body: { name: 'x', price: -1 } });
  assert.equal(badPrice.status, 400);

  const upd = await call(`/api/admin/items/${item.data.id}`, { method: 'PUT', auth: true,
    body: { name: '紅豆湯（熱）', price: 50, category_id: cat.data.id } });
  assert.equal(upd.data.price, 50);

  // Unavailable items disappear from the public menu and cannot be ordered.
  await call(`/api/admin/items/${item.data.id}/availability`, { method: 'PATCH', auth: true, body: { available: false } });
  const menu = await call('/api/menu');
  assert.ok(!menu.data.categories.some((c) => c.items.some((i) => i.id === item.data.id)));
  const order = await call('/api/orders', { method: 'POST',
    body: { customer_name: 'B', items: [{ menu_item_id: item.data.id, quantity: 1 }] } });
  assert.equal(order.status, 400);

  const del = await call(`/api/admin/items/${item.data.id}`, { method: 'DELETE', auth: true, body: {} });
  assert.equal(del.status, 200);
});

test('closed store rejects orders', async () => {
  await call('/api/admin/store', { method: 'PUT', auth: true, body: { is_open: false } });
  const r = await call('/api/orders', { method: 'POST', body: { customer_name: 'C', items: [{ menu_item_id: 2, quantity: 1 }] } });
  assert.equal(r.status, 409);
  await call('/api/admin/store', { method: 'PUT', auth: true, body: { is_open: true } });
});

test('order status workflow and daily report', async () => {
  // Second order: 2 × 香煎雞腿便當 (120) = 240
  const o2 = await call('/api/orders', { method: 'POST', body: { customer_name: '李小華', items: [{ menu_item_id: 2, quantity: 2 }] } });
  // Third order, later cancelled: should be excluded from the report.
  const o3 = await call('/api/orders', { method: 'POST', body: { customer_name: '陳大文', items: [{ menu_item_id: 1, quantity: 5 }] } });
  assert.match(o3.data.order_no, /-0003$/);

  const s = await call(`/api/admin/orders/${o2.data.id}/status`, { method: 'PATCH', auth: true, body: { status: 'completed' } });
  assert.equal(s.data.status, 'completed');
  await call(`/api/admin/orders/${o3.data.id}/status`, { method: 'PATCH', auth: true, body: { status: 'cancelled' } });
  const bad = await call(`/api/admin/orders/${o3.data.id}/status`, { method: 'PATCH', auth: true, body: { status: 'eaten' } });
  assert.equal(bad.status, 400);

  const list = await call('/api/admin/orders?q=李小華', { auth: true });
  assert.equal(list.data.length, 1);

  const { data: r } = await call('/api/admin/reports/daily', { auth: true });
  assert.equal(r.order_count, 2);
  assert.equal(r.total_revenue, 360 + 240);
  assert.equal(r.cancelled_count, 1);
  const bento = r.items.find((i) => i.name === '招牌排骨便當');
  assert.equal(bento.quantity, 3);
  assert.equal(bento.revenue, 330);
  const chicken = r.items.find((i) => i.name === '香煎雞腿便當');
  assert.equal(chicken.quantity, 2);
  assert.equal(chicken.revenue, 240);
  assert.equal(r.items.reduce((s, i) => s + i.revenue, 0), r.total_revenue);

  const dash = await call('/api/admin/dashboard', { auth: true });
  assert.equal(dash.data.order_count, 2);
  assert.equal(dash.data.active.pending, 1);

  const csv = await call('/api/admin/reports/daily.csv', { auth: true });
  assert.match(csv.data, /招牌排骨便當/);
  assert.match(csv.data, /總營收","600"/);

  const badDate = await call('/api/admin/reports/daily?date=2026-13-40', { auth: true });
  assert.equal(badDate.status, 400);
});

test('static pages are served', async () => {
  for (const p of ['/', '/track', '/order', '/admin/', '/admin/login', '/admin/report']) {
    const res = await fetch(base + p);
    assert.equal(res.status, 200, p);
    assert.match(res.headers.get('content-type'), /text\/html/);
  }
  const traversal = await fetch(base + '/..%2fpackage.json');
  assert.equal(traversal.status, 404);
});

test('data persists across app instances (same database)', async () => {
  const s = await listen(createApp(conn.db, { credentials: CREDENTIALS }));
  const data = await (await fetch(s.base + '/api/menu')).json();
  assert.equal(data.store.store_name, '測試小館');
  s.server.close();
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
  const menu = await (await fetch(s.base + '/api/menu')).json();
  assert.equal(menu.admin_url, 'https://admin.example.test/admin/');
  assert.equal((await get('/admin/', 'shop.example.test')).statusCode, 404);
  assert.equal((await get('/api/admin/me', 'shop.example.test')).statusCode, 404);
  // Admin host: back office works, customer pages redirect.
  assert.equal((await get('/admin/', 'admin.example.test')).statusCode, 200);
  assert.equal((await get('/api/admin/me', 'admin.example.test')).statusCode, 401);
  const root = await get('/', 'admin.example.test');
  assert.equal(root.statusCode, 302);
  assert.equal(root.headers.location, '/admin/');
  const track = await get('/track?no=1', 'admin.example.test');
  assert.equal(track.headers.location, 'https://shop.example.test/track?no=1');
  assert.equal((await get('/assets/common.js', 'admin.example.test')).statusCode, 200);
  s.server.close();
});

test('CSV export neutralises spreadsheet formulas', async () => {
  const cat = await call('/api/admin/categories', { method: 'POST', auth: true, body: { name: 'X' } });
  const item = await call('/api/admin/items', { method: 'POST', auth: true,
    body: { name: '=HYPERLINK("x")', price: 10, category_id: cat.data.id } });
  await call('/api/orders', { method: 'POST', body: { customer_name: 'D', items: [{ menu_item_id: item.data.id, quantity: 1 }] } });
  const csv = await call('/api/admin/reports/daily.csv', { auth: true });
  assert.match(csv.data, /"'=HYPERLINK\(""x""\)"/);
});
