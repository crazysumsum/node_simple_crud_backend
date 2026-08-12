import assert from "node:assert/strict";
import test from "node:test";
import { createApplication } from "../src/framework/application/createApplication.js";
import { defaultConfigurationSource } from "../src/framework/configuration/applicationConfiguration.js";
import { MemoryRateLimitStore } from "../src/services/requestLimiter/RateLimitStore.js";
import { MemoryIdempotencyStore } from "../src/framework/idempotency/IdempotencyStore.js";

// 關閉流程的逾時與失敗分支先前完全沒有測試，而它們正是 closeWithTimeout 的
// 存在理由：任何一個資源關不掉都不能讓程序永遠掛著，且必須反映在 exitCode。
//
// 限流 store 現在由容器關閉（限流器是一個 service），所以它的失敗出現在
// serviceFailures 裡而不是一個專屬欄位——idempotency store 仍走 Factory 自己的
// closeResource，兩條路都要測到。

const silentLogger = {
  debug: async () => {},
  info: async () => {},
  warn: async () => {},
  error: async () => {},
  flush: async () => {}
};

async function startApplication(
  t,
  { rateLimitStore, idempotencyStore, poolEnd = async () => {}, shutdownTimeoutMs = 1000 }
) {
  const source = defaultConfigurationSource();
  const forcedExits = [];
  const application = await createApplication({
    configurationSource: {
      ...source,
      application: { ...source.application, port: 0, shutdownTimeoutMs }
    },
    logger: silentLogger,
    requestLogger: (_req, _res, next) => next(),
    idempotencyStore,
    serviceOptions: {
      mysqldatabase: { pool: { query: async () => [[{ ok: 1 }]], end: poolEnd } },
      requestLimiter: { store: rateLimitStore }
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

  assert.equal(result.idempotencyStoreClosed, false);
  // 限流 store 關不掉會被記成 requestLimiter 這個 service 關閉失敗。
  assert.equal(result.servicesClosed, false);
  // 其他資源仍然正常關閉，失敗不會中斷剩餘流程。
  assert.equal(result.httpServerClosed, true);
  assert.equal(result.exitCode, 1);
  assert.equal(application.state, "stopped");
});

test("a failing rate limit store is named in the shutdown log", async () => {
  const failures = [];
  const rateLimitStore = new MemoryRateLimitStore();
  rateLimitStore.close = async () => {
    throw new Error("rate limit store is unreachable");
  };

  const source = defaultConfigurationSource();
  const application = await createApplication({
    configurationSource: {
      ...source,
      application: { ...source.application, port: 0, shutdownTimeoutMs: 1000 }
    },
    logger: {
      ...silentLogger,
      info: async (event, _message, context) => {
        if (event === "application.shutdown.completed") {
          failures.push(...context.serviceFailures);
        }
      }
    },
    requestLogger: (_req, _res, next) => next(),
    serviceOptions: {
      mysqldatabase: { pool: { query: async () => [[{ ok: 1 }]], end: async () => {} } },
      requestLimiter: { store: rateLimitStore }
    },
    forceExit: () => {}
  });
  await application.start();
  await application.shutdown("test_complete");

  // 刪掉 rateLimitStoreClosed 這個專屬欄位之後，「是哪一個資源關不掉」必須仍然
  // 看得出來，否則等於把一個具名的失敗降級成一個布林值。
  assert.deepEqual(failures, ["requestLimiter"]);
});

test("shutdown gives up on a store whose close never settles", async (t) => {
  const rateLimitStore = new MemoryRateLimitStore();
  // 永不 resolve：沒有逾時保護的話，關閉流程會永遠停在這裡。
  rateLimitStore.close = () => new Promise(() => {});

  // 資料庫也一起卡住，而且這是必要的，不是為了多測一個資源。
  //
  // 容器的 timeoutMs 是「每個 service 各一份」，而 Factory 傳給它的是當下剩餘
  // 的全部預算。只卡一個 service 的話，容器的 withTimeout 會與強制結束計時器
  // 在同一毫秒到期——兩者在 Node 內部屬於不同的 duration 清單，誰先觸發是擲
  // 硬幣。卡兩個就要花掉大約兩倍預算，超時因此是確定的。
  //
  // 這也順帶記錄一個既有行為：關機總時長的上界是「卡住的 service 數 × 預算」，
  // 而不是預算本身。強制結束計時器就是為這件事存在的。
  const poolEnd = () => new Promise(() => {});

  // 逾時之後的每一步預算都只剩 1ms，而 MemoryIdempotencyStore.close() 是純
  // microtask。兩者相加會讓整段收尾在同一次 microtask drain 裡跑完，搶在同
  // 一毫秒到期的強制結束計時器之前執行 clearTimeout——測試就變成擲硬幣。
  // 真實的 store 關閉一定會做 IO，這裡照樣跨一次事件迴圈。
  const idempotencyStore = new MemoryIdempotencyStore();
  idempotencyStore.close = () =>
    new Promise((resolve) => {
      setImmediate(resolve);
    });

  const { application, forcedExits } = await startApplication(t, {
    rateLimitStore,
    idempotencyStore,
    poolEnd,
    shutdownTimeoutMs: 300
  });
  const startedAt = Date.now();
  const result = await application.shutdown("test_complete");
  const elapsedMs = Date.now() - startedAt;

  assert.equal(result.servicesClosed, false);
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

  assert.equal(result.idempotencyStoreClosed, true);
  assert.equal(result.httpServerClosed, true);
  assert.equal(result.servicesClosed, true);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(forcedExits, []);
});
