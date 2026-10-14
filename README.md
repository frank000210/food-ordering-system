# 線上訂餐系統（Food Ordering System）

一套**多商家**線上訂餐網站：顧客先選商家再點餐，後台可管理多家商家、各自的菜單、訂單與銷售日報。
以 Node.js 內建 `node:http` 開發，資料存在 **MongoDB**，唯一的執行期相依套件是官方 `mongodb` driver。

![點餐頁](docs/screenshots/order-page.png)

## 功能

### 前台（顧客）

| 頁面 | 網址 | 說明 |
|---|---|---|
| 選擇商家 | `/` | 列出所有啟用中的商家（營業狀態、營業時間、地址、公告） |
| 商家點餐頁 | `/store?id=…` | 該商家的資訊與菜單；依分類瀏覽餐點，加入購物車並調整數量；購物車即時顯示**單價、各品項小計與總價**；輸入顧客名稱（必填）與備註後送出。**每張訂單只能有同一家商家的餐點**（購物車依商家分開保存） |
| 訂單成立 | `/order?no=…&t=…` | 商家、訂單編號、狀態、訂購人、下單時間、備註、每項餐點的單價／數量／小計、總計，可列印；網址含專屬存取碼，可加入書籤 |
| 訂單查詢 | `/track` | 以「訂單編號 + 訂購人姓名」查詢訂單目前處理狀態 |

### 後台 — `/admin/`

左側選單可切換「目前商家」；總覽、訂單管理、銷售日報可選「全部商家」或單一商家，餐點設定一次編輯一家商家。

| 頁面 | 說明 |
|---|---|
| 總覽 | 今日訂單數、營收、平均客單價、待處理訂單數、最新訂單、今日熱銷；選定商家時可一鍵開／關線上接單；每 30 秒自動更新 |
| 訂單管理 | 依商家、日期、狀態、關鍵字（編號／姓名）篩選；查看訂單明細；依流程更新狀態：待確認 → 已接單 → 製作中 → 可取餐 → 已完成，或取消；**「已完成」「已取消」的訂單可單筆或勾選批次刪除** |
| 餐點設定 | 目前商家的餐點與分類：新增／編輯／刪除（名稱、價格、分類、說明、圖片網址、排序），一鍵切換供應中／停售 |
| 銷售日報 | 選擇日期，呈現**各餐點銷售數、各餐點營收、營收占比、總營收**，全部商家時另列各商家營收；時段分布、訂單狀態統計；可匯出 CSV 或列印 |
| 商家管理 | 新增／編輯商家（名稱、電話、地址、營業時間、介紹、公告、排序），開關線上接單、啟用／停用；沒有訂單的商家可刪除 |

<p>
  <img src="docs/screenshots/order-confirmed.png" width="49%" alt="訂單成立">
  <img src="docs/screenshots/sales-report.png" width="49%" alt="銷售日報">
</p>

## 快速開始

需求：**Node.js 22 以上**、一個 MongoDB（本機、Docker 或雲端皆可）。

```bash
git clone https://github.com/frank000210/food-ordering-system.git
cd food-ordering-system
npm install
cp .env.example .env   # 填入 MONGODB_URI 與 ADMIN_PASSWORD
npm run dev
```

- 前台：http://localhost:3000
- 後台：http://localhost:3000/admin/ （帳號 `ADMIN`、密碼 `ADMIN_PASSWORD`）

第一次連上空資料庫時會自動建立索引，並放入兩家示範商家與菜單（好食光便當、小林茶飲）。
從單一商家版（v2.0）升級時，既有的商家設定、菜單與訂單會自動移轉為「商家 #1」。

## 環境變數

| 變數 | 預設值 | 說明 |
|---|---|---|
| `MONGODB_URI` | （必填） | MongoDB 連線字串 |
| `MONGODB_DB` | `food_ordering` | 資料庫名稱 |
| `ADMIN` / `ADMIN_PASSWORD` | `admin` / （必填） | 後台帳號密碼。**每次登入都直接比對環境變數**，不存資料庫；未設定密碼時後台無法登入。改帳號後舊的登入工作階段自動失效 |
| `ADMIN_AUTH_DISABLED` | `0` | **僅限測試期間**：設為 `1` 時後台不需登入即可使用。正式營運前務必移除 |
| `PORT` | `3000` | 服務埠號 |
| `STOREFRONT_URL` | — | 顧客點餐網址，例如 `https://food-ordering.zeabur.app` |
| `ADMIN_URL` | — | 店家後台網址，例如 `https://food-ordering-admin.zeabur.app`。設定後**前台網域看不到後台**（`/admin`、`/api/admin` 回 404），後台網域的 `/` 導向 `/admin/` |
| `STORE_TIMEZONE` | `Asia/Taipei` | 訂單日期與日報使用的時區 |
| `SEED_DEMO` | `1` | 設為 `0` 則不建立示範菜單 |
| `COOKIE_SECURE` | `0` | 透過 HTTPS 提供服務時設為 `1`（Cookie 加 Secure、送 HSTS） |
| `TRUST_PROXY` | `0` | 放在反向代理（如 Zeabur）後面時設為 `1`，登入限流才會依真實用戶 IP 計算 |

## 部署到 Zeabur

1. 以 GitHub 連結此 repo，Zeabur 會使用根目錄的 `Dockerfile` 建置。
2. 設定上表的環境變數（至少 `MONGODB_URI`、`ADMIN_PASSWORD`、`COOKIE_SECURE=1`、`TRUST_PROXY=1`）。
3. 在同一個服務綁兩個網域：一個給顧客（填入 `STOREFRONT_URL`），一個給店家（填入 `ADMIN_URL`）。

## 設計重點

- **價格以伺服器為準**：下單時只送餐點 ID 與數量，單價、小計、總價都由後端依資料庫計算，前端無法竄改金額。
- **訂單明細保存快照**：訂單會記下當下的餐點名稱與單價，之後改價或刪除餐點都不會影響歷史訂單與報表。
- **銷售日報排除取消訂單**；同一天若調整過價格，同一餐點會依不同單價分列。
- **訂單編號**為「日期-當日流水號」，例如 `20261014-0001`，以 MongoDB 原子計數器產生，同時下單也不會重號。
- **安全性**：後台帳密來自環境變數、以固定時間比對；session 存在 MongoDB（TTL 自動過期），使用 HttpOnly + SameSite Cookie；寫入類 API 只接受 JSON（阻擋跨站表單送出）；登入失敗 5 次鎖 15 分鐘；只憑電話查不到他人訂單；CSV 匯出防公式注入；所有輸出皆經 HTML 跳脫。
- 介面支援手機版（底部購物車面板）與列印。

## 專案結構

```
src/
  server.js     啟動 HTTP 服務
  app.js        API 路由（前台、後台）
  router.js     輕量路由器（路徑參數、JSON、靜態檔案）
  services.js   訂單、菜單、報表等商業邏輯
  db.js         MongoDB 連線、索引、計數器、初始資料
  auth.js       環境變數帳密、session、登入限流
  time.js       店家時區的日期時間
public/
  index.html    選擇商家
  store.html    商家點餐頁
  order.html    訂單成立頁
  track.html    訂單查詢
  assets/       共用樣式與前台程式
  admin/        後台頁面（總覽、訂單、餐點、日報、商家管理、登入）
test/
  api.test.js   API 自動化測試
```

## API 一覽

前台（不需登入）

| 方法 | 路徑 | 說明 |
|---|---|---|
| GET | `/api/stores` | 啟用中的商家列表 |
| GET | `/api/stores/:id/menu` | 單一商家資訊與可供應的菜單 |
| POST | `/api/orders` | 建立訂單 `{ store_id, customer_name, note, items: [{ menu_item_id, quantity }] }`；餐點必須都屬於 `store_id` |
| GET | `/api/orders/view` | `?no=&t=` 訂單成立頁（訂單編號 + 下單時回傳的 `access_token`） |
| GET | `/api/orders/lookup` | `?order_no=&contact=`（contact = 訂購人姓名） |

後台（需登入，路徑前綴 `/api/admin`；`store_id` 為選填者省略即代表全部商家）

| 方法 | 路徑 | 說明 |
|---|---|---|
| POST | `/login`、`/logout` | 登入、登出 |
| GET | `/dashboard?store_id=` | 今日總覽 |
| GET / POST / PUT / DELETE | `/stores`、`/stores/:id` | 商家；PUT 可只送要改的欄位，有訂單的商家不能刪除 |
| GET / POST / PUT / DELETE | `/categories?store_id=`、`/categories/:id` | 分類（新增時 body 帶 `store_id`） |
| GET / POST / PUT / DELETE | `/items?store_id=`、`/items/:id` | 餐點（新增時 body 帶 `store_id`）；`PATCH /items/:id/availability` 切換供應 |
| GET | `/orders?store_id=&date=&status=&q=`、`/orders/:id` | 訂單列表與明細 |
| PATCH | `/orders/:id/status` | 更新訂單狀態 |
| DELETE | `/orders/:id` | 刪除單筆訂單（僅限已完成／已取消） |
| POST | `/orders/delete` | 批次刪除 `{ ids: [...] }`，非已完成／已取消者略過 |
| GET | `/reports/daily?date=&store_id=`、`/reports/daily.csv?date=&store_id=` | 銷售日報、CSV 匯出 |

## 測試

```bash
npm test
```

測試使用 `mongodb-memory-server` 啟動暫時的記憶體 MongoDB，不會碰到正式資料庫（第一次執行會下載 mongod 執行檔）。
涵蓋：多商家菜單、下單金額計算、同一訂單限同一商家、輸入驗證、CSRF 防護、訂單成立頁存取碼、訂單查詢驗證、環境變數帳密與測試免登入、商家管理、餐點依商家隔離、停售與暫停接單、訂單狀態流程與刪除、各商家／全部商家日報、CSV 匯出與公式注入、前後台網域分流、單一商家資料移轉、靜態頁面與路徑穿越防護。

## 授權

MIT
