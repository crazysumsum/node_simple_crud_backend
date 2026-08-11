# ERP System

Node.js + MySQL + Vue 3 development environment.

## Requirements

- Node.js 26+
- npm 10+
- MySQL 5.7+ or Docker Desktop

Set `APP_TIME_ZONE` once for the whole application; the default is `Asia/Hong_Kong`.
All application timestamps, API response metadata, request context, handler events and
log file dates use this IANA time zone through the injected `time` service.

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
- `maxFileSizeBytes`: maximum size of each log file before a numbered file is created
- `maxQueuedEntries`: how many entries may wait to be written before new ones are
  dropped. Writes are serialized, so a slow disk builds a backlog of full log entries
  — which include complete request and response bodies on errors. Dropping is not
  silent: the next successful write is preceded by a `logging.entries_lost` entry
  counting what was lost.
- `minimumLevel`: lowest level written by the generic logger
- `redactedFields`: field names that are replaced with `[REDACTED]`
- `bodyCapture`: `none` (default) or `full`, for request and response bodies
- `bodyCaptureErrorStatus`: status code at or above which bodies are always kept
- `fileMode` / `directoryMode`: log file and directory permissions, `0o600` / `0o700`
  by default. Startup also tightens existing files with the same prefix, so upgrading
  fixes logs that were already written. Widen to `0o640` if a log shipper running as
  another account in the same group needs to read them.

### Request And Response Bodies

Bodies are **not** logged by default. `redactedFields` is a denylist, so it only masks
field names someone thought to list; business payloads carry national ID numbers,
salaries, bank accounts and addresses under names no denylist enumerates. A body that
is not recorded appears as `"[NOT_LOGGED]"`.

Four rules decide what is written, in this order:

| Condition | Behaviour |
| --- | --- |
| File upload or download | never logged, recorded as `"[FILE_TRANSFER]"` |
| Status ≥ `bodyCaptureErrorStatus` (default 400) | request and response bodies logged in full |
| Route sets `logging.bodyCapture: "full"` | logged in full |
| Otherwise | not logged |

`redactedFields` still applies whenever a body is logged, and file transfers are
detected from the content type, so a `multipart/` upload or a non-JSON response is
skipped even on an error.

A route opts in through its handler:

```js
static api = {
  path: "/api/v1/webhooks/payment",
  logging: { bodyCapture: "full" },
  ...
};
```

Note that the default error threshold of 400 means **validation failures record the
submitted body**, including whatever personal data the user typed. That is a
deliberate trade for reproducibility. Raise `bodyCaptureErrorStatus` to `500` to keep
only server faults, or set it to `null` to disable the override entirely.

Query strings are always recorded as part of `context.url` with `redactedFields`
applied, so treat them as logged and keep personal data out of them.

The logger profiles do not define a time zone. `application.timeZone` is the single
source of truth for every profile and every system-generated timestamp. Configuration
changes require an API restart.

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

### When Logging Itself Fails

A log write that fails cannot be reported through the log — that is either infinite
recursion or the same silent loss again. Those failures go to
`reportInternalFailure` in `server/src/framework/diagnostics/`, which writes to
stderr, the one channel that does not depend on anything the application owns.
Container runtimes, systemd and PM2 all collect it.

It writes the same five-field JSONL as every other log, so it parses in the same
pipeline and can be alerted on. Repeats of the same event are throttled to one line
per minute and reported with `suppressedSinceLastReport` — a full disk is a
continuous failure, and one line per request would bury the first real error.

The events are `logging.system_write_failed`, `logging.request_write_failed`,
`logging.handler_write_failed`, `logging.limiter_write_failed`,
`logging.directory_mode_failed`, `logging.file_mode_failed`,
`logging.directory_scan_failed`, `logging.entries_lost`,
`services.rollback_cleanup_failed`, `application.startup_failed` and
`application.shutdown.forced`. **Any of them appearing means log data was lost or
log files are not protected as configured; alert on all of them.**

Failures that happen outside the logging path use the normal logger and are visible
in the system log — for example `auth.jwt.rejected` (which records whether a token
was expired or forged, while the client only ever sees a generic `JWT_INVALID`),
`idempotency.store.release_failed`, `upload.file_mode_failed` and
`upload.cleanup_failed`.

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
`server/config/jwt.js`. `JWT_SECRET` is required in every environment and has no
built-in default, so the application refuses to start without it. Generate one with
`openssl rand -base64 48`.
Signing and verification live in the `jwt` service
(`server/src/services/auth/JwtService.js`), which is discovered and injected like any
other service. A login handler declares it as a dependency and calls
`this.jwt.issue(payload, { subject })`; `verify(token)` is what the JWT strategy uses.
The normalized config is a private field, so the service's own surface is just
`issue()`, `verify()`, `headerName`, `authScheme` and `expiresIn` — no caller needs
the secret. (Every service still receives the whole application config, so
`config.jwt.secret` remains readable; that is a separate concern.)

An authentication strategy is an ordinary service. It lives anywhere under
`server/src/services`, is found by the same discovery that loads every other service,
and declares `static service` metadata alongside a unique `static authType`. The
framework therefore has only two discovery mechanisms — handlers and services.

```js
import { AuthenticationError } from "../../framework/auth/AuthenticationError.js";
import { BaseAuthStrategy } from "../../framework/auth/BaseAuthStrategy.js";

export class ApiKeyAuthStrategy extends BaseAuthStrategy {
  static authType = "apiKey";

  static service = {
    name: "auth.apiKey",
    lifecycle: "singleton",
    dependencies: ["logging", "mysqldatabase"],
    eager: true
  };

  constructor(context) {
    super(context);
    this.database = context.services.require("mysqldatabase");
  }

  async authenticate(req) {
    const [rows] = await this.database.execute(
      "SELECT client_id FROM api_keys WHERE token = ?",
      [req.get("x-api-key")]
    );

    if (rows.length === 0) {
      throw new AuthenticationError("API_KEY_INVALID", "API key is invalid");
    }

    return { type: this.authType, clientId: rows[0].client_id };
  }

  async shutdown() {
    // Release strategy-owned clients, connections, timers, or subscriptions here.
  }
}
```

After adding the file, set `authType: "apiKey"` in the handler's `static api`. Because
strategies are services they get the container's dependency injection, initialization
ordering and shutdown for free: declare what you need in `dependencies`, read it with
`context.services.require(...)`, and let the container close you. There is no separate
strategy-services option and no separate strategy lifecycle.

`authenticate(req)` must return an object whose `type` matches `static authType`. The
framework freezes that object and assigns it to `req.auth`; a returned `claims`
property is also exposed as `req.user`. Duplicate or invalid auth types stop startup.

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

`static api.path` uses Express 5 route syntax. Named parameters such as
`/api/v1/orders/:id` are unchanged, but optional segments are written `{/:id}` and
wildcards must be named, for example `*splat`. The removed `:id?` and bare `*` forms
are rejected during startup validation with an explicit message. Query strings are
parsed with the extended parser, so `?filter[status]=open` still arrives as a nested
object and must be declared that way in `requestSchema.query`.

## File Uploads And Downloads

Both are off by default and enabled per route in `static api`. Defaults live under
`defaults.upload` and `defaults.download` in `server/config/api.js`; a handler
overrides only the fields it needs.

### Uploads

```js
static api = {
  method: "POST",
  path: "/api/v1/documents",
  description: "Attach a scanned invoice.",
  upload: {
    enabled: true,
    maxFileSizeBytes: 5242880,
    maxFiles: 3,
    allowedMimeTypes: ["application/pdf"]
  },
  requestSchema: {
    body: {
      type: "object",
      required: ["invoiceId"],
      additionalProperties: false,
      properties: { invoiceId: { type: "string" } }
    }
  },
  responseSchema: { 201: { /* ... */ } }
};

async execute(req) {
  // Text fields arrive in req.input.body and are schema-validated as usual.
  // Files arrive in req.files, already validated and written to disk.
  for (const file of req.files) {
    await this.mysqlDatabase.execute(
      "INSERT INTO documents (invoice_id, stored_name, original_name, mime_type, size) VALUES (?, ?, ?, ?, ?)",
      [req.input.body.invoiceId, file.storedName, file.originalName, file.mimeType, file.size]
    );
  }

  return this.response({ stored: req.files.length }, { statusCode: 201 });
}
```

Each entry in `req.files` carries `field`, `originalName`, `storedName`, `path`,
`mimeType`, `size` and `contentHash` (SHA-256 of the file, computed before it is
written).

**Type checking is by content, not by label.** A declared MIME type and a file
extension are both attacker-controlled strings — naming a shell script `invoice.pdf`
and declaring `application/pdf` takes no effort. All three must agree: the declared
type must be in the route allowlist, the extension must match that type, and the
leading bytes must match its signature. `allowedMimeTypes` only accepts registered
types, so an unverifiable entry is a startup error rather than a silently unchecked
allowlist entry.

### Adding A File Type

Types live in the `filetypes` service at
`server/src/services/filetype/FileTypeService.js`, discovered like any other service.
Add project-specific types in `registerCustomTypes()`, which is reserved for
application code and is not overwritten by framework changes:

```js
import { isOle2Container } from "../../framework/upload/signatureMatchers.js";

registerCustomTypes() {
  this.register("application/vnd.ms-excel", {
    extensions: [".xls"],
    matches: isOle2Container
  });
}
```

A type is a MIME type, its allowed extensions (the first becomes the stored
extension), and `matches(buffer)`, which receives the first 4096 bytes and returns a
boolean. `signatureMatchers.js` provides `startsWith`, `isZipContainer`, `isOoxml`,
`isOle2Container` and `isProbablyText`. Registering over a built-in type requires an
explicit `{ override: true }`, so loosening a check is never accidental. Built-in
types are listed separately in `builtInFileTypes.js`.

`matches` receives the **complete** file, not a prefix: the upload middleware buffers
it before validating, and formats like OLE2 keep their identifying data near the end.

Two things to check before adding a type:

- **Is the signature shared?** A ZIP header covers `.zip` and every OOXML format;
  OLE2 (`D0 CF 11 E0`) covers `.xls`, `.doc`, `.ppt` and `.msi` installers. Allowing
  the container allows the whole class. The built-in OLE2 types therefore use
  `isOle2WithStream()` to also require an Office stream name, which is what keeps a
  renamed `.msi` out; do the same for custom types that share a container.
- **Is it plain text?** CSV, JSON, XML and SVG have no signature, so `isProbablyText`
  can only rule out binary content — it will not catch CSV formula injection. SVG is
  XML and can embed `<script>`, so serve it as an attachment, never inline.

### Built-In Types

| Group | Types | Verification |
| --- | --- | --- |
| Documents | `.pdf` | unique signature |
| Images | `.png` `.jpg`/`.jpeg` `.gif` `.webp` | unique signature |
| Office 2007+ | `.xlsx` `.docx` `.pptx` | ZIP + OOXML marker — **not distinguishable from each other** |
| Office 2003− | `.xls` `.doc` `.ppt` | OLE2 + Office stream name — distinguishable, and excludes `.msi` |
| Archives | `.zip` `.7z` `.rar` `.gz`/`.tgz` `.tar` `.bz2` `.xz` | container signature only |
| Text | `.csv` `.txt` | no signature; binary content ruled out |

Archives are verified as containers, not by their contents. Allowing an archive allows
whatever is inside it, so handle zip bombs and traversal in entry names when you
extract. Extension matching uses the last segment only, so `backup.tar.gz` is checked
against `.gz`.

Registration is not the same as permission: a route only accepts what its
`allowedMimeTypes` lists, which defaults to PDF, PNG, JPEG and `.xlsx` in
`config/api.js`.

Other guarantees:

- The client filename is never used on disk. Stored names are a generated UUID plus
  the extension for the verified type, so `../../.ssh/authorized_keys` is inert. The
  original name is passed to the handler as metadata for you to store if you want it.
- Size limits abort mid-stream; an oversized upload is never fully buffered or
  written. Files are held in memory until validation passes, so `maxFileSizeBytes` is
  also the per-request memory ceiling.
- Parsing runs **after** authentication and authorization, so anonymous traffic cannot
  make the server parse uploads.
- A partially written batch is cleaned up rather than left behind.
- Files are written `0600` into a `0700` directory, configurable per route.
- Rejected uploads are never stored.
- Text fields are bounded too. `maxFieldSizeBytes` (64 KiB by default) caps each
  field, and an oversized field is rejected rather than silently truncated. Without
  it, `maxFieldCount` fields could carry far more data than `maxFileSizeBytes`
  suggests the route accepts.
- **Files are removed when the request does not succeed.** Uploads must be parsed
  before schema validation — the text fields have to exist before they can be
  validated — so a file is already on disk when a `400` or a handler exception
  happens. The dispatcher deletes those files, and does the same for an idempotent
  replay, where the handler never ran. A file survives only when the handler returns
  successfully; keep the path in your own records at that point.
- `Idempotency-Key` covers the uploaded files, not just the text fields. Resending
  the same key with a different file is a `409` conflict, not a silent replay that
  discards the new file.
- A client that disconnects mid-upload releases its concurrency slot immediately
  instead of holding it until the request timeout.

### Downloads

```js
static api = {
  method: "GET",
  path: "/api/v1/reports/:id",
  download: { enabled: true },
  ...
};

async execute(req) {
  const filePath = resolveWithinDirectory(uploadDirectory, req.input.params.id);
  return this.file({ path: filePath, fileName: "季度報表.pdf", contentType: "application/pdf" });
}
```

`this.file()` takes exactly one of `path`, `buffer` or `stream`, so stored files,
in-memory content and generated exports all work. The framework sets `Content-Type`,
`Content-Disposition` (with an RFC 5987 `filename*` so non-ASCII names survive),
`Content-Length` where known, and `Cache-Control: private, no-store`.

Calling `this.file()` on a route that has not declared `download.enabled` is a 500,
not a silent bypass — the JSON envelope stays the default and opting out is explicit.

Whenever a path is derived from request input, pass it through
`resolveWithinDirectory` from `server/src/framework/http/fileResponse.js`. It resolves
against the allowed root and rejects anything that escapes it.

Request logging skips file bodies automatically in both directions; see
[Request And Response Bodies](#request-and-response-bodies).

Set `timeoutMs` on download routes deliberately. Once the response has started there
is no way to turn it into a `504` — the headers are already sent — so a download that
outruns its timeout is aborted mid-stream and the client sees a truncated transfer.
The timeout log entry records this as `responseAlreadyStarted: true`. A large report
served over a slow connection is a normal reason to raise the route's `timeoutMs`
above the global default.

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

## System Time Service

`server/src/services/time/SystemTimeService.js` is automatically discovered as the
singleton `time` service. It is the sole current-time source for framework services,
handlers, responses and logs. Use `this.services.require("time")` in a handler or
service, then call `time.timestamp()` for an offset-bearing application timestamp,
`time.now()` for a `Date`, `time.nowMs()` for elapsed-time calculations, and
`time.fileDate()` for daily file names. The configured `application.timeZone` applies
to all formatted values.

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

## Verification

`npm run verify` runs the same three gates as CI, in the same order:

```bash
npm run verify
```

| Gate | Command | Fails on |
| --- | --- | --- |
| Lint | `npm run lint` | any ESLint error (`eslint.config.js`) |
| Tests + coverage | `npm run test:coverage` | a failing test, or coverage under 85% lines / 68% branches / 82% functions |
| Dependencies | `npm run security:audit` | a high or critical advisory |

`npm run lint:fix` applies the autofixable subset. `npm test` runs the suite without
coverage thresholds for a faster inner loop.

The lint rules target defects rather than formatting, because the framework leans on
duck typing that no type checker is validating. Coverage thresholds sit just under
the current numbers so they catch regressions without failing on noise; raise them
as coverage improves.

GitHub Actions runs all three on pull requests, pushes to `main`, manual dispatches,
and every Monday through `.github/workflows/security-audit.yml`.

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
Startup in every environment also requires `JWT_SECRET`.

### Secrets In Configuration

Every service receives the same whole application config object, so `jwt.secret` and
`database.password` are reachable from anywhere. The realistic accident is not
someone reading them deliberately — it is a config object ending up in a log entry or
an error context, and logs are kept for 30 days.

After normalization both values are `SecretValue`
(`server/src/framework/configuration/SecretValue.js`), which separates viewing from
using:

- `JSON.stringify`, `util.inspect` and log output all yield `[REDACTED]`, so writing
  a secret to a log is structurally impossible.
- Reading the value requires an explicit `.reveal()`. That does not stop deliberate
  access, and is not meant to — there is no boundary between first-party modules. It
  makes reading a secret a greppable, reviewable act rather than a property read.
  There are two such call sites: `JwtService` and the MySQL pool factory.
- String coercion **throws** rather than returning `[REDACTED]`. A placeholder would
  let `jwt.sign(payload, config.jwt.secret)` silently sign every token with the
  literal text `[REDACTED]`, with nothing in the failure pointing at the cause.

`BaseService` also holds `config` as a non-enumerable property, so serializing a
service does not drag the whole configuration along with it.

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
