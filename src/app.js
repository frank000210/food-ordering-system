'use strict';
const path = require('node:path');
const { createRouter, HttpError } = require('./router');
const { createAuth, verifyPassword, hashPassword } = require('./auth');
const { createServices, ValidationError, ORDER_STATUSES, ORDER_TYPES } = require('./services');
const { nowLocal, todayLocal, isValidDate } = require('./time');

function createApp(db, options = {}) {
  const app = createRouter();
  const auth = createAuth(db);
  const svc = createServices(db);
  const secureCookies = options.secureCookies ?? process.env.COOKIE_SECURE === '1';
  const clientIp = (req) => (process.env.TRUST_PROXY === '1' && req.headers['x-forwarded-for']
    ? String(req.headers['x-forwarded-for']).split(',')[0].trim()
    : req.socket.remoteAddress);

  app.use('/', (req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });

  // Mutating API calls must be JSON: blocks simple cross-site form posts (CSRF).
  app.use('/api/', (req, res, next) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && !req.is('application/json')) {
      return res.status(415).json({ error: 'Content-Type 必須為 application/json' });
    }
    next();
  });

  // Everything under /api/admin/ except login/logout requires a valid admin session.
  app.use('/api/admin/', (req, res, next) => {
    if (req.path === '/api/admin/login' || req.path === '/api/admin/logout') return next();
    auth.requireAdmin(req, res, next);
  });

  const wrap = (fn) => fn;
  const idParam = (req) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new ValidationError('ID 不正確');
    return id;
  };
  const dateParam = (value) => {
    if (!value) return todayLocal();
    if (!isValidDate(value)) throw new ValidationError('日期格式需為 YYYY-MM-DD');
    return value;
  };

  /* ------------------------------ Public API ------------------------------ */

  app.get('/api/meta', (req, res) => {
    res.json({ statuses: ORDER_STATUSES, order_types: ORDER_TYPES, today: todayLocal() });
  });

  app.get('/api/store', wrap((req, res) => res.json(svc.getSettings())));

  app.get('/api/menu', wrap((req, res) => {
    res.json({ store: svc.getSettings(), categories: svc.getPublicMenu() });
  }));

  app.post('/api/orders', wrap((req, res) => {
    const order = svc.createOrder(req.body || {});
    res.status(201).json(order);
  }));

  app.get('/api/orders/lookup', wrap((req, res) => {
    res.json({ orders: svc.lookupOrders(req.query) });
  }));

  /* ------------------------------ Admin auth ------------------------------ */

  app.post('/api/admin/login', wrap((req, res) => {
    const ip = clientIp(req);
    if (auth.isThrottled(ip)) return res.status(429).json({ error: '登入失敗次數過多，請 15 分鐘後再試' });
    const { username, password } = req.body || {};
    const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(String(username || ''));
    if (!admin || !verifyPassword(password || '', admin.password_hash)) {
      auth.recordFailure(ip);
      return res.status(401).json({ error: '帳號或密碼錯誤' });
    }
    auth.clearFailures(ip);
    auth.startSession(res, admin.id, secureCookies);
    res.json({ username: admin.username });
  }));

  app.post('/api/admin/logout', (req, res) => {
    auth.endSession(req, res);
    res.json({ ok: true });
  });

  app.get('/api/admin/me', (req, res) => res.json(req.admin));

  app.post('/api/admin/password', wrap((req, res) => {
    const { current_password: current, new_password: next } = req.body || {};
    const admin = db.prepare('SELECT * FROM admins WHERE id = ?').get(req.admin.id);
    if (!verifyPassword(current || '', admin.password_hash)) throw new ValidationError('目前密碼不正確');
    if (typeof next !== 'string' || next.length < 8) throw new ValidationError('新密碼至少需 8 個字元');
    db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(hashPassword(next), admin.id);
    res.json({ ok: true });
  }));

  /* ---------------------------- Admin: dashboard -------------------------- */

  app.get('/api/admin/dashboard', wrap((req, res) => {
    const today = todayLocal();
    const report = svc.dailyReport(today);
    const active = db.prepare(`SELECT status, COUNT(*) AS n FROM orders
      WHERE status IN ('pending','confirmed','preparing','ready') GROUP BY status`).all();
    res.json({
      today,
      order_count: report.order_count,
      total_revenue: report.total_revenue,
      average_order_value: report.average_order_value,
      active: Object.fromEntries(active.map((r) => [r.status, r.n])),
      top_items: report.items.slice(0, 5),
      recent_orders: svc.listOrders({ limit: 8 }),
      store_open: svc.getSettings().is_open,
    });
  }));

  /* ----------------------------- Admin: store ----------------------------- */

  app.get('/api/admin/store', wrap((req, res) => res.json(svc.getSettings())));
  app.put('/api/admin/store', wrap((req, res) => res.json(svc.updateSettings(req.body || {}))));

  /* --------------------------- Admin: categories -------------------------- */

  const readCategory = (body) => {
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 40) : '';
    if (!name) throw new ValidationError('分類名稱不可空白');
    return { name, sort_order: Number.isInteger(Number(body.sort_order)) ? Number(body.sort_order) : 0,
      active: body.active === false || body.active === 0 ? 0 : 1 };
  };

  app.get('/api/admin/categories', wrap((req, res) => {
    res.json(db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM menu_items WHERE category_id = c.id) AS item_count
      FROM categories c ORDER BY sort_order, id`).all());
  }));

  app.post('/api/admin/categories', wrap((req, res) => {
    const c = readCategory(req.body || {});
    const { lastInsertRowid } = db.prepare('INSERT INTO categories (name, sort_order, active) VALUES (?, ?, ?)')
      .run(c.name, c.sort_order, c.active);
    res.status(201).json(db.prepare('SELECT * FROM categories WHERE id = ?').get(lastInsertRowid));
  }));

  app.put('/api/admin/categories/:id', wrap((req, res) => {
    const id = idParam(req);
    const c = readCategory(req.body || {});
    const r = db.prepare('UPDATE categories SET name = ?, sort_order = ?, active = ? WHERE id = ?')
      .run(c.name, c.sort_order, c.active, id);
    if (!r.changes) throw new ValidationError('找不到分類', 404);
    res.json(db.prepare('SELECT * FROM categories WHERE id = ?').get(id));
  }));

  app.delete('/api/admin/categories/:id', wrap((req, res) => {
    const id = idParam(req);
    const r = db.prepare('DELETE FROM categories WHERE id = ?').run(id);
    if (!r.changes) throw new ValidationError('找不到分類', 404);
    res.json({ ok: true });
  }));

  /* ---------------------------- Admin: menu items ------------------------- */

  const readItem = (body) => {
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 60) : '';
    if (!name) throw new ValidationError('餐點名稱不可空白');
    const price = Number(body.price);
    if (!Number.isInteger(price) || price < 0 || price > 100000) throw new ValidationError('價格需為 0–100000 的整數');
    let categoryId = body.category_id === '' || body.category_id == null ? null : Number(body.category_id);
    if (categoryId !== null) {
      if (!db.prepare('SELECT id FROM categories WHERE id = ?').get(categoryId)) throw new ValidationError('分類不存在');
    }
    const imageUrl = typeof body.image_url === 'string' ? body.image_url.trim().slice(0, 500) : '';
    if (imageUrl && !/^https?:\/\//i.test(imageUrl) && !imageUrl.startsWith('/')) {
      throw new ValidationError('圖片網址需以 http(s):// 或 / 開頭');
    }
    return {
      name, price, category_id: categoryId,
      description: typeof body.description === 'string' ? body.description.trim().slice(0, 300) : '',
      image_url: imageUrl,
      available: body.available === false || body.available === 0 ? 0 : 1,
      sort_order: Number.isInteger(Number(body.sort_order)) ? Number(body.sort_order) : 0,
    };
  };

  app.get('/api/admin/items', wrap((req, res) => {
    res.json(db.prepare(`SELECT m.*, c.name AS category_name FROM menu_items m
      LEFT JOIN categories c ON c.id = m.category_id
      ORDER BY c.sort_order IS NULL, c.sort_order, m.category_id, m.sort_order, m.id`).all());
  }));

  app.post('/api/admin/items', wrap((req, res) => {
    const i = readItem(req.body || {});
    const now = nowLocal();
    const { lastInsertRowid } = db.prepare(`INSERT INTO menu_items
      (category_id, name, description, price, image_url, available, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(i.category_id, i.name, i.description, i.price, i.image_url, i.available, i.sort_order, now, now);
    res.status(201).json(db.prepare('SELECT * FROM menu_items WHERE id = ?').get(lastInsertRowid));
  }));

  app.put('/api/admin/items/:id', wrap((req, res) => {
    const id = idParam(req);
    const i = readItem(req.body || {});
    const r = db.prepare(`UPDATE menu_items SET category_id = ?, name = ?, description = ?, price = ?,
      image_url = ?, available = ?, sort_order = ?, updated_at = ? WHERE id = ?`)
      .run(i.category_id, i.name, i.description, i.price, i.image_url, i.available, i.sort_order, nowLocal(), id);
    if (!r.changes) throw new ValidationError('找不到餐點', 404);
    res.json(db.prepare('SELECT * FROM menu_items WHERE id = ?').get(id));
  }));

  app.patch('/api/admin/items/:id/availability', wrap((req, res) => {
    const id = idParam(req);
    const r = db.prepare('UPDATE menu_items SET available = ?, updated_at = ? WHERE id = ?')
      .run(req.body && req.body.available ? 1 : 0, nowLocal(), id);
    if (!r.changes) throw new ValidationError('找不到餐點', 404);
    res.json(db.prepare('SELECT * FROM menu_items WHERE id = ?').get(id));
  }));

  app.delete('/api/admin/items/:id', wrap((req, res) => {
    const id = idParam(req);
    const r = db.prepare('DELETE FROM menu_items WHERE id = ?').run(id);
    if (!r.changes) throw new ValidationError('找不到餐點', 404);
    res.json({ ok: true });
  }));

  /* ------------------------------ Admin: orders --------------------------- */

  app.get('/api/admin/orders', wrap((req, res) => {
    const date = req.query.date ? dateParam(req.query.date) : '';
    res.json(svc.listOrders({ date, status: req.query.status, q: String(req.query.q || '').trim() }));
  }));

  app.get('/api/admin/orders/:id', wrap((req, res) => {
    const order = svc.getOrder(idParam(req));
    if (!order) throw new ValidationError('找不到訂單', 404);
    res.json(order);
  }));

  app.patch('/api/admin/orders/:id/status', wrap((req, res) => {
    res.json(svc.updateOrderStatus(idParam(req), (req.body || {}).status));
  }));

  /* ----------------------------- Admin: reports --------------------------- */

  app.get('/api/admin/reports/daily', wrap((req, res) => {
    res.json(svc.dailyReport(dateParam(req.query.date)));
  }));

  app.get('/api/admin/reports/daily.csv', wrap((req, res) => {
    const report = svc.dailyReport(dateParam(req.query.date));
    const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
    const rows = [['餐點名稱', '單價', '銷售數量', '營收']];
    for (const i of report.items) rows.push([i.name, i.unit_price, i.quantity, i.revenue]);
    rows.push([]);
    rows.push(['訂單數', report.order_count]);
    rows.push(['總銷售數量', report.total_quantity]);
    rows.push(['總營收', report.total_revenue]);
    const csv = '﻿' + rows.map((r) => r.map(esc).join(',')).join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="sales-${report.date}.csv"`);
    res.send(csv);
  }));

  /* ------------------------------ Static pages ---------------------------- */

  app.static(path.join(__dirname, '..', 'public'));

  app.onError((err, req, res) => {
    if (err instanceof ValidationError || err instanceof HttpError) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error(err);
    res.status(500).json({ error: '伺服器發生錯誤' });
  });

  return app;
}

module.exports = { createApp };
