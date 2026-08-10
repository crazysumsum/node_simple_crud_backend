import assert from "node:assert/strict";
import test from "node:test";
import { createApplication } from "../src/framework/application/createApplication.js";
import { defaultConfigurationSource } from "../src/framework/configuration/applicationConfiguration.js";
import { MemoryRateLimitStore } from "../src/framework/limiting/RateLimitStore.js";
import { MemoryIdempotencyStore } from "../src/framework/idempotency/IdempotencyStore.js";

// 關閉流程的逾時與失敗分支先前完全沒有測試，而它們正是 closeWithTimeout 的
// 存在理由：任何一個資源關不掉都不能讓程序永遠掛著，且必須反映在 exitCode。

const silentLogger = {
  debug: async () => {},
  info: async () => {},
  warn: async () => {},
  error: async () => {},
  flush: async () => {}
};

async function startApplication(t, { rateLimitStore, idempotencyStore, shutdownTimeoutMs = 1000 }) {
  const source = defaultConfigurationSource();
  const forcedExits = [];
  const application = await createApplication({
    configurationSource: {
      ...source,
      application: { ...source.application, port: 0, shutdownTimeoutMs }
    },
    logger: silentLogger,
    requestLogger: (_req, _res, next) => next(),
    rateLimitStore,
    idempotencyStore,
    serviceOptions: {
      mysqldatabase: { pool: { query: async () => [[{ ok: 1 }]], end: async () => {} } }
    },
    // 逾時情境下框架會呼叫 forceExit，記錄而不是真的結束測試程序。
    forceExit: (code) => forcedExits.push(code)
  });
  t.after(() => application.shutdown("test_cleanup"));

  await application.start();
  return { application, forcedExits };
}

test("shutdown reports a store that fails to close and fails the exit code", async (t) => {
  const rateLimitStore = new MemoryRateLimitStore();
  rateLimitStore.close = async () => {
    throw new Error("rate limit store is unreachable");
  };
  const idempotencyStore = new MemoryIdempotencyStore();
  idempotencyStore.close = async () => {
    throw new Error("idempotency store is unreachable");
  };

  const { application } = await startApplication(t, { rateLimitStore, idempotencyStore });
  const result = await application.shutdown("test_complete");

  assert.equal(result.rateLimitStoreClosed, false);
  assert.equal(result.idempotencyStoreClosed, false);
  // 其他資源仍然正常關閉，失敗不會中斷剩餘流程。
  assert.equal(result.httpServerClosed, true);
  assert.equal(result.servicesClosed, true);
  assert.equal(result.exitCode, 1);
  assert.equal(application.state, "stopped");
});

test("shutdown gives up on a store whose close never settles", async (t) => {
  const rateLimitStore = new MemoryRateLimitStore();
  // 永不 resolve：沒有逾時保護的話，關閉流程會永遠停在這裡。
  rateLimitStore.close = () => new Promise(() => {});

  const { application, forcedExits } = await startApplication(t, {
    rateLimitStore,
    shutdownTimeoutMs: 300
  });
  const startedAt = Date.now();
  const result = await application.shutdown("test_complete");
  const elapsedMs = Date.now() - startedAt;

  assert.equal(result.rateLimitStoreClosed, false);
  assert.equal(result.exitCode, 1);
  assert.equal(application.state, "stopped");
  // 必須在 shutdown 期限附近放棄，而不是無限等待。
  assert.ok(elapsedMs < 3000, `shutdown took ${elapsedMs}ms`);
  // 超過期限時框架會請求強制結束。
  assert.deepEqual(forcedExits, [1]);
});

test("shutdown closes cleanly when every resource cooperates", async (t) => {
  const { application, forcedExits } = await startApplication(t, {
    rateLimitStore: new MemoryRateLimitStore(),
    idempotencyStore: new MemoryIdempotencyStore()
  });
  const result = await application.shutdown("test_complete");

  assert.equal(result.rateLimitStoreClosed, true);
  assert.equal(result.idempotencyStoreClosed, true);
  assert.equal(result.httpServerClosed, true);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(forcedExits, []);
});
