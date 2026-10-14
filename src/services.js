'use strict';
const { transaction } = require('./db');
const { nowLocal, todayLocal } = require('./time');

const ORDER_STATUSES = {
  pending: '待確認',
  confirmed: '已接單',
  preparing: '製作中',
  ready: '可取餐',
  completed: '已完成',
  cancelled: '已取消',
};
const ORDER_TYPES = { takeout: '外帶自取', dine_in: '內用', delivery: '外送' };
const MAX_QTY_PER_ITEM = 99;

class ValidationError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

function str(v, max) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function createServices(db) {
  const q = {
    allSettings: db.prepare('SELECT key, value FROM settings'),
    setSetting: db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`),
    itemById: db.prepare(`SELECT m.*, c.active AS category_active FROM menu_items m
      LEFT JOIN categories c ON c.id = m.category_id WHERE m.id = ?`),
    lastOrderNoOfDay: db.prepare(`SELECT order_no FROM orders WHERE order_date = ?
      ORDER BY id DESC LIMIT 1`),
    insertOrder: db.prepare(`INSERT INTO orders (order_no, customer_name, customer_phone, order_type,
      pickup_time, note, total, status, order_date, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`),
    insertOrderItem: db.prepare(`INSERT INTO order_items (order_id, menu_item_id, item_name,
      unit_price, quantity, subtotal) VALUES (?, ?, ?, ?, ?, ?)`),
    orderById: db.prepare('SELECT * FROM orders WHERE id = ?'),
    orderByNo: db.prepare('SELECT * FROM orders WHERE order_no = ?'),
    orderItems: db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id'),
  };

  function getSettings() {
    const out = {};
    for (const row of q.allSettings.all()) out[row.key] = row.value;
    out.is_open = out.is_open === '1';
    return out;
  }

  function updateSettings(input) {
    const allowed = ['store_name', 'store_phone', 'store_address', 'business_hours',
      'store_description', 'announcement'];
    if ('store_name' in input && !str(input.store_name, 120)) throw new ValidationError('商家名稱不可空白');
    transaction(db, () => {
      for (const key of allowed) {
        if (key in input) q.setSetting.run(key, str(input[key], key === 'store_description' || key === 'announcement' ? 500 : 120));
      }
      if ('is_open' in input) q.setSetting.run('is_open', input.is_open ? '1' : '0');
    });
    return getSettings();
  }

  function getPublicMenu() {
    const categories = db.prepare(`SELECT id, name FROM categories WHERE active = 1
      ORDER BY sort_order, id`).all();
    const items = db.prepare(`SELECT m.id, m.category_id, m.name, m.description, m.price, m.image_url
      FROM menu_items m LEFT JOIN categories c ON c.id = m.category_id
      WHERE m.available = 1 AND (c.id IS NULL OR c.active = 1)
      ORDER BY m.sort_order, m.id`).all();
    const result = categories.map((c) => ({ ...c, items: items.filter((i) => i.category_id === c.id) }));
    const uncategorized = items.filter((i) => i.category_id === null);
    if (uncategorized.length) result.push({ id: null, name: '其他', items: uncategorized });
    return result.filter((c) => c.items.length > 0);
  }

  function nextOrderNo(date) {
    const last = q.lastOrderNoOfDay.get(date);
    const seq = last ? parseInt(last.order_no.split('-')[1], 10) + 1 : 1;
    return `${date.replace(/-/g, '')}-${String(seq).padStart(4, '0')}`;
  }

  function getOrder(id) {
    const order = q.orderById.get(id);
    if (!order) return null;
    return decorateOrder(order);
  }

  function getOrderByNo(orderNo) {
    const order = q.orderByNo.get(orderNo);
    return order ? decorateOrder(order) : null;
  }

  function decorateOrder(order) {
    return {
      ...order,
      status_label: ORDER_STATUSES[order.status] || order.status,
      order_type_label: ORDER_TYPES[order.order_type] || order.order_type,
      items: q.orderItems.all(order.id),
    };
  }

  /**
   * Create an order. Prices always come from the database, never from the client.
   */
  function createOrder(input) {
    const settings = getSettings();
    if (!settings.is_open) throw new ValidationError('店家目前暫停接單，請稍後再試', 409);

    const customerName = str(input.customer_name, 50);
    const customerPhone = str(input.customer_phone, 20);
    const orderType = ORDER_TYPES[input.order_type] ? input.order_type : 'takeout';
    const pickupTime = str(input.pickup_time, 30);
    const note = str(input.note, 300);

    if (!customerName) throw new ValidationError('請輸入顧客名稱');
    if (customerPhone && !/^[0-9+\-() ]{6,20}$/.test(customerPhone)) {
      throw new ValidationError('電話格式不正確');
    }
    if (!Array.isArray(input.items) || input.items.length === 0) {
      throw new ValidationError('請至少選擇一項餐點');
    }

    // Merge duplicate lines for the same item.
    const merged = new Map();
    for (const line of input.items) {
      const id = Number(line && line.menu_item_id);
      const qty = Number(line && line.quantity);
      if (!Number.isInteger(id) || id <= 0) throw new ValidationError('餐點資料不正確');
      if (!Number.isInteger(qty) || qty <= 0) throw new ValidationError('數量必須為正整數');
      merged.set(id, (merged.get(id) || 0) + qty);
    }

    const lines = [];
    for (const [id, qty] of merged) {
      if (qty > MAX_QTY_PER_ITEM) throw new ValidationError(`單一餐點數量上限為 ${MAX_QTY_PER_ITEM}`);
      const item = q.itemById.get(id);
      if (!item || !item.available || item.category_active === 0) {
        throw new ValidationError(`餐點「${item ? item.name : id}」目前無法供應`);
      }
      lines.push({ id, name: item.name, price: item.price, qty, subtotal: item.price * qty });
    }
    const total = lines.reduce((s, l) => s + l.subtotal, 0);

    const orderId = transaction(db, () => {
      const now = nowLocal();
      const date = todayLocal();
      const orderNo = nextOrderNo(date);
      const { lastInsertRowid } = q.insertOrder.run(orderNo, customerName, customerPhone, orderType,
        pickupTime, note, total, date, now, now);
      for (const l of lines) {
        q.insertOrderItem.run(lastInsertRowid, l.id, l.name, l.price, l.qty, l.subtotal);
      }
      return lastInsertRowid;
    });
    return getOrder(orderId);
  }

  /** Customer-side lookup. Needs order no + matching name/phone, or a phone number alone. */
  function lookupOrders({ order_no: orderNo, contact, phone }) {
    orderNo = str(orderNo, 20);
    contact = str(contact, 50);
    phone = str(phone, 20);
    if (orderNo) {
      if (!contact) throw new ValidationError('請輸入訂購人姓名或電話以驗證訂單');
      const order = getOrderByNo(orderNo);
      if (!order || (order.customer_name !== contact && order.customer_phone !== contact)) return [];
      return [order];
    }
    if (phone) {
      if (phone.replace(/\D/g, '').length < 6) throw new ValidationError('請輸入完整電話號碼');
      const rows = db.prepare(`SELECT id FROM orders WHERE customer_phone = ?
        ORDER BY id DESC LIMIT 20`).all(phone);
      return rows.map((r) => getOrder(r.id));
    }
    throw new ValidationError('請輸入訂單編號或電話');
  }

  function listOrders({ date, status, q: keyword, limit = 200 }) {
    const where = [];
    const params = [];
    if (date) { where.push('order_date = ?'); params.push(date); }
    if (status && ORDER_STATUSES[status]) { where.push('status = ?'); params.push(status); }
    if (keyword) {
      where.push('(order_no LIKE ? OR customer_name LIKE ? OR customer_phone LIKE ?)');
      const like = `%${keyword}%`;
      params.push(like, like, like);
    }
    const sql = `SELECT o.*, (SELECT SUM(quantity) FROM order_items WHERE order_id = o.id) AS item_count
      FROM orders o ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY o.id DESC LIMIT ?`;
    params.push(Math.min(Number(limit) || 200, 500));
    return db.prepare(sql).all(...params).map((o) => ({
      ...o,
      status_label: ORDER_STATUSES[o.status],
      order_type_label: ORDER_TYPES[o.order_type],
    }));
  }

  function updateOrderStatus(id, status) {
    if (!ORDER_STATUSES[status]) throw new ValidationError('訂單狀態不正確');
    const res = db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, nowLocal(), id);
    if (res.changes === 0) throw new ValidationError('找不到訂單', 404);
    return getOrder(id);
  }

  /** Daily sales report. Cancelled orders are excluded from sales figures. */
  function dailyReport(date) {
    const items = db.prepare(`SELECT oi.item_name AS name, oi.unit_price,
        SUM(oi.quantity) AS quantity, SUM(oi.subtotal) AS revenue
      FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE o.order_date = ? AND o.status != 'cancelled'
      GROUP BY oi.item_name, oi.unit_price
      ORDER BY revenue DESC, quantity DESC`).all(date);
    const summary = db.prepare(`SELECT COUNT(*) AS order_count, COALESCE(SUM(total), 0) AS total_revenue
      FROM orders WHERE order_date = ? AND status != 'cancelled'`).get(date);
    const cancelled = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(total), 0) AS amount
      FROM orders WHERE order_date = ? AND status = 'cancelled'`).get(date);
    const byStatus = db.prepare(`SELECT status, COUNT(*) AS n FROM orders WHERE order_date = ?
      GROUP BY status`).all(date).map((r) => ({ ...r, label: ORDER_STATUSES[r.status] }));
    const hourly = db.prepare(`SELECT substr(created_at, 12, 2) AS hour, COUNT(*) AS orders,
        SUM(total) AS revenue
      FROM orders WHERE order_date = ? AND status != 'cancelled'
      GROUP BY hour ORDER BY hour`).all(date);
    const totalQty = items.reduce((s, i) => s + i.quantity, 0);
    return {
      date,
      order_count: summary.order_count,
      total_quantity: totalQty,
      total_revenue: summary.total_revenue,
      average_order_value: summary.order_count ? Math.round(summary.total_revenue / summary.order_count) : 0,
      cancelled_count: cancelled.n,
      cancelled_amount: cancelled.amount,
      items,
      by_status: byStatus,
      hourly,
    };
  }

  return {
    getSettings, updateSettings, getPublicMenu, createOrder, getOrder, getOrderByNo,
    lookupOrders, listOrders, updateOrderStatus, dailyReport,
  };
}

module.exports = { createServices, ValidationError, ORDER_STATUSES, ORDER_TYPES };
