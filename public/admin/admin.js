/* Admin layout: auth guard + sidebar navigation. Each admin page sets data-page on <body>. */
(function () {
  'use strict';
  const { api, esc } = window.App;

  const NAV = [
    ['dashboard', '/admin/', '總覽'],
    ['orders', '/admin/orders', '訂單管理'],
    ['menu', '/admin/menu', '餐點設定'],
    ['report', '/admin/report', '銷售日報'],
    ['store', '/admin/store', '商家設定'],
  ];

  async function boot() {
    let me;
    try {
      me = await api('/api/admin/me');
    } catch (err) {
      if (err.status === 401) { location.href = '/admin/login?next=' + encodeURIComponent(location.pathname); return null; }
      throw err;
    }
    let store = {};
    try { store = await api('/api/admin/store'); } catch { /* ignore */ }

    const page = document.body.dataset.page;
    const sidebar = document.createElement('nav');
    sidebar.className = 'sidebar';
    sidebar.innerHTML = `
      <a class="brand" href="/admin/">${esc(store.store_name || '訂餐系統')}</a>
      <div class="sub">後台管理</div>
      ${NAV.map(([key, href, label]) => `<a class="nav ${key === page ? 'active' : ''}" href="${href}">
        <span>${label}</span>${key === 'orders' ? '<span class="count hidden" id="pendingCount"></span>' : ''}</a>`).join('')}
      <div class="spacer"></div>
      <a class="nav" href="${esc(me.storefront_url || '/')}" target="_blank" rel="noopener">前台點餐頁 ↗</a>
      <div class="who">${me.auth_disabled ? '測試模式：後台未啟用登入' : '登入身分：' + esc(me.username)}</div>
      ${me.auth_disabled ? '' : '<a class="nav" href="#" id="logoutBtn">登出</a>'}`;
    const shell = document.querySelector('.admin-shell');
    shell.prepend(sidebar);

    const toggle = document.querySelector('.menu-toggle');
    if (toggle) toggle.addEventListener('click', () => sidebar.classList.toggle('open'));

    document.getElementById('logoutBtn')?.addEventListener('click', async (e) => {
      e.preventDefault();
      await api('/api/admin/logout', { method: 'POST', body: {} }).catch(() => {});
      location.href = '/admin/login';
    });

    refreshPendingCount();
    return { me, store };
  }

  async function refreshPendingCount() {
    try {
      const list = await api('/api/admin/orders?status=pending');
      const el = document.getElementById('pendingCount');
      if (!el) return;
      el.textContent = list.length;
      el.classList.toggle('hidden', list.length === 0);
    } catch { /* ignore */ }
  }

  window.Admin = { boot, refreshPendingCount };
})();
