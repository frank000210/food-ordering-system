/* Shared helpers for storefront and admin pages. */
(function () {
  'use strict';

  async function api(path, { method = 'GET', body } = {}) {
    const opts = { method, headers: {}, credentials: 'same-origin' };
    if (body === undefined && method !== 'GET') body = {}; // server requires JSON for writes
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(path, opts);
    let data = null;
    const type = res.headers.get('content-type') || '';
    if (type.includes('application/json')) data = await res.json();
    if (!res.ok) {
      const err = new Error((data && data.error) || `請求失敗（${res.status}）`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  const money = (n) => 'NT$ ' + Number(n || 0).toLocaleString('zh-TW');

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

  function toast(message, type = 'info') {
    let box = document.querySelector('.toast-box');
    if (!box) {
      box = document.createElement('div');
      box.className = 'toast-box';
      box.setAttribute('role', 'status');
      box.setAttribute('aria-live', 'polite');
      document.body.appendChild(box);
    }
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = message;
    box.appendChild(el);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, 2800);
  }

  const STATUS_CLASS = {
    pending: 'st-pending', confirmed: 'st-confirmed', preparing: 'st-preparing',
    ready: 'st-ready', completed: 'st-completed', cancelled: 'st-cancelled',
  };
  const statusBadge = (status, label) =>
    `<span class="badge ${STATUS_CLASS[status] || ''}">${esc(label || status)}</span>`;

  /** Render a full order (receipt style). Used by order confirmation, lookup and admin. */
  function renderOrder(o, { showContact = true } = {}) {
    const rows = o.items.map((i) => `
      <tr>
        <td>${esc(i.item_name)}</td>
        <td class="num">${money(i.unit_price)}</td>
        <td class="num">${i.quantity}</td>
        <td class="num">${money(i.subtotal)}</td>
      </tr>`).join('');
    const qty = o.items.reduce((s, i) => s + i.quantity, 0);
    return `
      <div class="receipt">
        <div class="receipt-head">
          <div>
            <div class="muted small">訂單編號</div>
            <div class="order-no">${esc(o.order_no)}</div>
          </div>
          ${statusBadge(o.status, o.status_label)}
        </div>
        <dl class="kv">
          ${o.store_name ? `<dt>商家</dt><dd>${esc(o.store_name)}</dd>` : ''}
          <dt>訂購人</dt><dd>${esc(o.customer_name)}</dd>
          ${showContact && o.customer_phone ? `<dt>電話</dt><dd>${esc(o.customer_phone)}</dd>` : ''}
          ${o.order_type_label ? `<dt>用餐方式</dt><dd>${esc(o.order_type_label)}</dd>` : ''}
          ${o.pickup_time ? `<dt>取餐時間</dt><dd>${esc(o.pickup_time)}</dd>` : ''}
          <dt>下單時間</dt><dd>${esc(o.created_at)}</dd>
          ${o.note ? `<dt>備註</dt><dd>${esc(o.note)}</dd>` : ''}
        </dl>
        <table class="table receipt-table">
          <thead><tr><th>餐點</th><th class="num">單價</th><th class="num">數量</th><th class="num">小計</th></tr></thead>
          <tbody>${rows}</tbody>
          <tfoot>
            <tr><td colspan="2">共 ${qty} 份</td><td class="num">總計</td><td class="num total">${money(o.total)}</td></tr>
          </tfoot>
        </table>
      </div>`;
  }

  window.App = { api, money, esc, toast, statusBadge, renderOrder };
})();
