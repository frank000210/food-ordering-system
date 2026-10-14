(function () {
  'use strict';
  const { api, money, esc, toast } = window.App;
  const MAX_QTY = 99;
  const CART_KEY = 'cart_v1';

  let items = new Map();   // id -> menu item
  let cart = new Map();    // id -> qty
  let storeOpen = true;

  const $ = (id) => document.getElementById(id);

  function loadCart() {
    try {
      const saved = JSON.parse(sessionStorage.getItem(CART_KEY) || '{}');
      for (const [id, qty] of Object.entries(saved)) {
        if (items.has(Number(id)) && qty > 0) cart.set(Number(id), Math.min(qty, MAX_QTY));
      }
    } catch { /* ignore */ }
  }
  function saveCart() {
    try { sessionStorage.setItem(CART_KEY, JSON.stringify(Object.fromEntries(cart))); } catch { /* ignore */ }
  }

  function setQty(id, qty) {
    qty = Math.max(0, Math.min(MAX_QTY, Math.floor(Number(qty) || 0)));
    if (qty === 0) cart.delete(id); else cart.set(id, qty);
    saveCart();
    renderCart();
    renderDishState(id);
  }

  function stepper(id, qty, cls = '') {
    return `<div class="stepper ${cls}" data-id="${id}">
      <button type="button" data-act="dec" aria-label="減少">−</button>
      <input type="number" inputmode="numeric" min="0" max="${MAX_QTY}" value="${qty}" aria-label="數量">
      <button type="button" data-act="inc" aria-label="增加" ${qty >= MAX_QTY ? 'disabled' : ''}>+</button>
    </div>`;
  }

  function dishControl(id) {
    const qty = cart.get(id) || 0;
    if (!storeOpen) return '';
    return qty > 0 ? stepper(id, qty)
      : `<button type="button" class="btn btn-primary add-btn" data-add="${id}">加入</button>`;
  }

  function renderDishState(id) {
    const el = document.querySelector(`.dish[data-id="${id}"]`);
    if (!el) return;
    el.classList.toggle('in-cart', cart.has(id));
    el.querySelector('.dish-ctrl').innerHTML = dishControl(id);
  }

  function renderStore(s) {
    document.title = `${s.store_name}｜線上點餐`;
    document.querySelectorAll('[data-store-name]').forEach((el) => { el.textContent = s.store_name; });
    $('storeDesc').textContent = s.store_description || '';
    $('storeHours').textContent = s.business_hours ? `營業時間：${s.business_hours}` : '';
    $('storePhone').textContent = s.store_phone ? `電話：${s.store_phone}` : '';
    $('storeAddress').textContent = s.store_address ? `地址：${s.store_address}` : '';
    const pill = $('openPill');
    pill.textContent = s.is_open ? '接單中' : '暫停接單';
    pill.className = `open-pill ${s.is_open ? 'on' : 'off'}`;
    if (s.announcement) { $('announcement').textContent = s.announcement; $('announcement').classList.remove('hidden'); }
  }

  function renderMenu(categories) {
    if (!categories.length) {
      $('menu').innerHTML = '<p class="empty">目前沒有可供應的餐點</p>';
      return;
    }
    $('catTabs').innerHTML = categories.map((c, i) => `<a href="#cat-${i}">${esc(c.name)}</a>`).join('');
    $('menu').innerHTML = categories.map((c, i) => `
      <section class="menu-section" id="cat-${i}">
        <h2>${esc(c.name)}</h2>
        <div class="menu-grid">
          ${c.items.map((m) => `
            <article class="dish ${cart.has(m.id) ? 'in-cart' : ''}" data-id="${m.id}">
              ${m.image_url ? `<div class="dish-img" style="background-image:url('${esc(m.image_url)}')" role="img" aria-label="${esc(m.name)}"></div>` : ''}
              <div class="dish-body">
                <div class="dish-name">${esc(m.name)}</div>
                <div class="dish-desc">${esc(m.description)}</div>
                <div class="dish-foot">
                  <span class="dish-price">${money(m.price)}</span>
                  <span class="dish-ctrl">${dishControl(m.id)}</span>
                </div>
              </div>
            </article>`).join('')}
        </div>
      </section>`).join('');
  }

  function renderCart() {
    let total = 0;
    let count = 0;
    const lines = [];
    for (const [id, qty] of cart) {
      const m = items.get(id);
      if (!m) continue;
      const sub = m.price * qty;
      total += sub;
      count += qty;
      lines.push(`<li class="cart-line">
        <span class="name">${esc(m.name)}</span>
        <span class="sub">${money(sub)}</span>
        <span class="calc">單價 ${money(m.price)} × ${qty}</span>
        <span></span>
        <div class="ctrl">${stepper(id, qty)}<button type="button" class="link-btn" data-remove="${id}">移除</button></div>
      </li>`);
    }
    $('cartLines').innerHTML = lines.length ? lines.join('') : '<li class="cart-empty">尚未選擇餐點</li>';
    $('cartTotal').textContent = money(total);
    $('cartBarTotal').textContent = money(total);
    $('cartBarCount').textContent = count;
    $('submitBtn').disabled = !storeOpen || count === 0;
    $('submitBtn').textContent = storeOpen ? `送出訂單（${money(total)}）` : '店家暫停接單';
    $('clearCart').classList.toggle('hidden', count === 0);
  }

  // Event delegation for steppers and add/remove buttons anywhere on the page.
  document.addEventListener('click', (e) => {
    const add = e.target.closest('[data-add]');
    if (add) { setQty(Number(add.dataset.add), 1); return; }
    const rm = e.target.closest('[data-remove]');
    if (rm) { setQty(Number(rm.dataset.remove), 0); return; }
    const btn = e.target.closest('.stepper button');
    if (btn) {
      const id = Number(btn.closest('.stepper').dataset.id);
      const cur = cart.get(id) || 0;
      setQty(id, btn.dataset.act === 'inc' ? cur + 1 : cur - 1);
    }
  });
  document.addEventListener('change', (e) => {
    const input = e.target.closest('.stepper input');
    if (input) setQty(Number(input.closest('.stepper').dataset.id), input.value);
  });

  $('clearCart').addEventListener('click', () => {
    const ids = [...cart.keys()];
    cart.clear(); saveCart(); renderCart(); ids.forEach(renderDishState);
  });

  // Mobile bottom sheet
  let backdrop = null;
  function toggleSheet(open) {
    $('cart').classList.toggle('open', open);
    if (open && !backdrop) {
      backdrop = document.createElement('div');
      backdrop.className = 'backdrop';
      backdrop.addEventListener('click', () => toggleSheet(false));
      document.body.appendChild(backdrop);
    } else if (!open && backdrop) { backdrop.remove(); backdrop = null; }
  }
  $('openCart').addEventListener('click', () => toggleSheet(true));
  $('closeCart').addEventListener('click', () => toggleSheet(false));

  $('orderForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const name = form.customer_name.value.trim();
    if (!name) { toast('請輸入顧客名稱', 'error'); form.customer_name.focus(); return; }
    if (cart.size === 0) { toast('請至少選擇一項餐點', 'error'); return; }
    const btn = $('submitBtn');
    btn.disabled = true;
    btn.textContent = '送出中…';
    try {
      const order = await api('/api/orders', {
        method: 'POST',
        body: {
          customer_name: name,
          customer_phone: form.customer_phone.value.trim(),
          order_type: form.order_type.value,
          pickup_time: form.pickup_time.value.trim(),
          note: form.note.value.trim(),
          items: [...cart].map(([menu_item_id, quantity]) => ({ menu_item_id, quantity })),
        },
      });
      try { sessionStorage.setItem('last_order', JSON.stringify(order)); } catch { /* ignore */ }
      cart.clear(); saveCart();
      location.href = `/order?no=${encodeURIComponent(order.order_no)}&t=${encodeURIComponent(order.access_token)}`;
    } catch (err) {
      toast(err.message, 'error');
      renderCart();
    }
  });

  (async function init() {
    try {
      const data = await api('/api/menu');
      storeOpen = data.store.is_open;
      renderStore(data.store);
      if (data.admin_url) $('adminLink').href = data.admin_url;
      for (const c of data.categories) for (const m of c.items) items.set(m.id, m);
      loadCart();
      renderMenu(data.categories);
      renderCart();
    } catch (err) {
      $('menu').innerHTML = `<p class="empty">菜單載入失敗：${esc(err.message)}</p>`;
    }
  })();
})();
