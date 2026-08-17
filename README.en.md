# ERP System

*[中文版](README.md)*

A Node.js + MySQL + Vue 3 development environment. `server/` is a self-built CRUD backend framework; `client/` is the matching Vue 3 frontend.

This document has five parts:

1. [Framework Philosophy](#1-framework-philosophy)
2. [Installation & Startup](#2-installation--startup)
3. [Development Guide: Handler, Job, Service](#3-development-guide-handler-job-service)
4. [Built-In Services](#4-built-in-services)
5. [Configuration Reference](#5-configuration-reference)

---

## 1. Framework Philosophy

This is a **CRUD backend framework**: the goal is for developers to only need to focus on three kinds of business code —

- **Handler**: the implementation of one API endpoint (receive the request, run business logic, return a result)
- **Job**: recurring background work (cleanup, cache refresh, scheduled notifications, …)
- **Service**: shared logic that can be injected into Handlers, Jobs, or other Services (database access, calling external systems, encapsulating business rules, …)

Everything a backend "should have" but that isn't business logic itself — authentication, authorization, request/response validation, rate limiting, logging, idempotency, file upload/download, graceful shutdown, configuration validation — is already handled by the framework's native functionality or built-in services, so no project has to reinvent it.

Core design principles:

- **Only two auto-discovery mechanisms**: Handlers under `server/src/handlers/`, and Services under `server/src/services/` (including Jobs placed in a Service's own `jobs/` subdirectory). Add a file, declare its `static` metadata, and the framework finds and registers it at startup — **no central registry, router, or factory needs editing**.
- **Declared dependencies are enforced, not advisory.** A Service declares the other Services it needs via `static service.dependencies`. The Service Container computes initialization order and shutdown order from that declared graph, and rejects circular or missing dependencies at startup — instead of blowing up at runtime.
- **Configuration is validated at startup, not discovered at runtime.** All global configuration sections (application, api, database, jwt, logging, security, request lifecycle) are validated together when the application is built; invalid configuration prevents the application from starting at all rather than running with something broken.
- **Secure defaults first**: APIs require JWT authentication and the `authenticated` authorization policy unless told otherwise; upload, download, and idempotency are all disabled by default and must be explicitly opted into; `JWT_SECRET` has no built-in default and refuses to start without one.

In other words: adding an API usually means adding one Handler file; adding a background task usually means declaring `static jobs` on an existing or new Service; adding reusable logic usually means adding one Service file. The framework takes care of discovering, injecting, validating, logging, and gracefully shutting all of them down.

---

## 2. Installation & Startup

### Requirements

- Node.js 26+
- npm 10+
- MySQL 5.7+

### Step 1: Install dependencies

```bash
npm install
```

This is an npm workspaces project, so `npm install` installs dependencies for both the `client/` and `server/` workspaces at once.

### Step 2: Create environment files

```bash
cp server/.env.example server/.env
cp client/.env.example client/.env
```

In `server/.env`, at minimum check/fill in:

- `JWT_SECRET`: **required, no default.** The application refuses to start without it. Generate one with:

  ```bash
  openssl rand -base64 48
  ```

- `APP_TIME_ZONE`: the single system-wide time zone source, default `Asia/Hong_Kong`. Every API response timestamp, log file date, and request context uses this time zone — set it once for the whole application.
- The remaining fields (`DB_HOST`, `DB_USER`, …) can keep their defaults if you use `init.sql` to create the local database in Step 3.

### Step 3: Prepare MySQL

**Option A, local MySQL:**

```bash
mysql -h 127.0.0.1 -P 3306 -u root -p < server/database/init.sql
```

`init.sql` creates the database and the application user using root/admin credentials, and only needs to run once. It creates:

- Database: `erp_dev`
- Application user: `erp_user` / `erp_password`

If your MySQL uses a local socket, drop `-h 127.0.0.1 -P 3306` from the command above and set `DB_SOCKET_PATH` in `server/.env`.

**Then apply the framework's own tables** (using the application user credentials from `server/.env`):

```bash
cd server && npm run migrate
```

This runs the files under `database/framework/` (framework-owned tables, all prefixed `fr_` so they're never confused with business tables) plus any pending files under `database/migrations/`, and records what it already applied in `fr_schema_migrations`. It's safe to run again after a `git pull` — already-applied files are skipped, only new ones run. The server fails to start with a message naming the missing file if a required table hasn't been created yet.

### Step 4: Start the development servers

```bash
npm run dev
```

This starts both the API server (`server/`, auto-restarting via `nodemon` on change) and the Vue frontend (`client/`, Vite). You can also start them separately:

```bash
npm run dev:server
npm run dev:client
```

### Verify the install

- Vue app: `http://localhost:5173`
- API health check: `http://localhost:3000/api/v1/health`

Calling the health check should return `database: connected`. If it's `unknown` or unreachable, the MySQL service hasn't started or `server/.env`'s database settings are wrong — see [MySQL Notes](#mysql-notes).

### Verify code quality

```bash
npm run verify
```

Runs the same three gates as CI, in order: ESLint (`npm run lint`), tests + coverage (`npm run test:coverage`, global thresholds of 89% lines / 76% branches / 86% functions, plus per-file floors on high-risk files), and a dependency security audit (`npm run security:audit`, i.e. `npm audit --audit-level=high`). `npm run lint:fix` applies the autofixable subset; `npm test` runs the suite without coverage thresholds, for a faster inner loop.

### MySQL Notes

If `/usr/local/mysql` exists locally but the server didn't start successfully during setup, open the MySQL preference pane or inspect `/usr/local/mysql/data/*.err`. A Homebrew MySQL install can also be used with the same `.env` keys.

---

## 3. Development Guide: Handler, Job, Service

### Building a Handler (adding an API)

To add a business API, add **one file** under `server/src/handlers/` — no central API config, registry, factory, or router changes required:

```js
// server/src/handlers/CreateOrderHandler.js
import { BaseRequestHandler } from "../framework/api/BaseRequestHandler.js";

export class CreateOrderHandler extends BaseRequestHandler {
  static handlerName = "createOrder"; // globally unique; a duplicate or missing value stops startup

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

Key points:

- `static handlerName` and `static api` are the only required declarations; the required fields inside `static api` are `method`, `path`, `description`, `requestSchema`, and `responseSchema`. Everything else (`authType`, `authorizationPolicies`, `idempotency`, `upload`, `download`, `timeoutMs`, `deprecation`, …) falls back to the `defaults` in `server/config/api.js` when omitted.
- A Handler **doesn't need its own constructor**; `this.mysqlDatabase`, `this.logger` (system logger), `this.context`, `this.services`, `this.time`, and so on are injected automatically by the framework's Service Container. Reach other Services with `this.services.require("serviceName")`.
- Inside `execute(req)`, read **already-validated** input via `req.input.{params,query,body,headers}` (including schema-driven type coercion and defaults) — **don't** read `req.body`/`req.query` directly.
- You must `return this.response(data, { statusCode })` or `this.file(...)` (download routes) to produce a result; calling `res.json()`/`res.send()` or similar directly is forbidden — that would bypass the standard response envelope and schema validation, so the framework rejects it and throws.
- Throw `new ApplicationError(...)` for every expected failure; the global error handler converts it into the standard error shape.
- `static api.path` uses Express 5 route syntax: named parameters like `/:id` are unchanged, optional segments are written `{/:id}`, and wildcards must be named, e.g. `*splat`. The old `:id?` and bare `*` forms are rejected during startup validation.

For file upload/download, custom authentication types, or authorization policy details, see the existing `healthHandler.js` example in the handlers directory, plus the implementations under `framework/upload/`, `framework/auth/`, and `framework/authorization/` in the framework source.

### Building a Service (adding reusable logic)

Services live anywhere under `server/src/services/` and are auto-discovered the same way — no registration needed:

```js
// server/src/services/user/UserService.js
import { BaseService } from "../../framework/services/BaseService.js";

export class UserService extends BaseService {
  static service = {
    name: "user",              // globally unique; Handlers/other Services require() it by this name
    lifecycle: "singleton",    // singleton | request | transient
    dependencies: ["mysqldatabase", "logging", "context"]
  };

  constructor({ config, services, options }) {
    super({ config, services, options });
    this.mysqlDatabase = services.require("mysqldatabase");
    this.logger = services.require("logging").logger;
    this.context = services.require("context");
  }

  async initialize() {
    // Optional: asynchronous startup work (e.g. warming a cache).
  }

  async shutdown() {
    // Optional: cleanup during graceful shutdown.
  }
}
```

Key points:

- `dependencies` is **enforced**, not documentation: a Service can only `require()` what it declared. That's what makes initialization order and its reverse — shutdown order — computable from the declared graph alone, so a dependency is never torn down before the thing depending on it.
- A `lifecycle: "singleton"` Service is constructed once at startup, in dependency order, and shared everywhere; a `"request"` Service is obtained with `await this.services.resolve("serviceName")`, shared within one request, isolated across concurrent requests, and shut down once request processing completes; `"transient"` creates a new instance on every resolution.
- To temporarily disable a Service (an environment doesn't need it, or an external system it depends on is unavailable), add `enabled: false` to `static service`. If anything still depends on it, startup fails and the message names both sides of the dependency.
- A Handler gets this Service with `this.services.require("user")`.

### Building a Job (adding recurring background work)

A background Job isn't a third discovery mechanism — **the Service that provides it registers itself with the Scheduler.** The Service declares `scheduler` as a dependency and lists the methods to run in `static jobs`:

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

`static jobs` fields:

| Field | Meaning |
| --- | --- |
| `name` | Unique across all services; a duplicate stops startup |
| `method` | A method on the same Service; checked at startup, so a typo fails immediately instead of silently doing nothing later |
| `intervalMs` | Delay between runs |
| `timeoutMs` | Optional; defaults to `scheduler.defaultTimeoutMs`. A ceiling, not an expected duration |
| `scope` | `"instance"` (default — runs on every instance, good for refreshing a local cache) or `"cluster"` (only the instance holding the lease runs it, good for anything with an external effect) |
| `runOnStart` | Run once immediately at startup instead of waiting out the first interval |

Every Job method receives an `AbortSignal`, fired on timeout and on shutdown — long-running logic should observe it and stop.

**When a Service exists only to run one scheduled task**, the convention is to put it in that Service's own `jobs/` subdirectory, e.g. `services/logging/jobs/LogRetentionJob.js`, `services/idempotency/jobs/IdempotencyPurgeJob.js`. That directory is still under `src/services`, so the same Service auto-discovery finds it — there's no separate Job-specific discovery to learn:

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

Written this way, it's still an ordinary Service that can be invoked by hand elsewhere, e.g. `services.require("job.logRetention").run()`, without duplicating the work the scheduler does. Existing examples in this project: `services/requestLimiter/jobs/RateLimitPurgeJob.js`, `services/tokenRevocation/jobs/TokenRevocationRefreshJob.js`, `services/scheduler/jobs/JobStatsFlushJob.js`, `services/idempotency/jobs/IdempotencyPurgeJob.js`.

To tune a Job's frequency or timeout, or turn it off entirely, for a given deployment — no code change needed, override it by name under `jobs` in `server/config/scheduler.js` (see [part 5](#scheduler)).

---

## 4. Built-In Services

The following Services ship with the framework, are auto-discovered and injected, and are normally consumed with `this.services.require("...")` rather than reimplemented:

### mysqldatabase — MySQL Database

`server/src/services/mysqldatabase/MySqlDatabaseService.js`, singleton, eager. It creates the connection pool and runs a health check at startup; a connection failure prevents the application from starting at all (rather than running with a broken database connection).

```js
const orderId = await this.mysqlDatabase.withTransaction(async (transaction) => {
  const [result] = await transaction.execute(
    "INSERT INTO orders (customer_id) VALUES (?)",
    [customerId]
  );
  return result.insertId;
});
```

Provides `query()`/`execute()` (with query timeouts), `healthCheck()`, and `withTransaction()` (validated MySQL isolation levels, bounded execution time, commit/rollback/release, and the active transaction is reachable via Request Context). Every query inside a transaction automatically inherits the transaction's timeout signal, so you don't need to pass one to each call by hand. Configuration: `server/config/database.js`.

### jwt / Authentication

`server/src/services/auth/JwtService.js` signs and verifies JWTs; `jwtAuthStrategy.js` and `publicAuthStrategy.js` are the two built-in authentication types (`authType: "jwt"` / `"public"`).

```js
const token = this.jwt.issue({ sub: user.id, role: user.role }, { subject: String(user.id) });
```

A Handler only needs to name the authentication type in `static api.authType` (default `jwt`); the framework handles the rest. Adding a custom authentication type (e.g. API Key) is just an ordinary Service that declares `static authType` and extends `BaseAuthStrategy`. Configuration: `server/config/jwt.js` (field reference in part 5).

### tokenRevocation — JWT Revocation

`server/src/services/tokenRevocation/TokenRevocationService.js`. Revocation is expressed as a version number: one row per user holding a monotonically increasing counter; a token is revoked once its issued-at version is older than the current one. Each instance caches the whole table in memory, so the request path never queries the database directly. The actual refresh cadence is set in `server/config/scheduler.js`; the safety SLA (how soon revocation must take effect) is set in `server/config/tokenRevocation.js`, and the two are cross-checked for consistency at startup.

### context — Request Context

`server/src/services/context/RequestContextService.js` stores request-scoped state in `AsyncLocalStorage` (request ID, client IP, route metadata, authentication, authorization policies, timeout deadline/signal, active database transaction). A deep Service that declares `context` as a dependency can call `this.context.get()` directly, without threading `req` through every method — it stays valid across `await` boundaries and isolated across concurrent requests.

### logging — Logging

`server/src/services/logging/LoggingService.js` ships two profiles: `request` (HTTP request/response logs, `server/logs/requests-YYYY-MM-DD.log`) and `system` (backend runtime events, `server/logs/system/system-YYYY-MM-DD.log`). Every profile shares the same five-field envelope (`timestamp`/`level`/`event`/`message`/`context`). Add custom profiles such as `audit` under `loggers` in `server/config/logging.js` as needed — the framework creates the corresponding Logger for it automatically at startup.

```js
this.services.require("logging").require("audit").info("order.created", "Order created", { orderId });
```

Request/response bodies are **not** logged by default (`bodyCapture: "none"`), since business payloads often carry national ID numbers, salaries, and other personal data. A single route can opt in with `static api.logging.bodyCapture: "full"`, and any status code at or above `bodyCaptureErrorStatus` (default 500) is always logged in full to aid debugging. Full rules, fields, and settings: [part 5 — logging](#logging).

### requestLimiter — Request Rate Limiting

`server/src/services/requestLimiter/RequestLimiterService.js`. Limits global concurrent requests (excess goes into a bounded FIFO queue) and per-client-IP request rate (token bucket) at the same time. The built-in `memory` adapter only works for a single instance; sharing quota accurately across instances requires implementing the `RateLimitStore` interface and injecting it. Configuration: [part 5 — requestLimiter](#requestlimiter).

### idempotency — Idempotency

`server/src/services/idempotency/IdempotencyService.js`. Once a route explicitly enables it via `static api.idempotency.enabled: true`, callers must send an `Idempotency-Key` header. The key is scoped by caller identity and route, and carries a fingerprint of the validated input. Reusing a key with different input returns 409; a completed successful response is replayed with `Idempotency-Replayed: true`. Defaults to MySQL (`fr_idempotency_keys`) as the shared store; single-instance deployments can switch to `memory` to skip a database round trip. Configuration: [part 5 — idempotency](#idempotency).

### scheduler — Background Scheduling

`server/src/services/scheduler/SchedulerService.js`. It doesn't scan anything itself — each Service calls `this.services.require("scheduler").register(this)` inside its own `initialize()` to submit its declared `static jobs` (usage shown in [part 3](#building-a-job-adding-recurring-background-work)). Supports `instance` and `cluster` scopes; `cluster` jobs take a lease from the `job_leases` table so exactly one instance runs a given tick. A failure is logged and the job keeps its schedule rather than being stopped by one bad run. Configuration: [part 5 — scheduler](#scheduler).

### time — System Time

`server/src/services/time/SystemTimeService.js` is the sole current-time source for the framework. `time.timestamp()` returns an offset-bearing application timestamp, `time.now()` a `Date`, `time.nowMs()` for elapsed-time calculations, and `time.fileDate()` for daily file names. Time zone is controlled everywhere by `application.timeZone` (`server/config/application.js`).

### filetype — File Type Verification

`server/src/services/filetype/FileTypeService.js`. Upload handling uses it to check that the declared MIME type, the file extension, and the actual content signature all agree — any mismatch is rejected. Built-in types are listed in `builtInFileTypes.js`; register project-specific types in `registerCustomTypes()` (reserved for application code, never overwritten by framework updates):

```js
import { isOle2Container } from "../../framework/upload/signatureMatchers.js";

registerCustomTypes() {
  this.register("application/vnd.ms-excel", {
    extensions: [".xls"],
    matches: isOle2Container
  });
}
```

Upload/download are both disabled by default and must be explicitly enabled on a route via `static api.upload` / `static api.download`; details (size limits, allowed types, on-disk permissions, etc.) live under `defaults.upload` / `defaults.download` in `server/config/api.js`.

---

## 5. Configuration Reference

All global configuration files live under `server/config/`. Each file holds only configuration data (some provide dynamic defaults, such as reading environment variables) and no initialization logic; everything is validated together at startup, and any invalid section stops the application from starting, listing every problem found. The tables below cover the key fields in each file; the full, line-by-line rationale (including *why* each value is designed the way it is) is written as comments in the files themselves — this section is a quick reference only.

### application.js — Application & Request Lifecycle

| Field | Env var | Default | Effect |
| --- | --- | --- | --- |
| `host` | `APP_HOST` | `127.0.0.1` | Host Express listens on |
| `port` | `APP_PORT` | `3000` | Port Express listens on |
| `timeZone` | `APP_TIME_ZONE` | `Asia/Hong_Kong` | The single system-wide time zone source; every log and API timestamp uses it |
| `requestTimeoutMs` | `REQUEST_TIMEOUT_MS` | `30000` | Max processing time once a request enters the handler stage (auth/validation/execution); overridable per API via `static api.timeoutMs` |
| `requestReceiveTimeoutMs` | `REQUEST_RECEIVE_TIMEOUT_MS` | `120000` | Ceiling for receiving the whole request (headers + body); must be ≥ `requestTimeoutMs` and every route's own `timeoutMs` |
| `headersReceiveTimeoutMs` | `HEADERS_RECEIVE_TIMEOUT_MS` | `10000` | Ceiling for receiving headers alone |
| `bodyReceiveTimeoutMs` | `BODY_RECEIVE_TIMEOUT_MS` | `10000` | Ceiling for receiving a JSON body (a framework-owned watchdog, not a Node built-in) |
| `connectionsCheckingIntervalMs` | `CONNECTIONS_CHECKING_INTERVAL_MS` | `2000` | Check frequency for the two socket-level timeouts above; the upper bound of error in when they actually fire |
| `shutdownTimeoutMs` | `SHUTDOWN_TIMEOUT_MS` | `30000` | Max wait during graceful shutdown before forcing closure |
| `maxConnections` | `APP_MAX_CONNECTIONS` | `512` | Max HTTP sockets this process will hold at once |

Startup enforces an ordering among the four timeouts (`connectionsCheckingIntervalMs ≤ headersReceiveTimeoutMs ≤ requestReceiveTimeoutMs`, and `requestReceiveTimeoutMs` must cover both `requestTimeoutMs` and every route's own `timeoutMs`); violating it stops startup.

### api.js — Route Defaults & Versioning

- `defaults`: values every Handler falls back to when `static api` doesn't specify them — `authType` (default `jwt`), `authorizationPolicies` (default `authenticated`), `deprecation`, `idempotency` (disabled by default), `logging.bodyCapture` (default `none`), `upload` / `download` (disabled by default, including size/count/type limits and on-disk permissions), `timeoutMs` (`null` means inherit `application.requestTimeoutMs`).
- `versioning`: `enabled`, `defaultVersion` (`v1`), `supportedVersions`, `responseHeaderName` (`API-Version`) — controls the `/api/<version>/...` path format and the version response header.
- `upload` (global, not per-route): `maxConcurrentUploads` (default 10, uploads being parsed at once across all routes) and `maxUploadMemoryBytes` (default 256MB, upload buffering memory ceiling); startup checks whether `maxConcurrentUploads × a route's maxRequestBytes` exceeds this ceiling.

### database.js — MySQL Connection & Transactions

| Field | Env var | Default | Effect |
| --- | --- | --- | --- |
| `host` / `port` / `user` / `password` / `database` | `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` | `127.0.0.1` / `3306` / `root` / `""` / `erp_dev` | Connection details |
| `socketPath` | `DB_SOCKET_PATH` | none | When set, a Unix socket connection is used instead |
| `connectionLimit` | — | `10` | Connection pool size |
| `queueLimit` | `DB_QUEUE_LIMIT` | `200` | Cap on requests waiting for a connection (**never set to 0** — that means unlimited, and waiters accumulate without bound) |
| `acquireTimeoutMs` | `DB_ACQUIRE_TIMEOUT_MS` | `5000` | Ceiling for waiting on the pool to hand out a connection |
| `queryTimeoutMs` | `DB_QUERY_TIMEOUT_MS` | `10000` | Timeout for a single query/execute, counted only after a connection is acquired |
| `transactionTimeoutMs` | `DB_TRANSACTION_TIMEOUT_MS` | `20000` | Max time for a whole transaction (including COMMIT) |
| `abandonedConnectionAction` | `DB_ABANDONED_CONNECTION_ACTION` | `destroy` | What happens to a connection after a query times out: `destroy` (rebuild it, guaranteed clean state) or `release` (return it to the pool, possibly carrying the previous caller's session state) |
| `ssl.enabled` | `DB_SSL_ENABLED` | `false` | Whether to enable TLS for the MySQL connection; should be `true` whenever `DB_HOST` isn't local |
| `ssl.ca` | `DB_SSL_CA` | none | PEM content of the CA certificate; multi-line values must be escaped as `\n` |
| `ssl.rejectUnauthorized` | `DB_SSL_REJECT_UNAUTHORIZED` | `true` | Whether to verify the certificate; only disable for local self-signed testing |

`acquireTimeoutMs + queryTimeoutMs` (or `+ transactionTimeoutMs`) must be less than `application.requestTimeoutMs`, and `queueLimit` must not be smaller than `requestLimiter.maxConcurrentRequests - connectionLimit`; both are checked at startup.

### jwt.js — JWT Issuance & Verification

| Field | Env var | Default | Effect |
| --- | --- | --- | --- |
| `secret` | `JWT_SECRET` | **none, required** | Signing/verification key, at least 32 characters; missing value stops startup |
| `issuer` | `JWT_ISSUER` | `erp-api` | Token issuer, prevents accepting tokens signed by another system |
| `audience` | `JWT_AUDIENCE` | `erp-web` | Expected token audience |
| `algorithm` | — | `HS256` | Signing algorithm; verification only accepts this one, preventing algorithm downgrade attacks |
| `expiresIn` | `JWT_EXPIRES_IN` | `2h` | Token lifetime; must be a number plus a unit (`s`/`m`/`h`/`d`/`w`) — a bare number is treated as milliseconds |
| `clockToleranceSeconds` | `JWT_CLOCK_TOLERANCE_SECONDS` | `5` | Clock skew tolerance when validating `exp`/`nbf` |
| `headerName` / `authScheme` | — | `authorization` / `Bearer` | Header the token travels in, and the auth scheme |

### logging.js — Logger Profiles <a id="logging"></a>

Add profiles freely under `loggers` (the framework creates the matching service at startup automatically); `request` and `system` ship built in. Shared fields:

| Field | Effect |
| --- | --- |
| `enabled` | Whether this profile is active |
| `directory` / `filePrefix` | Log directory (relative to `server/`) and daily file name prefix |
| `retentionDays` / `cleanupIntervalHours` | Retention period, and the minimum interval between expiry checks |
| `maxFileSizeBytes` | Ceiling per log file; exceeding it starts a same-day numbered file |
| `maxQueuedBytes` / `maxQueuedEntries` | Cap on log data waiting to be written to disk (bytes/count, whichever hits first); exceeding it drops entries and records a loss count |
| `maxEntryBytes` | Ceiling per log entry; excess is truncated starting from the heaviest field (usually the body) |
| `fileMode` / `directoryMode` | File/directory permissions, default `0o600` / `0o700` |
| `minimumLevel` | Lowest level recorded (`debug`/`info`/`warn`/`error`) |
| `bodyCapture` (`request` only) | `none` (default) or `full`; overridable per route via `static api.logging.bodyCapture` |
| `bodyCaptureErrorStatus` (`request` only) | Status codes ≥ this value are always logged in full; default `500`, `null` disables the override |
| `redactedFields` | Field names to mask (case-insensitive) |

Body-capture precedence: file upload/download bodies are never logged → status codes reaching `bodyCaptureErrorStatus` are always logged in full → a route's own `full` opt-in → otherwise not logged. Query strings are always recorded in `context.url` (with `redactedFields` applied), so keep personal data out of query strings.

### security.js — HTTP Security

| Field | Env var | Default | Effect |
| --- | --- | --- | --- |
| `helmetEnabled` | — | `true` | Whether Helmet security headers (HSTS, frame protection, etc.) are enabled |
| `hidePoweredBy` | — | `true` | Removes `X-Powered-By` |
| `jsonBodyLimit` | — | `100kb` | JSON body size cap; exceeding it returns 413 |
| `cors.allowedOrigins` | `CLIENT_URL` | `http://localhost:5173,http://127.0.0.1:5173` | Allowed browser origins (comma-separated, no `*`) |
| `cors.allowedMethods` / `allowedHeaders` / `exposedHeaders` | — | see file | CORS header lists |
| `cors.credentials` | — | `false` | Whether cross-origin cookies/credentials are allowed |
| `reverseProxy.trustProxy` | `TRUST_PROXY` | `false` | How `X-Forwarded-For` is trusted: `false` trusts nothing; a number (e.g. `1`) trusts that many hops from the right (single entry point only); a trusted-source list (e.g. `"loopback, 10.0.0.0/8"`) matches by IP/CIDR and suits multiple entry points; **never `true`** (that trusts the whole chain, letting any client spoof `req.ip`) |
| `reverseProxy.enforceHttps` | `ENFORCE_HTTPS` | `false` | Whether to enforce HTTPS; requires `trustProxy` to be set correctly so `X-Forwarded-Proto` can be read safely |

Recommended production values behind a single trusted reverse proxy:

```dotenv
CLIENT_URL=https://erp.example.com
TRUST_PROXY=1
ENFORCE_HTTPS=true
```

Getting `TRUST_PROXY` wrong has no obvious symptom, yet it silently degrades IP rate limiting accuracy, idempotency scoping on unauthenticated routes, and `clientIp` in the logs — see the full explanation in `server/config/security.js`.

### request.js — Request/Response Schema Validation

| Field | Default | Effect |
| --- | --- | --- |
| `validation.input.enabled` | `true` | Whether request input is validated |
| `validation.input.allErrors` | `true` | Collect every input error in one pass rather than stopping at the first |
| `validation.input.coerceTypes` | `true` | Coerce basic types per the schema (e.g. query string `"10"` → `number`) |
| `validation.input.useDefaults` | `true` | Apply schema `default` values automatically |
| `validation.input.removeAdditional` | `false` | Whether undeclared fields are stripped automatically |
| `validation.input.maxErrors` | `20` | Max number of errors reported per validation pass |
| `validation.output.enabled` / `validateInProduction` | `true` / `true` | Whether response output is validated, and whether that includes production |

System-level request throttling (concurrency, queueing, IP rate) is a separate concern, configured in `requestLimiter.js` (below).

### requestLimiter.js — Request Rate Limiting <a id="requestlimiter"></a>

| Field | Default | Effect |
| --- | --- | --- |
| `storeAdapter` | `memory` | Rate-limit state storage; `memory` computes per instance independently — accurate cross-instance quotas require implementing and injecting `RateLimitStore` |
| `apiPathPrefix` | `/api` | Only requests under this path prefix are throttled |
| `maxConcurrentRequests` | `100` | Requests a single instance can execute at once |
| `maxQueueSize` / `queueTimeoutMs` | `200` / `30000` | Queue size and max wait time once concurrency is saturated |
| `maxRequestsPerIpPerWindow` / `ipWindowMs` | `20` / `1000` | Token bucket capacity and refill period (steady-state rate = former/latter, default 20/sec; refill is continuous, not released all at once per window) |
| `retryAfterSeconds` | `1` | Suggested `Retry-After` when throttled |
| `maxTrackedKeys` | `100000` | Cap on sources tracked at once by the memory store, preventing forged sources from exhausting memory |
| `ipv6PrefixLength` | `64` | IPv6 sources are aggregated to this prefix length for quota purposes (a shared `/64` counts as one client) |
| `abandonGraceMs` / `maxAbandonedRequests` | `1000` / `100` | Grace period after a request times out before its still-running handler is counted as a leak; reaching this many accumulated leaks returns 503 |
| `storeOperationTimeoutMs` / `storeFailureMode` | `500` / `closed` | Ceiling on external store operations, and whether a timeout means `closed` (reject new requests) or `open` (let the IP check pass) |

Throttled requests always return HTTP 429; internal logs retain the actual reason (IP limit, queue full, queue timeout, etc.).

### scheduler.js — Background Scheduling <a id="scheduler"></a>

| Field | Default | Effect |
| --- | --- | --- |
| `enabled` | `true` | Disabling stops all Jobs from registering/running, but the startup log still lists what was skipped |
| `defaultTimeoutMs` | `30000` | Default execution ceiling for Jobs that don't specify `timeoutMs` |
| `clusterLeaseGraceMs` | `30000` | Lease buffer for `cluster`-scope Jobs (`timeoutMs` + this value) |
| `startupJitterRatio` | `0.2` | Random delay ratio before each instance's first run, avoiding every instance hammering the database at once on startup |
| `stats.staleAfterRuns` | `3` | Consecutive missed rounds before an instance is considered dead and its stats cleared |
| `stats.consecutiveFailureAlertThreshold` | `3` | Consecutive failures before a Job's rollup log is escalated to `error` |
| `jobs["<jobName>"]` | — | Per-name overrides of `enabled` / `intervalMs` / `timeoutMs`, no code change needed |

Built-in Job: `logging.retentionCleanup` (hourly, deletes log files past `retentionDays`).

### idempotency.js — Idempotency <a id="idempotency"></a>

| Field | Default | Effect |
| --- | --- | --- |
| `headerName` | `Idempotency-Key` | Header the client's key travels in |
| `maxKeyLength` | `128` | Max key length |
| `defaultTtlMs` | `3600000` (1 hour) | How long a successful response can be replayed when a route doesn't specify `ttlMs` |
| `pendingLeaseMs` | `120000` | Lock ceiling for an in-progress key; must exceed `application.requestTimeoutMs` and every idempotent route's own `timeoutMs` (checked at startup) |
| `cacheableStatusCodes` | `[200,201,202,204]` | Status codes eligible for caching and replay |
| `storeAdapter` | `mysql` | Shared store implementation; `mysql` uses the `fr_idempotency_keys` table and is safe across instances; `memory` is single-instance only |
| `memoryMaxEntries` | `10000` | Entry cap for the `memory` adapter |
| `purgeMaxBatches` | `50` | Max batches deleted per cleanup round (1000 rows per batch) |
| `maxResponseBytes` | `1048576` (1MB) | Max bytes a cacheable response may occupy; larger ones aren't cached and the key is released immediately |

Disabling `IdempotencyService` while a route still declares `static api.idempotency` enabled stops the application from starting, to avoid silently losing the idempotency guarantee.

### tokenRevocation.js — JWT Revocation

| Field | Default | Effect |
| --- | --- | --- |
| `maxStalenessSeconds` | `60` | Safety SLA for how soon revocation must take effect; the actual refresh cadence is `jobs["tokenRevocation.refresh"]` in `scheduler.js`, cross-checked for consistency at startup |
| `maxFailOpenSeconds` | `300` | How long a stale snapshot may keep serving while refreshes keep failing (fail-open is time-boxed, so revocation can't silently stay broken forever) |
| `failureMode` | `closed` | What happens once `maxFailOpenSeconds` is exceeded: `closed` (requests carrying a JWT get 503; `public` routes are unaffected) or `open` (keep serving) |
| `maxClockSkewSeconds` | `60` | Tolerated clock skew between this instance and the database; exceeding it is only logged, never compensated for |
| `maxCachedSubjects` | `100000` | Cap on cached user version rows, and the memory budget (roughly 100,000 rows ≈ 25MB) |

---

## Project Structure

```text
client/                Vue 3 frontend
server/                Node.js Express API
server/database/       MySQL schema and seed data for the business
server/database/framework/  Framework-owned tables, all prefixed fr_
server/database/migrations/ Schema deltas applied once by `npm run migrate`
server/scripts/migrate.js   Applies database/framework and database/migrations, tracked in fr_schema_migrations
server/config/         Global configuration files (part 5)
server/src/framework/  Reusable API framework capabilities
server/src/handlers/   Auto-discovered business API handlers
server/src/services/   Auto-discovered shared services (each with its own jobs/ subdirectory)
```
