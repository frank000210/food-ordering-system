'use strict';
const path = require('node:path');
const { createRouter, HttpError } = require('./router');
const { createAuth } = require('./auth');
const { createServices, ValidationError, ORDER_STATUSES, ORDER_TYPES } = require('./services');
const { todayLocal, isValidDate } = require('./time');

const hostOf = (url) => { try { return url ? new URL(url).host.toLowerCase() : ''; } catch { return ''; } };

/**
 * options:
 *   secureCookies — add Secure to the session cookie (COOKIE_SECURE=1)
 *   trustProxy    — read client IP / host from X-Forwarded-* (TRUST_PROXY=1)
 *   credentials   — { username, password } for the back office (defaults to ADMIN / ADMIN_PASSWORD)
 *   storefrontUrl / adminUrl — separate customer and back-office domains (STOREFRONT_URL / ADMIN_URL)
 *   authDisabled  — testing only: open the back office without login (ADMIN_AUTH_DISABLED=1)
 */
function createApp(db, options = {}) {
  const app = createRouter();
  const auth = createAuth(db, { credentials: options.credentials });
  const svc = createServices(db);
  const secureCookies = options.secureCookies ?? process.env.COOKIE_SECURE === '1';
  const trustProxy = options.trustProxy ?? process.env.TRUST_PROXY === '1';
  const storefrontUrl = (options.storefrontUrl ?? process.env.STOREFRONT_URL ?? '').replace(/\/+$/, '');
  const adminUrl = (options.adminUrl ?? process.env.ADMIN_URL ?? '').replace(/\/+$/, '');
  const adminHost = hostOf(adminUrl);
  const authDisabled = options.authDisabled ?? process.env.ADMIN_AUTH_DISABLED === '1';
  if (authDisabled) console.warn('[auth] ADMIN_AUTH_DISABLED=1：後台不需登入，僅限測試期間使用');
  const clientIp = (req) => (trustProxy && req.headers['x-forwarded-for']
    ? String(req.headers['x-forwarded-for']).split(',')[0].trim()
    : req.socket.remoteAddress);
  const requestHost = (req) => String((trustProxy && req.headers['x-forwarded-host']) || req.headers.host || '')
    .split(',')[0].trim().toLowerCase();

  app.use('/', (req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    if (secureCookies) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
    next();
  });

  // Separate entry points: when ADMIN_URL is set, the back office only answers on that host
  // and the customer pages only answer on the other host(s).
  if (adminHost) {
    const isAdminPath = (p) => p === '/admin' || p.startsWith('/admin/') || p.startsWith('/api/admin/');
    const CUSTOMER_PAGES = new Set(['/', '/index.html', '/order', '/order.html', '/track', '/track.html']);
    app.use('/', (req, res, next) => {
      const onAdminHost = requestHost(req) === adminHost;
      if (onAdminHost && CUSTOMER_PAGES.has(req.path)) {
        return res.redirect(req.path === '/' || !storefrontUrl ? '/admin/' : storefrontUrl + req.url);
      }
      if (!onAdminHost && isAdminPath(req.path)) {
        if (req.path.startsWith('/api/')) return res.status(404).json({ error: '找不到此 API' });
        res.status(404);
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        return res.send('找不到頁面');
      }
      next();
    });
  }

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
    if (authDisabled) {
      req.admin = { username: '測試模式', auth_disabled: true };
      return next();
    }
    return auth.requireAdmin(req, res, next);
  });

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

  app.get('/api/store', async (req, res) => res.json(await svc.getSettings()));

  app.get('/api/menu', async (req, res) => {
    const [store, categories] = await Promise.all([svc.getSettings(), svc.getPublicMenu()]);
    res.json({ store, categories, admin_url: adminUrl ? `${adminUrl}/admin/` : '/admin/' });
  });

  app.post('/api/orders', async (req, res) => {
    res.status(201).json(await svc.createOrder(req.body || {}));
  });

  app.get('/api/orders/view', async (req, res) => {
    res.json(await svc.viewOrder(req.query.no, req.query.t));
  });

  app.get('/api/orders/lookup', async (req, res) => {
    res.json({ orders: await svc.lookupOrders(req.query) });
  });

  /* ------------------------------ Admin auth ------------------------------ */

  app.post('/api/admin/login', async (req, res) => {
    if (authDisabled) return res.json({ username: '測試模式', auth_disabled: true });
    if (!auth.isConfigured()) return res.status(503).json({ error: '後台帳密尚未設定（ADMIN / ADMIN_PASSWORD）' });
    const ip = clientIp(req);
    if (auth.isThrottled(ip)) return res.status(429).json({ error: '登入失敗次數過多，請 15 分鐘後再試' });
    const username = String((req.body || {}).username || '');
    const password = String((req.body || {}).password || '');
    if (!auth.checkCredentials(username, password)) {
      auth.recordFailure(ip);
      return res.status(401).json({ error: '帳號或密碼錯誤' });
    }
    auth.clearFailures(ip);
    await auth.startSession(res, username, secureCookies);
    res.json({ username });
  });

  app.post('/api/admin/logout', async (req, res) => {
    await auth.endSession(req, res);
    res.json({ ok: true });
  });

  app.get('/api/admin/me', (req, res) => res.json({ ...req.admin, storefront_url: storefrontUrl || '/' }));

  /* ---------------------------- Admin: dashboard -------------------------- */

  app.get('/api/admin/dashboard', async (req, res) => {
    const today = todayLocal();
    const [report, active, recent, store] = await Promise.all([
      svc.dailyReport(today), svc.activeOrderCounts(), svc.listOrders({ limit: 8 }), svc.getSettings(),
    ]);
    res.json({
      today,
      order_count: report.order_count,
      total_revenue: report.total_revenue,
      average_order_value: report.average_order_value,
      active,
      top_items: report.items.slice(0, 5),
      recent_orders: recent,
      store_open: store.is_open,
    });
  });

  /* ----------------------------- Admin: store ----------------------------- */

  app.get('/api/admin/store', async (req, res) => res.json(await svc.getSettings()));
  app.put('/api/admin/store', async (req, res) => res.json(await svc.updateSettings(req.body || {})));

  /* --------------------------- Admin: categories -------------------------- */

  app.get('/api/admin/categories', async (req, res) => res.json(await svc.listCategories()));
  app.post('/api/admin/categories', async (req, res) => {
    res.status(201).json(await svc.createCategory(req.body || {}));
  });
  app.put('/api/admin/categories/:id', async (req, res) => {
    res.json(await svc.updateCategory(idParam(req), req.body || {}));
  });
  app.delete('/api/admin/categories/:id', async (req, res) => {
    await svc.deleteCategory(idParam(req));
    res.json({ ok: true });
  });

  /* ---------------------------- Admin: menu items ------------------------- */

  app.get('/api/admin/items', async (req, res) => res.json(await svc.listItems()));
  app.post('/api/admin/items', async (req, res) => {
    res.status(201).json(await svc.createItem(req.body || {}));
  });
  app.put('/api/admin/items/:id', async (req, res) => {
    res.json(await svc.updateItem(idParam(req), req.body || {}));
  });
  app.patch('/api/admin/items/:id/availability', async (req, res) => {
    res.json(await svc.setItemAvailability(idParam(req), Boolean(req.body && req.body.available)));
  });
  app.delete('/api/admin/items/:id', async (req, res) => {
    await svc.deleteItem(idParam(req));
    res.json({ ok: true });
  });

  /* ------------------------------ Admin: orders --------------------------- */

  app.get('/api/admin/orders', async (req, res) => {
    const date = req.query.date ? dateParam(req.query.date) : '';
    res.json(await svc.listOrders({ date, status: req.query.status, q: String(req.query.q || '').trim() }));
  });

  app.get('/api/admin/orders/:id', async (req, res) => {
    const order = await svc.getOrder(idParam(req));
    if (!order) throw new ValidationError('找不到訂單', 404);
    res.json(order);
  });

  app.patch('/api/admin/orders/:id/status', async (req, res) => {
    res.json(await svc.updateOrderStatus(idParam(req), (req.body || {}).status));
  });

  /* ----------------------------- Admin: reports --------------------------- */

  app.get('/api/admin/reports/daily', async (req, res) => {
    res.json(await svc.dailyReport(dateParam(req.query.date)));
  });

  app.get('/api/admin/reports/daily.csv', async (req, res) => {
    const report = await svc.dailyReport(dateParam(req.query.date));
    // Prefix cells Excel would evaluate as formulas (CSV injection via item names).
    const esc = (v) => `"${String(v).replace(/^[=+\-@\t\r]/, "'$&").replace(/"/g, '""')}"`;
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
  });

  /* ------------------------------ Static pages ---------------------------- */

  app.static(path.join(__dirname, '..', 'public'));

  app.onError((err, req, res) => {
    if (res.headersSent) { res.end(); return; }
    if (err instanceof ValidationError || err instanceof HttpError) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error(err);
    res.status(500).json({ error: '伺服器發生錯誤' });
  });

  return app;
}

module.exports = { createApp };
