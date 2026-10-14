'use strict';
const crypto = require('node:crypto');
const { nextSeq } = require('./db');
const { nowLocal, todayLocal } = require('./time');

const ORDER_STATUSES = {
  pending: '待確認',
  confirmed: '已接單',
  preparing: '製作中',
  ready: '可取餐',
  completed: '已完成',
  cancelled: '已取消',
};
const ACTIVE_STATUSES = ['pending', 'confirmed', 'preparing', 'ready'];
const ORDER_TYPES = { takeout: '外帶自取', dine_in: '內用', delivery: '外送' };
const MAX_QTY_PER_ITEM = 99;

class ValidationError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

function str(v, max) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Mongo document -> API shape ({ _id } becomes { id }). */
function toApi(doc) {
  if (!doc) return doc;
  const { _id, ...rest } = doc;
  return { id: _id, ...rest };
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function createServices(db) {
  const settings = db.collection('settings');
  const categories = db.collection('categories');
  const menuItems = db.collection('menu_items');
  const orders = db.collection('orders');

  /* ------------------------------- Settings ------------------------------- */

  async function getSettings() {
    const out = {};
    for (const row of await settings.find().toArray()) out[row._id] = row.value;
    out.is_open = out.is_open === '1';
    return out;
  }

  async function updateSettings(input) {
    const allowed = ['store_name', 'store_phone', 'store_address', 'business_hours',
      'store_description', 'announcement'];
    if ('store_name' in input && !str(input.store_name, 120)) throw new ValidationError('商家名稱不可空白');
    const ops = [];
    for (const key of allowed) {
      if (key in input) {
        const value = str(input[key], key === 'store_description' || key === 'announcement' ? 500 : 120);
        ops.push({ updateOne: { filter: { _id: key }, update: { $set: { value } }, upsert: true } });
      }
    }
    if ('is_open' in input) {
      ops.push({ updateOne: { filter: { _id: 'is_open' },
        update: { $set: { value: input.is_open ? '1' : '0' } }, upsert: true } });
    }
    if (ops.length) await settings.bulkWrite(ops);
    return getSettings();
  }

  /* --------------------------------- Menu --------------------------------- */

  async function getPublicMenu() {
    const cats = await categories.find({ active: 1 }).sort({ sort_order: 1, _id: 1 }).toArray();
    const activeIds = new Set(cats.map((c) => c._id));
    const items = (await menuItems.find({ available: 1 }).sort({ sort_order: 1, _id: 1 }).toArray())
      .filter((m) => m.category_id === null || activeIds.has(m.category_id))
      .map((m) => ({ id: m._id, category_id: m.category_id, name: m.name, description: m.description,
        price: m.price, image_url: m.image_url }));
    const result = cats.map((c) => ({ id: c._id, name: c.name,
      items: items.filter((i) => i.category_id === c._id) }));
    const uncategorized = items.filter((i) => i.category_id === null);
    if (uncategorized.length) result.push({ id: null, name: '其他', items: uncategorized });
    return result.filter((c) => c.items.length > 0);
  }

  function readCategory(body) {
    const name = str(body.name, 40);
    if (!name) throw new ValidationError('分類名稱不可空白');
    return { name, sort_order: Number.isInteger(Number(body.sort_order)) ? Number(body.sort_order) : 0,
      active: body.active === false || body.active === 0 ? 0 : 1 };
  }

  async function listCategories() {
    const [cats, counts] = await Promise.all([
      categories.find().sort({ sort_order: 1, _id: 1 }).toArray(),
      menuItems.aggregate([{ $group: { _id: '$category_id', n: { $sum: 1 } } }]).toArray(),
    ]);
    const countMap = new Map(counts.map((c) => [c._id, c.n]));
    return cats.map((c) => ({ ...toApi(c), item_count: countMap.get(c._id) || 0 }));
  }

  async function createCategory(body) {
    const c = readCategory(body);
    const doc = { _id: await nextSeq(db, 'categories'), ...c };
    await categories.insertOne(doc);
    return toApi(doc);
  }

  async function updateCategory(id, body) {
    const c = readCategory(body);
    const doc = await categories.findOneAndUpdate({ _id: id }, { $set: c }, { returnDocument: 'after' });
    if (!doc) throw new ValidationError('找不到分類', 404);
    return toApi(doc);
  }

  async function deleteCategory(id) {
    const r = await categories.deleteOne({ _id: id });
    if (!r.deletedCount) throw new ValidationError('找不到分類', 404);
    await menuItems.updateMany({ category_id: id }, { $set: { category_id: null } });
  }

  async function readItem(body) {
    const name = str(body.name, 60);
    if (!name) throw new ValidationError('餐點名稱不可空白');
    const price = Number(body.price);
    if (!Number.isInteger(price) || price < 0 || price > 100000) throw new ValidationError('價格需為 0–100000 的整數');
    const categoryId = body.category_id === '' || body.category_id == null ? null : Number(body.category_id);
    if (categoryId !== null && !(await categories.findOne({ _id: categoryId }))) {
      throw new ValidationError('分類不存在');
    }
    const imageUrl = str(body.image_url, 500);
    if (imageUrl && !/^https?:\/\//i.test(imageUrl) && !imageUrl.startsWith('/')) {
      throw new ValidationError('圖片網址需以 http(s):// 或 / 開頭');
    }
    return {
      name, price, category_id: categoryId,
      description: str(body.description, 300),
      image_url: imageUrl,
      available: body.available === false || body.available === 0 ? 0 : 1,
      sort_order: Number.isInteger(Number(body.sort_order)) ? Number(body.sort_order) : 0,
    };
  }

  async function listItems() {
    const [items, cats] = await Promise.all([menuItems.find().toArray(), categories.find().toArray()]);
    const catMap = new Map(cats.map((c) => [c._id, c]));
    const key = (m) => {
      const c = catMap.get(m.category_id);
      return [c ? 0 : 1, c ? c.sort_order : 0, m.category_id ?? 0, m.sort_order, m._id];
    };
    items.sort((a, b) => {
      const ka = key(a); const kb = key(b);
      for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
      return 0;
    });
    return items.map((m) => ({ ...toApi(m), category_name: catMap.get(m.category_id)?.name ?? null }));
  }

  async function createItem(body) {
    const i = await readItem(body);
    const now = nowLocal();
    const doc = { _id: await nextSeq(db, 'menu_items'), ...i, created_at: now, updated_at: now };
    await menuItems.insertOne(doc);
    return toApi(doc);
  }

  async function updateItem(id, body) {
    const i = await readItem(body);
    const doc = await menuItems.findOneAndUpdate({ _id: id }, { $set: { ...i, updated_at: nowLocal() } },
      { returnDocument: 'after' });
    if (!doc) throw new ValidationError('找不到餐點', 404);
    return toApi(doc);
  }

  async function setItemAvailability(id, available) {
    const doc = await menuItems.findOneAndUpdate({ _id: id },
      { $set: { available: available ? 1 : 0, updated_at: nowLocal() } }, { returnDocument: 'after' });
    if (!doc) throw new ValidationError('找不到餐點', 404);
    return toApi(doc);
  }

  async function deleteItem(id) {
    const r = await menuItems.deleteOne({ _id: id });
    if (!r.deletedCount) throw new ValidationError('找不到餐點', 404);
  }

  /* -------------------------------- Orders -------------------------------- */

  /** Shape an order for API output. The access token is only exposed when explicitly requested. */
  function decorateOrder(order, { withToken = false } = {}) {
    const { _id, access_token: token, ...rest } = order;
    const out = {
      id: _id,
      ...rest,
      status_label: ORDER_STATUSES[order.status] || order.status,
      order_type_label: ORDER_TYPES[order.order_type] || order.order_type,
    };
    if (withToken) out.access_token = token;
    return out;
  }

  async function getOrder(id) {
    const order = await orders.findOne({ _id: id });
    return order ? decorateOrder(order) : null;
  }

  /**
   * Create an order. Prices always come from the database, never from the client.
   */
  async function createOrder(input) {
    const store = await getSettings();
    if (!store.is_open) throw new ValidationError('店家目前暫停接單，請稍後再試', 409);

    const customerName = str(input.customer_name, 50);
    const customerPhone = str(input.customer_phone, 20);
    const orderType = Object.hasOwn(ORDER_TYPES, input.order_type) ? input.order_type : 'takeout';
    const pickupTime = str(input.pickup_time, 30);
    const note = str(input.note, 300);

    if (!customerName) throw new ValidationError('請輸入顧客名稱');
    if (customerPhone && !/^[0-9+\-() ]{6,20}$/.test(customerPhone)) {
      throw new ValidationError('電話格式不正確');
    }
    if (!Array.isArray(input.items) || input.items.length === 0) {
      throw new ValidationError('請至少選擇一項餐點');
    }
    if (input.items.length > 100) throw new ValidationError('餐點項目過多');

    // Merge duplicate lines for the same item.
    const merged = new Map();
    for (const line of input.items) {
      const id = Number(line && line.menu_item_id);
      const qty = Number(line && line.quantity);
      if (!Number.isInteger(id) || id <= 0) throw new ValidationError('餐點資料不正確');
      if (!Number.isInteger(qty) || qty <= 0) throw new ValidationError('數量必須為正整數');
      merged.set(id, (merged.get(id) || 0) + qty);
    }

    const found = await menuItems.find({ _id: { $in: [...merged.keys()] } }).toArray();
    const itemMap = new Map(found.map((m) => [m._id, m]));
    const catIds = [...new Set(found.map((m) => m.category_id).filter((c) => c !== null))];
    const inactiveCats = new Set((await categories.find({ _id: { $in: catIds }, active: 0 }).toArray())
      .map((c) => c._id));

    const lines = [];
    for (const [id, qty] of merged) {
      if (qty > MAX_QTY_PER_ITEM) throw new ValidationError(`單一餐點數量上限為 ${MAX_QTY_PER_ITEM}`);
      const item = itemMap.get(id);
      if (!item || !item.available || inactiveCats.has(item.category_id)) {
        throw new ValidationError(`餐點「${item ? item.name : id}」目前無法供應`);
      }
      lines.push({ id: lines.length + 1, menu_item_id: id, item_name: item.name, unit_price: item.price,
        quantity: qty, subtotal: item.price * qty });
    }
    const total = lines.reduce((s, l) => s + l.subtotal, 0);

    const now = nowLocal();
    const date = todayLocal();
    const compact = date.replace(/-/g, '');
    const seq = await nextSeq(db, `order_no:${compact}`);
    const doc = {
      _id: await nextSeq(db, 'orders'),
      order_no: `${compact}-${String(seq).padStart(4, '0')}`,
      access_token: crypto.randomBytes(16).toString('hex'),
      customer_name: customerName,
      customer_phone: customerPhone,
      order_type: orderType,
      pickup_time: pickupTime,
      note,
      total,
      status: 'pending',
      order_date: date,
      created_at: now,
      updated_at: now,
      items: lines,
    };
    await orders.insertOne(doc);
    return decorateOrder(doc, { withToken: true });
  }

  /** Order confirmation page: order number plus the secret token returned when it was placed. */
  async function viewOrder(orderNo, token) {
    orderNo = str(orderNo, 20);
    token = str(token, 64);
    if (!orderNo || !token) throw new ValidationError('訂單連結不完整');
    const order = await orders.findOne({ order_no: orderNo });
    if (!order || !safeEqual(order.access_token, token)) throw new ValidationError('找不到訂單', 404);
    return decorateOrder(order, { withToken: true });
  }

  /**
   * Customer-side lookup. Needs order no + matching name/phone,
   * or phone + matching name (so a phone number alone does not reveal someone's orders).
   */
  async function lookupOrders({ order_no: orderNo, contact, phone, name }) {
    orderNo = str(orderNo, 20);
    contact = str(contact, 50);
    phone = str(phone, 20);
    name = str(name, 50);
    if (orderNo) {
      if (!contact) throw new ValidationError('請輸入訂購人姓名或電話以驗證訂單');
      const order = await orders.findOne({ order_no: orderNo });
      if (!order || (order.customer_name !== contact && order.customer_phone !== contact)) return [];
      return [decorateOrder(order)];
    }
    if (phone) {
      if (phone.replace(/\D/g, '').length < 6) throw new ValidationError('請輸入完整電話號碼');
      if (!name) throw new ValidationError('請輸入訂購人姓名以驗證身分');
      const rows = await orders.find({ customer_phone: phone, customer_name: name })
        .sort({ _id: -1 }).limit(20).toArray();
      return rows.map((o) => decorateOrder(o));
    }
    throw new ValidationError('請輸入訂單編號或電話');
  }

  async function listOrders({ date, status, q: keyword, limit = 200 }) {
    const filter = {};
    if (date) filter.order_date = date;
    if (status && Object.hasOwn(ORDER_STATUSES, status)) filter.status = status;
    if (keyword) {
      const re = new RegExp(escapeRegex(String(keyword).slice(0, 50)), 'i');
      filter.$or = [{ order_no: re }, { customer_name: re }, { customer_phone: re }];
    }
    const rows = await orders.find(filter).sort({ _id: -1 })
      .limit(Math.min(Number(limit) || 200, 500)).toArray();
    return rows.map((o) => {
      const { items, ...rest } = decorateOrder(o);
      return { ...rest, item_count: items.reduce((s, i) => s + i.quantity, 0) };
    });
  }

  async function activeOrderCounts() {
    const rows = await orders.aggregate([
      { $match: { status: { $in: ACTIVE_STATUSES } } },
      { $group: { _id: '$status', n: { $sum: 1 } } },
    ]).toArray();
    return Object.fromEntries(rows.map((r) => [r._id, r.n]));
  }

  async function updateOrderStatus(id, status) {
    if (!Object.hasOwn(ORDER_STATUSES, status)) throw new ValidationError('訂單狀態不正確');
    const doc = await orders.findOneAndUpdate({ _id: id },
      { $set: { status, updated_at: nowLocal() } }, { returnDocument: 'after' });
    if (!doc) throw new ValidationError('找不到訂單', 404);
    return decorateOrder(doc);
  }

  /** Daily sales report. Cancelled orders are excluded from sales figures. */
  async function dailyReport(date) {
    const dayOrders = await orders.find({ order_date: date }).toArray();
    const valid = dayOrders.filter((o) => o.status !== 'cancelled');
    const cancelled = dayOrders.filter((o) => o.status === 'cancelled');

    const itemMap = new Map();
    for (const o of valid) {
      for (const i of o.items) {
        const key = `${i.item_name}\u0000${i.unit_price}`;
        const rec = itemMap.get(key) || { name: i.item_name, unit_price: i.unit_price, quantity: 0, revenue: 0 };
        rec.quantity += i.quantity;
        rec.revenue += i.subtotal;
        itemMap.set(key, rec);
      }
    }
    const items = [...itemMap.values()].sort((a, b) => b.revenue - a.revenue || b.quantity - a.quantity);

    const statusMap = new Map();
    for (const o of dayOrders) statusMap.set(o.status, (statusMap.get(o.status) || 0) + 1);
    const byStatus = [...statusMap].sort(([a], [b]) => a.localeCompare(b))
      .map(([status, n]) => ({ status, n, label: ORDER_STATUSES[status] }));

    const hourMap = new Map();
    for (const o of valid) {
      const hour = o.created_at.slice(11, 13);
      const rec = hourMap.get(hour) || { hour, orders: 0, revenue: 0 };
      rec.orders += 1;
      rec.revenue += o.total;
      hourMap.set(hour, rec);
    }
    const hourly = [...hourMap.values()].sort((a, b) => a.hour.localeCompare(b.hour));

    const totalRevenue = valid.reduce((s, o) => s + o.total, 0);
    return {
      date,
      order_count: valid.length,
      total_quantity: items.reduce((s, i) => s + i.quantity, 0),
      total_revenue: totalRevenue,
      average_order_value: valid.length ? Math.round(totalRevenue / valid.length) : 0,
      cancelled_count: cancelled.length,
      cancelled_amount: cancelled.reduce((s, o) => s + o.total, 0),
      items,
      by_status: byStatus,
      hourly,
    };
  }

  return {
    getSettings, updateSettings, getPublicMenu,
    listCategories, createCategory, updateCategory, deleteCategory,
    listItems, createItem, updateItem, setItemAvailability, deleteItem,
    createOrder, viewOrder, getOrder, lookupOrders, listOrders, activeOrderCounts, updateOrderStatus,
    dailyReport,
  };
}

module.exports = { createServices, ValidationError, ORDER_STATUSES, ORDER_TYPES };
