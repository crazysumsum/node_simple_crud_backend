# ERP System

Node.js + MySQL + Vue 3 development environment.

## Requirements

- Node.js 26+
- npm 10+
- MySQL 5.7+ or Docker Desktop

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create environment files:

   ```bash
   cp .env.example server/.env
   cp .env.example client/.env
   ```

3. Prepare MySQL.

   Option A, local MySQL:

   ```bash
   mysql -h 127.0.0.1 -P 3306 -u root -p < server/database/init.sql
   ```

   This creates the `erp_dev` database and an application user:

   - User: `erp_user`
   - Password: `erp_password`

   If your MySQL uses a local socket, run the same SQL without `-h 127.0.0.1 -P 3306` and set `DB_SOCKET_PATH` in `server/.env`.

   Option B, Docker:

   ```bash
   docker compose up -d mysql adminer
   ```

   Docker credentials:

   - Host: `127.0.0.1`
   - Port: `3306`
   - Database: `erp_dev`
   - User: `erp_user`
   - Password: `erp_password`
   - Adminer: `http://localhost:8080`

4. Start development servers:

   ```bash
   npm run dev
   ```

## URLs

- Vue app: `http://localhost:5173`
- API health: `http://localhost:3000/api/v1/health`

## API Request Logs

Every API request is written as one JSON object per line. The default output is `server/logs/requests-YYYY-MM-DD.log`.

Every logger profile uses the same five top-level fields:

```json
{
  "timestamp": "2026-08-05T18:00:00.000+08:00",
  "level": "info",
  "event": "http.request.completed",
  "message": "HTTP request completed",
  "context": {}
}
```

`timestamp` is the time the log record is created in the profile's configured IANA
time zone with an explicit UTC offset, `level` is the log level,
`event` identifies the event, and `message` is its short description. All
profile-specific information belongs in `context`. Request logs put `requestId`,
`requestTime`, `responseTime`, `durationMs`, method, URL, client IP, validated input,
output status/body, and completion state there. System and additional profile logs use
the same envelope with their own context fields.

All logger profiles are configured under `loggers` in `server/config/logging.js`.
The built-in request log profile uses `loggers.request`. Every setting is documented
with an inline comment in that file. Common logger settings include:

- `directory`: log directory, relative to `server/` unless absolute
- `filePrefix`: daily log file prefix
- `retentionDays`: number of days to retain log files
- `cleanupIntervalHours`: expired-log cleanup frequency
- `timeZone`: IANA time zone used for timestamps and daily file names
- `maxFileSizeBytes`: maximum size of each log file before a numbered file is created
- `minimumLevel`: lowest level written by the generic logger
- `redactedFields`: field names that are replaced with `[REDACTED]`

Configuration changes require an API restart.

## System Logs

Backend startup and runtime events are written separately to
`server/logs/system/system-YYYY-MM-DD.log`. System logging is configured under
`loggers.system` in `server/config/logging.js`, including retention, cleanup interval, time zone,
maximum file size, minimum level, and sensitive fields.

Every profile is backed by the same generic `Logger`; there is no logger
`type`. The request middleware only observes the HTTP lifecycle and sends the
collected context to that service. `Logger.write()` enforces the shared five-field
contract and rejects profile-specific top-level fields. `SystemLogger` only formats
level/event/message calls and delegates the resulting entry to the same service.

Additional named profiles such as `audit` can be added directly under `loggers` with
their own directory, file prefix, retention and redaction settings. The
`LoggerRegistry` creates every configured profile at startup and is exposed by the
`logging` service. Handlers can use `this.logging.require("audit")`; any service can
use `this.services.require("logging").require("audit")`.

Startup logs cover configuration loading, Express middleware, MySQL connection pool
creation and verification, authentication strategy loading, every API registration,
the global error handler, and the final listening address.

Every API handler must extend `BaseRequestHandler` and implement `execute()`. The base
class records handler start and finish events with the request ID, timestamps,
duration, response code, outcome, and internal error details when applicable.
Handler classes under `server/src/handlers` are discovered recursively at startup;
duplicate or missing `static handlerName` values stop startup.

## Request Limits

API request limits are configured under `limits` in `server/config/request.js`. The middleware
limits global concurrent requests, places excess traffic into a bounded FIFO queue,
and rejects requests when the queue is full or its wait timeout is reached. It also
uses a sliding time window to limit requests from each client IP.

`RequestLimiter` accepts an injected `RateLimitStore`. Its atomic `consume()` contract
allows Redis or another shared adapter to enforce one IP quota across multiple Node.js
instances. The built-in memory adapter is intended for one process. Concurrent slots
and the FIFO queue remain instance-local because queued HTTP connections belong to
the process that accepted them; size those values per instance behind a load balancer.

Rejected requests return HTTP 429 with the same `Too Many Requests` code and message.
Internal system logs retain the actual reason, including IP limit, queue full, queue
timeout, queue entry, and queue release events. The request logger remains before the
limiter, so queued and rejected requests still receive a request ID and request log.

Queue waiting time and API processing time are separate limits. After a request leaves
the queue, `REQUEST_TIMEOUT_MS` defines the default authentication, validation, and
handler deadline. An API can override it with a positive `static api.timeoutMs` in its
Handler. Timeout responses use HTTP 504 with
`REQUEST_TIMEOUT`; handlers can observe `req.requestTimeout.signal` and stop downstream work when it
is aborted.

## API Configuration And Authentication

Each Handler declares its route in `static api`. The required fields are `method`,
`path`, `description`, `requestSchema`, and `responseSchema`; the Handler association is
derived automatically. Shared defaults live in `server/config/api.js` under `defaults`: APIs
use `v1`, JWT authentication, the `authenticated` policy, no deprecation, no
idempotency, and the global request timeout unless the Handler overrides them.
Arrays such as `authorizationPolicies` are replaced as a whole; `deprecation` and
`idempotency` merge by field; request and response schemas are replaced as a whole.
Unknown fields and missing required fields stop startup. Requests that do not match a
registered Handler definition return a generic HTTP 401 `Unauthorized Access`
response.

The built-in authentication types are `public` and `jwt`. JWT settings are stored in
`server/config/jwt.js`; production secrets must be supplied through `JWT_SECRET`.
After a successful login, handlers can call `issueAccessToken` from
`server/src/framework/auth/jwtService.js`.

Authentication strategy classes under `server/src/auth_strategies` are discovered
recursively once by the Application Factory at startup. Each class extends
`BaseAuthStrategy`, declares a unique `static authType`, and implements
`authenticate(req)`. No registry, dispatcher, or factory changes are required.
Duplicate or invalid auth types stop startup.

```js
import { AuthenticationError } from "../framework/auth/AuthenticationError.js";
import { BaseAuthStrategy } from "../framework/auth/BaseAuthStrategy.js";

export class ApiKeyAuthStrategy extends BaseAuthStrategy {
  static authType = "apiKey";

  async authenticate(req) {
    if (req.get("x-api-key") !== process.env.INTEGRATION_API_KEY) {
      throw new AuthenticationError("API_KEY_INVALID", "API key is invalid");
    }

    return { type: this.authType, clientId: "integration-client" };
  }

  async close() {
    // Release strategy-owned clients, connections, timers, or subscriptions here.
  }
}
```

After adding the file, set `authType: "apiKey"` in the Handler's `static api`. Strategy
instances receive a frozen services container through `this.services`, with
`this.logger` and `this.jwtConfig` convenience properties. Application-specific
strategy services may be supplied through the Factory's `authStrategyServices` option.
`authenticate(req)` must return an object whose `type` matches `static authType`.
The framework freezes that object and assigns it to `req.auth`; a returned `claims`
property is also exposed as `req.user`. The optional `close()` lifecycle method runs
once during graceful shutdown and during startup rollback.

Authorization is a separate step after authentication. The default `authenticated`
policy may be replaced through `static api.authorizationPolicies`; all configured
policies must return `true`. Built-in policies are
`allowAll`, `authenticated`, `hasRole`, and `hasPermission`. Role and permission
policies accept JSON `options` containing `roles`/`permissions` and an `all` or `any`
match mode. Invalid options stop startup. Tenant or resource policies can still be
registered through `AuthorizationPolicyRegistry`. Denied authorization returns the
standard HTTP 403 `Forbidden` response.

```js
authorizationPolicies: [
  "authenticated",
  {
    name: "hasPermission",
    options: { permissions: ["order.create"], match: "all" }
  }
]
```

## Adding A Business API

For a normal business endpoint, add one handler file under
`server/src/handlers`. No central API config, registry, factory, router or
middleware changes are required. A handler does not need a constructor:

```js
import { BaseRequestHandler } from "../framework/api/BaseRequestHandler.js";

export class CreateOrderHandler extends BaseRequestHandler {
  static handlerName = "createOrder";

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

`this.logger`, `this.mysqlDatabase`, `this.context`, and `this.services` come from the
shared Service Container. Application services are discovered automatically and can
be read with `this.services.require("serviceName")`.

Authentication failures use the same HTTP 401 response as unconfigured APIs. Both
`error.code` and `error.message` are `Unauthorized Access`, so clients cannot infer
whether an API exists or why authentication failed.

## Request Context

`server/src/services/context/RequestContextService.js` stores request-scoped state in
`AsyncLocalStorage`. Deep services declare `context` as a dependency and call
`this.context.get()` without passing `req` through every method. The context includes request ID, client IP, route metadata,
authentication, authorization policies, timeout deadline/signal and the active
database transaction. It remains isolated across concurrent requests and available
across promise/`await` boundaries.

## Service Container

Application service implementations live anywhere under `server/src/services` and are
discovered recursively during Application Factory startup. Service Container,
discovery and lifecycle core code lives under `server/src/framework/services`. A
service class declares its name, lifecycle and dependencies with static metadata. No
central registry needs editing. The following example uses
`server/src/services/user/UserService.js`.

```js
import { BaseService } from "../../framework/services/BaseService.js";

export class UserService extends BaseService {
  static service = {
    name: "user",
    lifecycle: "singleton",
    dependencies: ["mysqldatabase", "logging", "context"]
  };

  constructor({ config, services, options }) {
    super({ config, services, options });
    this.mysqlDatabase = services.require("mysqldatabase");
    this.logger = services.require("logging").logger;
    this.context = services.require("context");
  }

  async initialize() {
    // Optional asynchronous startup work.
  }

  async shutdown() {
    // Optional cleanup during graceful shutdown.
  }
}
```

`singleton` services are constructed once in dependency order and shared by handlers,
authentication strategies and other services. Startup fails for missing dependencies,
cycles, duplicate names, or any rejected `initialize()` call. No HTTP port starts
listening until all eager services initialize successfully. Graceful shutdown runs
initialized services in reverse order. The framework automatically creates a scope for every HTTP request. `request`
services resolved with `await this.services.resolve("serviceName")` are shared inside
that request, isolated from concurrent requests, and shut down after actual request
processing completes. `transient` services create a new instance per resolution.

The built-in singleton services are `logging`, `mysqldatabase`, and `context`. A handler
normally accesses application services as follows:

```js
const user = this.services.require("user");
```

## API Versioning And Deprecation

Path-based versions are configured in `server/config/api.js` under `versioning`. Every route
uses `/api/<version>/...` and receives an `API-Version` response header. Handlers may
omit `version` to inherit `versioning.defaultVersion`. Unsupported versions or mismatched paths
stop startup.

Set `static api.deprecation.deprecated=true` to emit `Deprecation`; optional
`deprecatedAt`, `sunsetAt`, and `replacement` values also emit `Sunset` and a
`successor-version` `Link`. This lets clients migrate before an old route is removed.

## Idempotency

Framework idempotency is configured in `server/config/api.js` under `idempotency` and
enabled per route with `static api.idempotency.enabled=true`. Such requests must
provide `Idempotency-Key`.
The key is scoped by caller identity and route, while a fingerprint also covers the
validated input. A completed successful response is replayed with
`Idempotency-Replayed: true`; key reuse with different input returns HTTP 409.

The built-in `MemoryIdempotencyStore` is for one process. Multi-instance deployments
must inject an atomic shared `IdempotencyStore` implementation through the Application
Factory. Store entries have configurable TTLs and pending entries prevent concurrent
duplicate work.

## Request Validation

Every Handler declares `requestSchema` in `static api`. JSON Schema can
validate `params`, `query`, `body`, and `headers`. Schemas are compiled once when the
API dispatcher starts and are reused for every request. Invalid schemas prevent the
application from starting.

Validation runs after authentication and before `BaseRequestHandler`. Invalid input
returns HTTP 400 with `REQUEST_VALIDATION_FAILED`, does not invoke the handler, and
writes field paths and failed rules to the system log without recording rejected
values. Shared behavior such as type coercion, defaults, error limits, and response
details is configured under `validation.input` in `server/config/request.js`.

After validation, handlers read all accepted input from `req.input`:

```js
const { params, query, body, headers } = req.input;
```

This object always has the same four locations. Values may contain the type
coercion and defaults declared by the API schema.

## Response Validation

Every Handler declares `responseSchema` in `static api`, keyed by HTTP
status code. Each schema validates the handler's returned `data`, not the standard
`success/data/meta` envelope. Use `default` as an optional fallback for status codes
that do not need separate contracts.

`BaseRequestHandler` validates output immediately before sending it. Missing status
schemas, wrong types, missing properties and additional properties cause HTTP 500 with
the public `INTERNAL_SERVER_ERROR` response. The rejected data and schema details are
never returned to the client; field paths and failed rules are recorded internally as
`RESPONSE_VALIDATION_FAILED`.

All response schemas compile when the dispatcher starts. Runtime behavior is
configured under `validation.output` in `server/config/request.js`; validation is
enabled in production by default and can only be disabled explicitly with
`validateInProduction`.

## Standard API Responses

Handlers extending `BaseRequestHandler` must return their result instead of calling
`res.json()`, `res.send()`, or another direct response method. Direct response writes
are rejected so they cannot bypass schema validation or the standard envelope. The
base class validates `data` against the configured response schema and then creates
the standard success envelope:

```json
{
  "success": true,
  "data": {},
  "meta": {
    "requestId": "request-id",
    "timestamp": "2026-08-03T00:00:00.000Z"
  }
}
```

Use `this.response(data, { statusCode, meta })` when a handler needs a status
other than 200. All expected failures should throw `ApplicationError`; the global
error handler converts errors, malformed JSON, and oversized bodies into one shape:

```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Safe client message"
  },
  "meta": {
    "requestId": "request-id",
    "timestamp": "2026-08-03T00:00:00.000Z"
  }
}
```

## HTTP Security

Security settings are documented in `server/config/security.js`. Helmet supplies
security headers, Express disables `X-Powered-By`, JSON bodies default to `100kb`,
and browser origins must match the comma-separated `CLIENT_URL` allowlist exactly.
Requests without an Origin header remain available for trusted server-to-server
clients. Wildcard CORS origins are rejected during startup.

Terminate TLS at a reverse proxy such as Nginx or a cloud load balancer. For one
trusted proxy hop, use these production environment values:

```dotenv
CLIENT_URL=https://erp.example.com
TRUST_PROXY=1
ENFORCE_HTTPS=true
```

The proxy must replace, rather than append untrusted values to,
`X-Forwarded-For` and `X-Forwarded-Proto`. Do not expose the Node.js port directly
when HTTPS enforcement relies on forwarded headers. Keep `TRUST_PROXY=false` and
`ENFORCE_HTTPS=false` for direct local HTTP development.

## Dependency Security

Run the high-severity dependency vulnerability gate locally:

```bash
npm run security:audit
```

`npm run security:check` runs both the audit and backend tests. GitHub Actions also
runs the audit on pull requests, pushes to `main`, manual dispatches, and every
Monday through `.github/workflows/security-audit.yml`.

## Application Factory

`server/src/framework/application/createApplication.js` is the asynchronous composition root. It validates
configuration, discovers and initializes services, then creates authentication and
authorization registries, request/response validation, limiting, idempotency and the
handler registry. The instance exposes `app`, `configuration`, `services`, `loggers`,
`state`, `start()` and `shutdown()`; it does not own or special-case individual service
implementations.

Tests and deployments can inject routes, handlers, authentication strategies,
authorization policies, validators, loggers, limiter/store adapters, idempotency
manager/store adapters, and generic service values, options, factories, or overrides.
For example, a test pool is supplied through
`serviceOptions.mysqldatabase.pool`; no MySQL-specific Application Factory argument is
required. The executable
`server/src/index.js` only loads environment variables, creates the application,
registers process lifecycle handlers and starts listening.

Call the factory with `await createApplication(...)`; asynchronous creation allows it
to discover and import handler modules before any HTTP port starts listening.

## Configuration Validation

All seven global configuration sections are normalized and validated together before
runtime resources are created: application, API, database, JWT, logging, security,
and the unified request lifecycle configuration. Invalid startup configuration throws
`ConfigurationError` with a `details` array containing every invalid section.
Production startup also requires `JWT_SECRET` from the environment.

## MySQL Database Service

Handlers receive the shared `MySqlDatabaseService` through dependency injection under
the `mysqldatabase` service name. It offers
parameterized `query()` and `execute()`, configured query timeouts, health checks,
pool closure, and `withTransaction()`. Transactions support validated MySQL isolation
levels, bounded execution time, commit/rollback/release, request cancellation, and a
transaction executor exposed through Request Context while the callback is active.
Every transaction query automatically inherits the transaction timeout signal, so
handlers do not need to pass a signal into each `query()` or `execute()` call.

The service is eager. Its `initialize()` method creates the connection pool and runs a
health query. A connection error or invalid health result rejects service
initialization, closes the pool through the Service Container rollback, and prevents
the HTTP server from listening. Application startup does not contain a separate MySQL
health-check branch.

```js
const orderId = await mysqlDatabase.withTransaction(async (transaction) => {
  const [result] = await transaction.execute(
    "INSERT INTO orders (customer_id) VALUES (?)",
    [customerId]
  );
  return result.insertId;
});
```

## Graceful Shutdown

`SIGTERM` and `SIGINT` stop new requests, reject queued requests with the standard
HTTP 503 response, allow active requests to finish, close the HTTP server, shut down
all initialized services in reverse dependency order, and flush request/system logs. The total deadline is configured through
`shutdownTimeoutMs` in `server/config/application.js`; forced or incomplete closure
sets a non-zero process exit code.

The process lifecycle also treats `uncaughtException` and `unhandledRejection` as
fatal. It records `process.fatal_error`, starts bounded shutdown, flushes logs and exits
with code 1 instead of attempting to continue in an uncertain process state. A second
termination signal forces immediate exit.

## MySQL Notes

This project is ready to connect to MySQL, but the database service must be running before `/api/v1/health` reports `database: connected`.

On this Mac, `/usr/local/mysql` exists, but the server did not start successfully during setup. If you want to use that installation, open the MySQL preference pane or inspect `/usr/local/mysql/data/*.err`. A Homebrew MySQL install or Docker Desktop can also be used with the same `.env` keys.

## Project Structure

```text
client/                Vue 3 frontend
server/                Node.js Express API
server/database/       MySQL schema and seed data
server/src/framework/  Reusable API framework capabilities
server/src/handlers/   Auto-discovered business API handlers
server/src/services/   Auto-discovered shared application services
docker-compose.yml     Optional MySQL and Adminer services
```

## Repository Push Verification

This README update verifies that changes can be committed and pushed to GitHub successfully.
