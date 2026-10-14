'use strict';
const http = require('node:http');
const { openDatabase } = require('./db');
const { createApp } = require('./app');

const PORT = Number(process.env.PORT) || 3000;

(async () => {
  const { client, db } = await openDatabase();
  const app = createApp(db);
  const server = http.createServer(app.handle).listen(PORT, () => {
    console.log(`訂餐系統已啟動：http://localhost:${PORT}`);
    console.log(`後台管理：${process.env.ADMIN_URL || `http://localhost:${PORT}`}/admin/`);
  });

  const shutdown = () => {
    server.close(() => client.close().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
})().catch((err) => {
  console.error('啟動失敗：', err.message);
  process.exit(1);
});
