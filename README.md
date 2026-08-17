# ERP System

*[English](README.en.md)*

Node.js + MySQL + Vue 3 開發環境。本專案的 `server/` 是一個自製的 CRUD backend 框架，`client/` 是對應的 Vue 3 前端。

本文件分為五個部分：

1. [框架理念](#一框架理念)
2. [安裝與啟動](#二安裝與啟動)
3. [開發指引：Handler、Job、Service](#三開發指引handlerjobservice)
4. [系統自帶 Service 簡介](#四系統自帶-service-簡介)
5. [應用配置詳細說明](#五應用配置詳細說明)

---

## 一、框架理念

這是一個 **CRUD backend 框架**：目標是讓開發者只需要專注在三種業務程式碼——

- **Handler**：一個 API endpoint 的實作（收請求、做業務邏輯、回結果）
- **Job**：背景定時任務（清理、刷新快取、發送排程通知……）
- **Service**：可被 Handler、Job 或其他 Service 注入使用的共用邏輯（存取資料庫、呼叫外部系統、封裝業務規則……）

至於一個後端系統「應該有」但跟業務邏輯本身無關的東西——身份認證、授權、輸入輸出驗證、限流、日誌、Idempotency、檔案上傳下載、優雅關機、設定驗證——框架已經用內建的原生功能或內建 Service 處理好了，不需要每個專案重新發明一次。

框架的核心設計原則：

- **只有兩種自動發現機制**：`server/src/handlers/` 底下的 Handler、`server/src/services/` 底下的 Service（含放在 Service 目錄底下 `jobs/` 子目錄的 Job）。新增一個檔案並宣告好 `static` metadata，框架啟動時就會自動找到並註冊，**不需要修改任何中央 registry、router 或 factory**。
- **依賴宣告是強制的，不是參考用的**。Service 透過 `static service.dependencies` 宣告它要用的其他 Service，Service Container 依照宣告的依賴圖決定初始化順序、關機順序，並在啟動時就擋下循環依賴、缺少依賴等問題——而不是等到執行期才炸開。
- **設定驗證在啟動時完成，而不是執行期才發現**。所有全域設定（application、api、database、jwt、logging、security、request 生命週期）在應用程式建立時一次驗證，錯誤的設定會讓應用程式直接無法啟動，不會帶著壞掉的設定繼續跑。
- **安全預設值優先**：API 預設要求 JWT 身份認證與 `authenticated` 授權策略；上傳、下載、Idempotency 都預設關閉，需要的 API 明確 opt-in；`JWT_SECRET` 沒有內建預設值,未設定就拒絕啟動。

換句話說：新增一支 API，通常只需要新增一個 Handler 檔案；新增一個背景任務，通常只需要在既有或新建的 Service 上宣告 `static jobs`；新增一段可重用邏輯，通常只需要新增一個 Service 檔案。框架負責把它們發現、注入、驗證、記錄、優雅關機。

---

## 二、安裝與啟動

### 需求

- Node.js 26+
- npm 10+
- MySQL 5.7+

### Step 1：安裝依賴

```bash
npm install
```

這是一個 npm workspaces 專案，`npm install` 會一次安裝 `client/` 與 `server/` 兩個 workspace 的依賴。

### Step 2：建立環境變數檔

```bash
cp server/.env.example server/.env
cp client/.env.example client/.env
```

`server/.env` 至少要確認／填入：

- `JWT_SECRET`：**必填，沒有預設值**，應用程式沒有這個值會直接拒絕啟動。用以下指令產生一組：

  ```bash
  openssl rand -base64 48
  ```

- `APP_TIME_ZONE`：全系統唯一的時區來源，預設 `Asia/Hong_Kong`。所有 API 回應的 timestamp、log 檔案日期、request context 都會用這個時區，只需要設定一次。
- 其餘欄位（`DB_HOST`、`DB_USER`……）如果照 Step 3 用 `init.sql` 建立本機資料庫，保留預設值即可。

### Step 3：準備 MySQL

**Option A，本機 MySQL：**

```bash
mysql -h 127.0.0.1 -P 3306 -u root -p < server/database/init.sql
```

`init.sql` 用 root/管理員帳號建立資料庫與應用程式帳號，只需要執行一次，會建立：

- 資料庫：`erp_dev`
- 應用程式帳號：`erp_user` / `erp_password`

如果 MySQL 是走本機 socket 連線，把上面指令的 `-h 127.0.0.1 -P 3306` 拿掉，並在 `server/.env` 設定 `DB_SOCKET_PATH`。

**接著，套用框架自己的資料表**（用 `server/.env` 裡的應用程式帳號執行）：

```bash
cd server && npm run migrate
```

這會依序執行 `database/framework/`（框架自帶資料表，全部以 `fr_` 前綴命名，避免跟業務資料表混淆）以及 `database/migrations/` 底下所有尚未套用過的檔案，並把已套用紀錄寫入 `fr_schema_migrations`。`git pull` 之後重新執行是安全的——已套用的檔案會被跳過，只會執行新增的檔案。少了任何一張必要的表，伺服器啟動時會直接指出缺哪個檔案。

### Step 4：啟動開發伺服器

```bash
npm run dev
```

同時啟動 API 伺服器（`server/`，`nodemon` 監控變更自動重啟）與 Vue 前端（`client/`，Vite）。也可以分開啟動：

```bash
npm run dev:server
npm run dev:client
```

### 驗證安裝成功

- Vue 前端：`http://localhost:5173`
- API 健康檢查：`http://localhost:3000/api/v1/health`

呼叫健康檢查應該回傳 `database: connected`；如果是 `unknown` 或連不上，代表 MySQL 服務尚未啟動或 `server/.env` 的資料庫設定不對，見 [MySQL 補充](#mysql-補充)。

### 驗證程式碼品質

```bash
npm run verify
```

依序執行 CI 用的三道關卡：ESLint（`npm run lint`）、測試 + 覆蓋率（`npm run test:coverage`，全域門檻 89% 行 / 76% 分支 / 86% 函式，另有高風險檔案的個別門檻）、依賴安全稽核（`npm run security:audit`，`npm audit --audit-level=high`）。`npm run lint:fix` 套用可自動修正的部分；`npm test` 跑測試但不檢查覆蓋率門檻，適合開發時的快速迴圈。

### MySQL 補充

本機若安裝的是 `/usr/local/mysql`，但服務沒有在安裝過程中成功啟動，可以開啟 MySQL 偏好設定面板，或檢查 `/usr/local/mysql/data/*.err`。用 Homebrew 安裝的 MySQL 也可以搭配同一組 `.env` 設定使用。

---

## 三、開發指引：Handler、Job、Service

### 開發一個 Handler（新增一支 API）

新增一支業務 API，只需要在 `server/src/handlers/` 底下新增**一個檔案**，不需要改任何中央 API 設定、registry、factory 或 router：

```js
// server/src/handlers/CreateOrderHandler.js
import { BaseRequestHandler } from "../framework/api/BaseRequestHandler.js";

export class CreateOrderHandler extends BaseRequestHandler {
  static handlerName = "createOrder"; // 全域唯一，重複或缺漏會讓啟動失敗

  static api = {
    method: "POST",
    path: "/api/v1/orders",
    description: "Create an order.",
    idempotency: { enabled: true },
    requestSchema: {
      body: {
        type: "object",
        required: ["customerId"],
        additionalProperties: false,
        properties: { customerId: { type: "integer", minimum: 1 } }
      }
    },
    responseSchema: {
      201: {
        type: "object",
        required: ["orderId"],
        additionalProperties: false,
        properties: { orderId: { type: "integer" } }
      }
    }
  };

  async execute(req) {
    const { customerId } = req.input.body;

    const orderId = await this.mysqlDatabase.withTransaction(async (transaction) => {
      const [result] = await transaction.execute(
        "INSERT INTO orders (customer_id) VALUES (?)",
        [customerId]
      );
      return result.insertId;
    });

    return this.response({ orderId }, { statusCode: 201 });
  }
}
```

重點：

- `static handlerName`、`static api` 是唯一必要的宣告；`static api` 必填欄位是 `method`、`path`、`description`、`requestSchema`、`responseSchema`。其餘（`authType`、`authorizationPolicies`、`idempotency`、`upload`、`download`、`timeoutMs`、`deprecation`……）沒指定就沿用 `server/config/api.js` 的 `defaults`。
- Handler **不需要自己寫 constructor**；`this.mysqlDatabase`、`this.logger`（system logger）、`this.context`、`this.services`、`this.time` 等由框架的 Service Container 自動注入。需要其他 Service 時用 `this.services.require("serviceName")`。
- `execute(req)` 內用 `req.input.{params,query,body,headers}` 讀取**已通過驗證**的輸入（含 schema 定義的型別轉換與 default 值），**不要**直接讀 `req.body`／`req.query`。
- 必須 `return this.response(data, { statusCode })` 或 `this.file(...)`（下載路由）回傳結果，禁止直接呼叫 `res.json()`／`res.send()` 等方法——那樣會繞過統一的 response 信封與 Schema 驗證，框架會直接擋下並丟錯。
- 所有預期會發生的失敗都 `throw new ApplicationError(...)`，由全域錯誤處理統一轉換成標準錯誤格式。
- `static api.path` 用 Express 5 的路由語法：具名參數 `/:id` 不變，可選段落寫成 `{/:id}`，萬用字元要命名，例如 `*splat`；舊的 `:id?` 與裸的 `*` 會在啟動驗證時直接被拒絕。

需要檔案上傳／下載、自訂身份認證方式、或授權策略的細節，可參考 handler 目錄裡既有的 `healthHandler.js` 範例，以及框架原始碼裡 `framework/upload/`、`framework/auth/`、`framework/authorization/` 的實作。

### 開發一個 Service（新增可重用邏輯）

Service 放在 `server/src/services/` 底下任意子目錄，同樣是自動發現，不需要註冊：

```js
// server/src/services/user/UserService.js
import { BaseService } from "../../framework/services/BaseService.js";

export class UserService extends BaseService {
  static service = {
    name: "user",              // 全域唯一，Handler／其他 Service 用這個名字 require
    lifecycle: "singleton",    // singleton｜request｜transient
    dependencies: ["mysqldatabase", "logging", "context"]
  };

  constructor({ config, services, options }) {
    super({ config, services, options });
    this.mysqlDatabase = services.require("mysqldatabase");
    this.logger = services.require("logging").logger;
    this.context = services.require("context");
  }

  async initialize() {
    // 選填：非同步啟動邏輯（例如預熱快取）。
  }

  async shutdown() {
    // 選填：優雅關機時的清理邏輯。
  }
}
```

重點：

- `dependencies` 是**強制**的，不是文件用途：Service 只能 `require()` 自己宣告過的依賴，這保證了初始化順序與關機順序（反向）都是根據宣告的依賴圖計算，不會出現「依賴的東西比自己先關掉」這種問題。
- `lifecycle: "singleton"` 的 Service 在啟動時依依賴順序建立一次，所有請求共用；`"request"` 的 Service 用 `await this.services.resolve("serviceName")` 取得，同一個請求內共用、跨請求互相隔離、請求處理完畢後關閉；`"transient"` 每次 resolve 都是新的 instance。
- 需要暫時關掉某個 Service（例如某個環境不需要它，或它依賴的外部系統暫時不可用），在 `static service` 加 `enabled: false` 即可；有其他 Service 仍依賴它的話,啟動會直接失敗並指名是誰依賴了誰。
- Handler 用 `this.services.require("user")` 就能拿到這個 Service。

### 開發一個 Job（新增背景定時任務）

背景任務不是第三種自動發現機制，而是**由提供它的 Service 自己向 Scheduler 註冊**——Service 宣告 `scheduler` 為依賴，並在 `static jobs` 列出要跑的方法：

```js
// server/src/services/report/ReportService.js
export class ReportService extends BaseService {
  static service = {
    name: "report",
    lifecycle: "singleton",
    dependencies: ["scheduler", "mysqldatabase", "logging"],
    eager: true
  };

  static jobs = [
    { name: "report.refreshCache", method: "refreshCache", intervalMs: 60000 },
    { name: "report.monthly", method: "sendMonthly", intervalMs: 3600000, scope: "cluster" }
  ];

  async initialize() {
    this.services.require("scheduler").register(this);
  }

  async refreshCache(signal) { /* ... */ }
  async sendMonthly(signal) { /* ... */ }
}
```

`static jobs` 欄位：

| 欄位 | 說明 |
| --- | --- |
| `name` | 全域唯一，重複會讓啟動失敗 |
| `method` | 同一個 Service 上的方法名稱，啟動時就會檢查是否存在，打錯字不會等到執行期才發現 |
| `intervalMs` | 每次執行間隔 |
| `timeoutMs` | 選填，預設用 `scheduler.defaultTimeoutMs`；是執行時間上限，不是預期時長 |
| `scope` | `"instance"`（預設，每個實例都跑，適合刷新本地快取）或 `"cluster"`（叢集內取得租約的那一個實例才跑，適合有外部副作用的任務） |
| `runOnStart` | 是否啟動時立刻跑一次，不等第一個 interval |

每個 Job 方法都會收到一個 `AbortSignal`，逾時或關機時會被觸發，長時間執行的邏輯應該監察它並中止。

**如果一個 Service 存在的唯一理由就是跑一個排程任務**，慣例上把它放進所屬 Service 的 `jobs/` 子目錄，例如 `services/logging/jobs/LogRetentionJob.js`、`services/idempotency/jobs/IdempotencyPurgeJob.js`。這個目錄仍然在 `src/services` 底下，一樣被既有的 Service 自動發現機制找到，沒有另一套 Job 專用的發現邏輯：

```js
// server/src/services/logging/jobs/LogRetentionJob.js
export class LogRetentionJob extends BaseService {
  static service = {
    name: "job.logRetention",
    lifecycle: "singleton",
    dependencies: ["scheduler", "logging"],
    eager: true
  };

  static jobs = [
    { name: "logging.retentionCleanup", method: "run", intervalMs: 3600000, timeoutMs: 60000 }
  ];

  async initialize() {
    this.services.require("scheduler").register(this);
  }

  async run() {
    await this.services.require("logging").cleanup();
  }
}
```

這樣的寫法本身也是一個普通 Service，可以在其他地方手動呼叫，例如 `services.require("job.logRetention").run()`，不會跟排程器重複實作一次邏輯。專案裡已有的例子：`services/requestLimiter/jobs/RateLimitPurgeJob.js`、`services/tokenRevocation/jobs/TokenRevocationRefreshJob.js`、`services/scheduler/jobs/JobStatsFlushJob.js`、`services/idempotency/jobs/IdempotencyPurgeJob.js`。

部署時要調整某個 Job 的頻率、逾時或直接關掉它，不需要改程式碼，在 `server/config/scheduler.js` 的 `jobs` 底下依名稱覆寫即可（見[第五部分](#scheduler)）。

---

## 四、系統自帶 Service 簡介

以下 Service 由框架內建，會被自動發現與注入，開發業務功能時通常只需要 `this.services.require("...")` 取用，不需要重新實作：

### mysqldatabase — MySQL 資料庫

`server/src/services/mysqldatabase/MySqlDatabaseService.js`，singleton、eager，啟動時建立連線池並執行健康檢查，連線失敗會讓應用程式無法啟動（而不是帶著壞掉的資料庫連線繼續跑）。

```js
const orderId = await this.mysqlDatabase.withTransaction(async (transaction) => {
  const [result] = await transaction.execute(
    "INSERT INTO orders (customer_id) VALUES (?)",
    [customerId]
  );
  return result.insertId;
});
```

提供 `query()`／`execute()`（帶查詢逾時）、`healthCheck()`、`withTransaction()`（支援 MySQL isolation level、逾時、commit/rollback/release、可透過 Request Context 取得目前交易）。交易內的每個查詢會自動繼承交易的逾時 signal，不需要每次手動傳。設定見 `server/config/database.js`。

### jwt / 身份認證

`server/src/services/auth/JwtService.js` 是簽發與驗證 JWT 的 Service；`jwtAuthStrategy.js`、`publicAuthStrategy.js` 是框架內建的兩種身份認證方式（`authType: "jwt"` / `"public"`）。

```js
const token = this.jwt.issue({ sub: user.id, role: user.role }, { subject: String(user.id) });
```

Handler 只需要在 `static api.authType` 指定要用哪種認證方式（預設 `jwt`），其餘由框架處理。要新增自訂認證方式（例如 API Key）——本質上也只是一個普通 Service，宣告 `static authType` 並繼承 `BaseAuthStrategy`,設定見 `server/config/jwt.js`（第五部分有欄位說明）。

### tokenRevocation — JWT 撤銷

`server/src/services/tokenRevocation/TokenRevocationService.js`。撤銷以「版本號」表示：每個使用者一列單調遞增計數器，token 簽發當下的版本比目前版本舊就視為已撤銷。每個實例把整張表快取在記憶體，請求路徑只查記憶體不查資料庫，實際刷新頻率在 `server/config/scheduler.js` 設定，安全 SLA（多久內一定生效）在 `server/config/tokenRevocation.js` 設定，兩者啟動時會交叉檢查一致性。

### context — Request Context

`server/src/services/context/RequestContextService.js`，用 `AsyncLocalStorage` 存放請求範圍內的狀態（request ID、client IP、路由 metadata、身份認證、授權策略、逾時 deadline/signal、目前資料庫交易）。深層的 Service 宣告 `context` 依賴後可以直接 `this.context.get()`，不需要把 `req` 一路往下傳,且跨 `await` 邊界依然有效、並發請求間互相隔離。

### logging — 日誌

`server/src/services/logging/LoggingService.js`，內建兩個 profile：`request`（HTTP 請求/回應日誌，`server/logs/requests-YYYY-MM-DD.log`）與 `system`（後台系統事件日誌，`server/logs/system/system-YYYY-MM-DD.log`）。所有 profile 共用同一個五欄格式（`timestamp`／`level`／`event`／`message`／`context`）,可依需要在 `server/config/logging.js` 新增例如 `audit` 等自訂 profile，框架啟動時會自動為它建立對應的 Logger。

```js
this.services.require("logging").require("audit").info("order.created", "Order created", { orderId });
```

Request／Response body 預設不記錄（`bodyCapture: "none"`），因為業務資料常帶身分證號、薪資等個資,單一路由可在 `static api.logging.bodyCapture: "full"` 明確 opt-in，狀態碼 ≥ `bodyCaptureErrorStatus`（預設 500）則永遠完整記錄以便除錯。詳細規則、欄位與設定見 [第五部分 - logging](#logging)。

### requestLimiter — 請求限流

`server/src/services/requestLimiter/RequestLimiterService.js`。同時限制全域併發請求數（超出放進有界 FIFO 佇列）與單一 client IP 的請求速率（token bucket）。內建 `memory` adapter 只適合單一實例；要在多實例間共用配額,需要自行實作 `RateLimitStore` 介面並注入。設定見 [第五部分 - requestLimiter](#requestlimiter)。

### idempotency — 冪等性

`server/src/services/idempotency/IdempotencyService.js`。路由在 `static api.idempotency.enabled: true` 明確啟用後，客戶端須帶 `Idempotency-Key` header；key 依呼叫者身份與路由 scope，並附帶驗證後輸入的 fingerprint。同一個 key 帶不同輸入回 409,已完成的成功回應會被重播並帶上 `Idempotency-Replayed: true`。預設用 MySQL（`fr_idempotency_keys`）當共用 store，單一實例部署可以改用 `memory` 省一次資料庫往返。設定見 [第五部分 - idempotency](#idempotency)。

### scheduler — 背景排程

`server/src/services/scheduler/SchedulerService.js`。本身不掃描任何目錄,由各 Service 在 `initialize()` 呼叫 `this.services.require("scheduler").register(this)` 主動註冊自己宣告的 `static jobs`（用法見[第三部分](#開發一個-job新增背景定時任務)）。支援 `instance`／`cluster` 兩種 scope,`cluster` 任務透過 `job_leases` 表取得租約，同時只有一個實例執行,失敗會記錄並保留排程繼續跑,不會因為單次失敗而停跑。設定見 [第五部分 - scheduler](#scheduler)。

### time — 系統時間

`server/src/services/time/SystemTimeService.js`，是框架內所有時間戳的唯一來源。`time.timestamp()` 取得帶時區偏移的應用程式時間戳、`time.now()` 取得 `Date`、`time.nowMs()` 用於耗時計算、`time.fileDate()` 取得每日檔名用的日期。時區統一由 `application.timeZone`（見 `server/config/application.js`）控制。

### filetype — 檔案型別驗證

`server/src/services/filetype/FileTypeService.js`。上傳功能用它同時比對「宣告的 MIME 類型、副檔名、檔案內容簽章」三者，任何一項不符即拒絕。內建型別列表見 `builtInFileTypes.js`；新增專案自訂型別，在 `registerCustomTypes()` 內註冊（此方法保留給業務程式碼，不會被框架更新覆蓋）：

```js
import { isOle2Container } from "../../framework/upload/signatureMatchers.js";

registerCustomTypes() {
  this.register("application/vnd.ms-excel", {
    extensions: [".xls"],
    matches: isOle2Container
  });
}
```

上傳／下載功能本身預設關閉，需要在路由的 `static api.upload` / `static api.download` 明確啟用,細節（大小限制、允許型別、落盤權限等）見 `server/config/api.js` 的 `defaults.upload` / `defaults.download`。

---

## 五、應用配置詳細說明

所有全域設定檔位於 `server/config/`，每個檔案只保存純設定資料（部分檔案額外提供動態預設值，如讀取環境變數），不含初始化邏輯,啟動時集中驗證,任何一節設定錯誤都會讓應用程式直接拒絕啟動,並列出所有問題。以下列出每個檔案的重點欄位；完整、逐行的說明（含為什麼要這樣設計）都已寫成註解在對應檔案內，這裡只做速查。

### application.js — 應用程式與請求生命週期

| 欄位 | 環境變數 | 預設值 | 作用 |
| --- | --- | --- | --- |
| `host` | `APP_HOST` | `127.0.0.1` | Express 監聽的主機 |
| `port` | `APP_PORT` | `3000` | Express 監聽的連接埠 |
| `timeZone` | `APP_TIME_ZONE` | `Asia/Hong_Kong` | 全系統唯一時區來源，所有日誌與 API timestamp 都用它 |
| `requestTimeoutMs` | `REQUEST_TIMEOUT_MS` | `30000` | 進入 handler 之後（認證/驗證/執行）的最長處理時間，可被單一 API 的 `static api.timeoutMs` 覆蓋 |
| `requestReceiveTimeoutMs` | `REQUEST_RECEIVE_TIMEOUT_MS` | `120000` | 收完整個請求（header+body）的上限，需 ≥ `requestTimeoutMs` 及每條路由自己的 `timeoutMs` |
| `headersReceiveTimeoutMs` | `HEADERS_RECEIVE_TIMEOUT_MS` | `10000` | 只收 header 的上限 |
| `bodyReceiveTimeoutMs` | `BODY_RECEIVE_TIMEOUT_MS` | `10000` | JSON body 收取上限（框架自帶看門狗，非 Node 內建機制） |
| `connectionsCheckingIntervalMs` | `CONNECTIONS_CHECKING_INTERVAL_MS` | `2000` | 上面兩個 socket 逾時的檢查頻率，是實際生效時間的誤差上界 |
| `shutdownTimeoutMs` | `SHUTDOWN_TIMEOUT_MS` | `30000` | 優雅關機最長等待時間，逾時強制關閉 |
| `maxConnections` | `APP_MAX_CONNECTIONS` | `512` | 行程同時可持有的 HTTP socket 數量上限 |

四個逾時之間有啟動時強制檢查的大小關係（`connectionsCheckingIntervalMs ≤ headersReceiveTimeoutMs ≤ requestReceiveTimeoutMs`，且 `requestReceiveTimeoutMs` 必須蓋過 `requestTimeoutMs` 與每條路由自己的 `timeoutMs`），不符合會直接啟動失敗。

### api.js — API 路由預設值與版本管理

- `defaults`：所有 Handler 沒有在 `static api` 指定時採用的預設值，包含 `authType`（預設 `jwt`）、`authorizationPolicies`（預設 `authenticated`）、`deprecation`、`idempotency`（預設關閉）、`logging.bodyCapture`（預設 `none`）、`upload` / `download`（預設關閉，含大小/數量/型別限制與落盤權限）、`timeoutMs`（`null` 代表沿用 `application.requestTimeoutMs`）。
- `versioning`：`enabled`、`defaultVersion`（`v1`）、`supportedVersions`、`responseHeaderName`（`API-Version`）——控制 `/api/<version>/...` 路徑格式與版本回應標頭。
- `upload`（全域，非個別路由）：`maxConcurrentUploads`（預設 10，全域同時處理中的上傳數）與 `maxUploadMemoryBytes`（預設 256MB，上傳緩衝記憶體上限）；啟動時會檢查 `maxConcurrentUploads × 單路由 maxRequestBytes` 是否超過這個記憶體上限。

### database.js — MySQL 連線與交易

| 欄位 | 環境變數 | 預設值 | 作用 |
| --- | --- | --- | --- |
| `host` / `port` / `user` / `password` / `database` | `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` | `127.0.0.1` / `3306` / `root` / `""` / `erp_dev` | 連線資訊 |
| `socketPath` | `DB_SOCKET_PATH` | 無 | 設定後優先用 Unix socket 連線 |
| `connectionLimit` | — | `10` | 連線池上限 |
| `queueLimit` | `DB_QUEUE_LIMIT` | `200` | 等待連線的請求數上限（**不可設 0**，0 代表不限制，會無上限堆積） |
| `acquireTimeoutMs` | `DB_ACQUIRE_TIMEOUT_MS` | `5000` | 等待連線池分配連線的上限 |
| `queryTimeoutMs` | `DB_QUERY_TIMEOUT_MS` | `10000` | 單次 query/execute 逾時，只算拿到連線之後 |
| `transactionTimeoutMs` | `DB_TRANSACTION_TIMEOUT_MS` | `20000` | 整個交易（含 COMMIT）最長時間 |
| `abandonedConnectionAction` | `DB_ABANDONED_CONNECTION_ACTION` | `destroy` | 查詢逾時後連線怎麼處理：`destroy`（毀掉重建，狀態乾淨）或 `release`（還回池子，但可能帶著上個使用者留下的 session 狀態） |
| `ssl.enabled` | `DB_SSL_ENABLED` | `false` | 是否對 MySQL 連線啟用 TLS，`DB_HOST` 非本機時應設 `true` |
| `ssl.ca` | `DB_SSL_CA` | 無 | CA 憑證 PEM 內容，多行需以 `\n` 轉義 |
| `ssl.rejectUnauthorized` | `DB_SSL_REJECT_UNAUTHORIZED` | `true` | 是否驗證憑證，只有本機自簽測試才該設 `false` |

`acquireTimeoutMs + queryTimeoutMs`（或 `+ transactionTimeoutMs`）必須小於 `application.requestTimeoutMs`，`queueLimit` 不可小於 `requestLimiter.maxConcurrentRequests - connectionLimit`；不符合會在啟動時被擋下。

### jwt.js — JWT 簽發與驗證

| 欄位 | 環境變數 | 預設值 | 作用 |
| --- | --- | --- | --- |
| `secret` | `JWT_SECRET` | **無，必填** | 簽署/驗證金鑰，至少 32 字元，未設定直接啟動失敗 |
| `issuer` | `JWT_ISSUER` | `erp-api` | Token 簽發者，防止接受其他系統簽的 token |
| `audience` | `JWT_AUDIENCE` | `erp-web` | Token 預期使用者 |
| `algorithm` | — | `HS256` | 簽署演算法，驗證時只接受此演算法，防降級攻擊 |
| `expiresIn` | `JWT_EXPIRES_IN` | `2h` | Token 有效期，必須是數字加單位（`s`/`m`/`h`/`d`/`w`），純數字會被當成毫秒 |
| `clockToleranceSeconds` | `JWT_CLOCK_TOLERANCE_SECONDS` | `5` | 驗證 `exp`/`nbf` 容許的時鐘誤差 |
| `headerName` / `authScheme` | — | `authorization` / `Bearer` | Token 所在 header 與認證方案 |

### logging.js — 日誌 profile <a id="logging"></a>

`loggers` 底下可自由新增 profile（框架啟動時自動建立對應 service），內建 `request` 與 `system` 兩個。共用欄位：

| 欄位 | 作用 |
| --- | --- |
| `enabled` | 是否啟用該 profile |
| `directory` / `filePrefix` | 日誌檔案目錄（相對 `server/`）與每日檔名前綴 |
| `retentionDays` / `cleanupIntervalHours` | 保留天數，及過期檢查的最短間隔 |
| `maxFileSizeBytes` | 單一日誌檔上限，超過建立同日流水號檔案 |
| `maxQueuedBytes` / `maxQueuedEntries` | 等待寫入磁碟的日誌上限（位元組/筆數，先到者為準），超過則丟棄並記錄遺失統計 |
| `maxEntryBytes` | 單筆日誌上限，超過從最重欄位（通常是 body）截斷 |
| `fileMode` / `directoryMode` | 檔案／目錄權限，預設 `0o600` / `0o700` |
| `minimumLevel` | 最低記錄級別（`debug`/`info`/`warn`/`error`） |
| `bodyCapture`（僅 `request`） | `none`（預設）或 `full`；可被路由 `static api.logging.bodyCapture` 覆蓋 |
| `bodyCaptureErrorStatus`（僅 `request`） | 狀態碼 ≥ 此值一律完整記錄，預設 `500`，設 `null` 停用 |
| `redactedFields` | 需遮蔽的欄位名稱（大小寫不分） |

Body 記錄規則優先順序：檔案上傳/下載永不記錄 → 狀態碼達到 `bodyCaptureErrorStatus` 一律完整記錄 → 路由自己 opt-in `full` → 否則不記錄。查詢字串一律記錄在 `context.url`（套用 `redactedFields`），因此不要把個資放進 query string。

### security.js — HTTP 安全性

| 欄位 | 環境變數 | 預設值 | 作用 |
| --- | --- | --- | --- |
| `helmetEnabled` | — | `true` | 是否啟用 Helmet 安全標頭（HSTS、frame protection 等） |
| `hidePoweredBy` | — | `true` | 移除 `X-Powered-By` |
| `jsonBodyLimit` | — | `100kb` | JSON body 大小上限，超過回 413 |
| `cors.allowedOrigins` | `CLIENT_URL` | `http://localhost:5173,http://127.0.0.1:5173` | 允許的瀏覽器 Origin（逗號分隔，不可用 `*`） |
| `cors.allowedMethods` / `allowedHeaders` / `exposedHeaders` | — | 見檔案 | CORS 相關標頭清單 |
| `cors.credentials` | — | `false` | 是否允許跨域 cookie |
| `reverseProxy.trustProxy` | `TRUST_PROXY` | `false` | 信任 `X-Forwarded-For` 的方式：`false` 全不信；數字（如 `1`）代表信任最右邊幾跳（僅適用單一入口）；信任來源清單（如 `"loopback, 10.0.0.0/8"`）依 IP/CIDR 判斷，適用多入口；**不可設 `true`**（等於信任整條鏈，客戶端可偽造 `req.ip`） |
| `reverseProxy.enforceHttps` | `ENFORCE_HTTPS` | `false` | 是否強制 HTTPS，需搭配正確的 `trustProxy` 才能安全讀取 `X-Forwarded-Proto` |

正式環境搭配單一信任的 reverse proxy 時的建議值：

```dotenv
CLIENT_URL=https://erp.example.com
TRUST_PROXY=1
ENFORCE_HTTPS=true
```

`TRUST_PROXY` 設錯不會有明顯徵兆，卻會同時影響 IP 限流準確性、未認證路由的 idempotency 隔離、以及日誌中的 `clientIp`，見 `server/config/security.js` 內完整說明。

### request.js — Request/Response Schema 驗證

| 欄位 | 預設值 | 作用 |
| --- | --- | --- |
| `validation.input.enabled` | `true` | 是否驗證 request 輸入 |
| `validation.input.allErrors` | `true` | 一次收集所有輸入錯誤，而非遇錯即停 |
| `validation.input.coerceTypes` | `true` | 依 schema 自動轉型（例如 query string `"10"` → `number`） |
| `validation.input.useDefaults` | `true` | 自動套用 schema 的 `default` 值 |
| `validation.input.removeAdditional` | `false` | 是否自動移除未宣告欄位 |
| `validation.input.maxErrors` | `20` | 單次驗證最多回報的錯誤數 |
| `validation.output.enabled` / `validateInProduction` | `true` / `true` | 是否驗證 response 輸出，及是否在正式環境也驗證 |

系統層請求限流（併發數、佇列、IP 速率）獨立於 `requestLimiter.js`（見下）。

### requestLimiter.js — 請求限流 <a id="requestlimiter"></a>

| 欄位 | 預設值 | 作用 |
| --- | --- | --- |
| `storeAdapter` | `memory` | 限流狀態儲存；`memory` 為單一實例各自計算，跨實例精確配額需自行實作 `RateLimitStore` 並注入 |
| `apiPathPrefix` | `/api` | 只對此前綴的請求限流 |
| `maxConcurrentRequests` | `100` | 單一實例同時可執行的請求數 |
| `maxQueueSize` / `queueTimeoutMs` | `200` / `30000` | 併發滿載時的排隊上限與最長等待時間 |
| `maxRequestsPerIpPerWindow` / `ipWindowMs` | `20` / `1000` | Token bucket 容量與回填週期（穩態速率 = 前者/後者，預設每秒 20 個，持續回填而非整窗釋放） |
| `retryAfterSeconds` | `1` | 被限流時建議的 `Retry-After` |
| `maxTrackedKeys` | `100000` | 記憶體 store 同時追蹤的來源數上限，防止偽造來源撐爆記憶體 |
| `ipv6PrefixLength` | `64` | IPv6 聚合到此前綴長度計算配額（同一 `/64` 視為同一客戶） |
| `abandonGraceMs` / `maxAbandonedRequests` | `1000` / `100` | 請求逾時放棄後，容許 handler 多久才視為洩漏；累積洩漏數達到此值即回 503 |
| `storeOperationTimeoutMs` / `storeFailureMode` | `500` / `closed` | 外部 store 操作逾時上限，及逾時後 `closed`（拒絕新請求）或 `open`（放行 IP 檢查） |

被限流一律回 HTTP 429；內部日誌仍保留實際原因（IP 限流、佇列滿、佇列逾時等）。

### scheduler.js — 背景排程 <a id="scheduler"></a>

| 欄位 | 預設值 | 作用 |
| --- | --- | --- |
| `enabled` | `true` | 停用後不註冊/執行任何 Job，但啟動日誌仍會列出被略過的清單 |
| `defaultTimeoutMs` | `30000` | Job 沒指定 `timeoutMs` 時的預設執行上限 |
| `clusterLeaseGraceMs` | `30000` | `cluster` scope Job 的租約緩衝時間（`timeoutMs` + 這個值） |
| `startupJitterRatio` | `0.2` | 各實例首次執行前的隨機延遲比例，避免同時啟動時打爆資料庫 |
| `stats.staleAfterRuns` | `3` | 連續幾輪沒更新視為死掉的實例並清除統計 |
| `stats.consecutiveFailureAlertThreshold` | `3` | Job 連續失敗幾次把彙總日誌升級為 `error` |
| `jobs["<jobName>"]` | — | 依名稱覆寫個別 Job 的 `enabled` / `intervalMs` / `timeoutMs`，不需改程式碼 |

內建 Job：`logging.retentionCleanup`（每小時，刪除超過 `retentionDays` 的日誌檔）。

### idempotency.js — 冪等性 <a id="idempotency"></a>

| 欄位 | 預設值 | 作用 |
| --- | --- | --- |
| `headerName` | `Idempotency-Key` | 客戶端提供 key 的 header 名稱 |
| `maxKeyLength` | `128` | Key 最大長度 |
| `defaultTtlMs` | `3600000`（1 小時） | 路由沒指定 `ttlMs` 時，成功回應可被重播的時間 |
| `pendingLeaseMs` | `120000` | 處理中 key 的鎖定上限，必須大於 `application.requestTimeoutMs` 及路由自己的 `timeoutMs`（啟動時檢查） |
| `cacheableStatusCodes` | `[200,201,202,204]` | 會被快取重播的狀態碼 |
| `storeAdapter` | `mysql` | 共用 store 實作；`mysql` 用 `fr_idempotency_keys` 表，多實例安全；`memory` 只適合單一實例 |
| `memoryMaxEntries` | `10000` | `memory` adapter 保留筆數上限 |
| `purgeMaxBatches` | `50` | 每輪清理最多刪除幾批（每批 1000 列） |
| `maxResponseBytes` | `1048576`（1MB） | 單筆回應可快取的位元組上限，超過則不快取、直接釋放 key |

停用 `IdempotencyService` 後，任何仍在 `static api.idempotency` 宣告啟用的路由會讓應用程式啟動失敗，避免靜默失去冪等保證。

### tokenRevocation.js — JWT 撤銷

| 欄位 | 預設值 | 作用 |
| --- | --- | --- |
| `maxStalenessSeconds` | `60` | 撤銷生效的安全 SLA；實際刷新頻率在 `scheduler.js` 的 `jobs["tokenRevocation.refresh"]` 設定，啟動時交叉檢查一致性 |
| `maxFailOpenSeconds` | `300` | 刷新持續失敗時，舊快照最多可用多久（fail open 有時間盒，避免撤銷永久失效卻沒人發現） |
| `failureMode` | `closed` | 超過 `maxFailOpenSeconds` 後：`closed`（帶 JWT 的請求一律 503，`public` 路由不受影響）或 `open`（維持放行） |
| `maxClockSkewSeconds` | `60` | 容許本機與資料庫時鐘誤差，超過只記錄不補償 |
| `maxCachedSubjects` | `100000` | 快取的使用者版本列數上限，同時是記憶體預算（約 100000 筆對應 25MB） |

---

## 專案結構

```text
client/                Vue 3 前端
server/                Node.js Express API
server/database/       MySQL schema 及業務用種子資料
server/database/framework/  框架自帶資料表，皆以 fr_ 前綴
server/database/migrations/ 由 npm run migrate 套用一次的 schema 變更
server/scripts/migrate.js   套用 database/framework 與 database/migrations，紀錄於 fr_schema_migrations
server/config/         全域設定檔（第五部分）
server/src/framework/  可重用的 API 框架核心能力
server/src/handlers/   自動發現的業務 API Handler
server/src/services/   自動發現的共用 Service（含各 Service 的 jobs/ 子目錄）
```
