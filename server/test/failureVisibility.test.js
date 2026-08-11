import assert from "node:assert/strict";
import test from "node:test";
import { AuthenticationError } from "../src/framework/auth/AuthenticationError.js";
import {
  resetInternalFailureReports
} from "../src/framework/diagnostics/reportInternalFailure.js";
import { IdempotencyManager } from "../src/framework/idempotency/IdempotencyManager.js";
import { normalizeIdempotencyConfig } from "../src/framework/idempotency/normalizeIdempotencyConfig.js";
import { ServiceContainer } from "../src/framework/services/ServiceContainer.js";
import { JwtAuthStrategy } from "../src/services/auth/jwtAuthStrategy.js";

// 每一個被吞掉的異常都是一次「現場查不出原因」。這裡守的是：這些路徑真的
// 會留下記錄，而且記錄裡有足夠的資訊可以定位。

function collectingLogger() {
  const entries = [];
  const record = (level) => async (event, message, context) => {
    entries.push({ level, event, message, context });
  };

  return {
    entries,
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error")
  };
}

function captureStderr(t) {
  const lines = [];
  const original = process.stderr.write;

  process.stderr.write = (chunk) => {
    lines.push(String(chunk));
    return true;
  };
  t.after(() => {
    process.stderr.write = original;
  });

  return lines;
}

test("a rejected JWT records why it failed without telling the client", async () => {
  const logger = collectingLogger();
  const expired = Object.assign(new Error("jwt expired"), {
    name: "TokenExpiredError"
  });
  const strategy = new JwtAuthStrategy({
    config: {},
    services: {
      require: (name) => {
        if (name === "jwt") {
          return {
            headerName: "authorization",
            authScheme: "Bearer",
            verify: () => {
              throw expired;
            }
          };
        }

        throw new Error(`Unexpected service: ${name}`);
      },
      get: (name) => (name === "logging" ? { logger } : undefined)
    }
  });

  const req = {
    requestId: "req-1",
    get: (name) => (name === "authorization" ? "Bearer some.token.value" : undefined)
  };

  await assert.rejects(
    () => strategy.authenticate(req),
    (error) => {
      assert.ok(error instanceof AuthenticationError);
      assert.equal(error.code, "JWT_INVALID");
      // 客戶端不該知道差在哪——那等於告訴偽造者他離成功還差多遠。
      assert.doesNotMatch(error.publicMessage, /expired|signature|issuer|audience/i);
      return true;
    }
  );

  const [entry] = logger.entries;
  assert.equal(entry.event, "auth.jwt.rejected");
  assert.equal(entry.level, "warn");
  assert.equal(entry.context.requestId, "req-1");
  // 但防守方必須分得出「過期」與「簽章不符」——後者代表有人在偽造 token。
  assert.equal(entry.context.error.name, "TokenExpiredError");
  assert.equal(entry.context.error.message, "jwt expired");
});

test("failing to release an idempotency key is logged, not swallowed", async () => {
  const logger = collectingLogger();
  const manager = new IdempotencyManager({
    config: normalizeIdempotencyConfig({
      enabled: true,
      headerName: "Idempotency-Key",
      maxKeyLength: 128,
      defaultTtlMs: 60000,
      cacheableStatusCodes: [200, 201],
      storeAdapter: "memory",
      storeKeyPrefix: "test",
      memoryMaxEntries: 10
    }),
    store: {
      begin: async () => ({ state: "started" }),
      complete: async () => {},
      fail: async () => {
        throw new Error("store is unreachable");
      }
    },
    logger,
    context: { get: () => ({}) }
  });

  const req = {
    requestId: "req-2",
    method: "POST",
    apiRoute: { method: "POST", path: "/api/v1/orders" },
    input: { body: {} },
    get: () => "key-1"
  };
  const res = { setHeader: () => {}, statusCode: 200, json: () => {} };
  const routeOptions = manager.routeOptions({ enabled: true }, "post /api/v1/orders");

  // handler 失敗時 key 必須被釋放；釋放也失敗的話 key 會卡在 inProgress
  // 直到 TTL，之後每一次重試都收到 409——不記下來就完全查不出原因。
  await assert.rejects(
    () =>
      manager.execute(req, res, routeOptions, () => {
        throw new Error("handler failed");
      }),
    /handler failed/
  );

  const entry = logger.entries.find(
    (candidate) => candidate.event === "idempotency.store.release_failed"
  );
  assert.ok(entry, "釋放失敗必須留下記錄");
  assert.equal(entry.level, "error");
  assert.equal(entry.context.requestId, "req-2");
  assert.equal(entry.context.path, "/api/v1/orders");
  assert.equal(entry.context.error.message, "store is unreachable");
});

test("a cleanup failure during startup rollback still surfaces", async (t) => {
  const lines = captureStderr(t);
  resetInternalFailureReports();

  class BrokenService {
    static service = Object.freeze({
      name: "broken",
      lifecycle: "singleton",
      dependencies: [],
      eager: true
    });

    async initialize() {
      throw new Error("could not connect");
    }

    async shutdown() {
      throw new Error("could not clean up either");
    }
  }

  const container = new ServiceContainer({
    definitions: [
      {
        name: "broken",
        lifecycle: "singleton",
        dependencies: Object.freeze([]),
        eager: true,
        ServiceClass: BrokenService,
        moduleUrl: "virtual:broken"
      }
    ]
  });

  // 啟動錯誤才是根因，必須原封不動往上拋。
  await assert.rejects(() => container.initialize(), /could not connect/);

  // 但這個 instance 從來沒被 track，正常 shutdown 不會再碰它——清理失敗
  // 在這裡不記就永遠消失了。
  const reported = lines
    .map((line) => JSON.parse(line))
    .find((entry) => entry.event === "services.rollback_cleanup_failed");

  assert.ok(reported, "rollback 清理失敗必須輸出到 stderr");
  assert.equal(reported.context.service, "broken");
  assert.equal(reported.context.startupError, "could not connect");
  assert.equal(reported.context.error.message, "could not clean up either");
});
