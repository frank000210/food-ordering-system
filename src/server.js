'use strict';
const http = require('node:http');
const { openDatabase } = require('./db');
const { createApp } = require('./app');

const PORT = Number(process.env.PORT) || 3000;
const db = openDatabase();
const app = createApp(db);

http.createServer(app.handle).listen(PORT, () => {
  console.log(`訂餐系統已啟動：http://localhost:${PORT}`);
  console.log(`後台管理：http://localhost:${PORT}/admin/`);
});
