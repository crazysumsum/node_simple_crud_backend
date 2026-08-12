import assert from "node:assert/strict";
import test from "node:test";
import { validateApiConfig } from "../src/framework/middleware/apiDispatcher.js";
import { BaseRequestHandler } from "../src/framework/api/BaseRequestHandler.js";
import { discoverServiceDefinitions } from "../src/framework/services/serviceDiscovery.js";
import { IdempotencyPurgeJob } from "../src/services/idempotency/jobs/IdempotencyPurgeJob.js";

// Idempotency 的兩種失效都是安靜的：route 以為自己防著重複提交但 service 不在，
// 或租約短於請求時長讓兩個實例同時執行同一件工作。兩者都只能在啟動時擋。

class OrderHandler extends BaseRequestHandler {
  static handlerName = "createOrder";

  async execute() {
    return { ok: true };
  }
}

const strategies = { has: () => true, types: () => ["public"] };

function route(overrides = {}) {
  return {
    method: "POST",
    path: "/api/v1/orders",
    description: "Create an order.",
    authType: "public",
    version: "v1",
    authorizationPolicies: [{ name: "allowAll", options: {} }],
    deprecation: { deprecated: false, deprecatedAt: null, sunsetAt: null, replacement: null },
    idempotency: { enabled: true, ttlMs: 60000 },
    logging: { bodyCapture: "none" },
    requestSchema: {},
    responseSchema: { 200: {} },
    handler: "createOrder",
    ...overrides
  };
}

const handlers = { createOrder: new OrderHandler("createOrder", { logger: null }) };

function validate(routes, idempotency, { defaultRequestTimeoutMs = 30000 } = {}) {
  return validateApiConfig(
    routes,
    handlers,
    strategies,
    defaultRequestTimeoutMs,
    undefined,
    undefined,
    idempotency
  );
}

const service = (pendingLeaseMs = 120000) => ({
  pendingLeaseMs,
  routeOptions: (source) => ({
    enabled: source.enabled === true,
    ttlMs: source.ttlMs ?? 60000
  })
});

// --- service 缺席 -------------------------------------------------------------

test("a route that declares idempotency cannot start without the service", () => {
  // 靜默降級的話，這條 route 以為自己防著重複提交，實際上沒有——而那只會在
  // 生產環境用重複的請求證明給你看。
  assert.throws(
    () => validate([route()], null),
    (error) => {
      assert.match(error.message, /^post \/api\/v1\/orders declares idempotency/);
      assert.match(error.message, /disabled by its static service\.enabled flag/);
      return true;
    }
  );
});

test("routes that do not use idempotency start fine without the service", () => {
  validate([route({ idempotency: { enabled: false } })], null);
});

// --- 租約交叉檢查 --------------------------------------------------------------

test("a route timeout at or over the pending lease fails startup", () => {
  // 租約在原請求還在跑的時候到期，另一個實例就會接手同一件工作——idempotency
  // 反過來造成重複執行。
  for (const timeoutMs of [120000, 180000]) {
    assert.throws(
      () => validate([route({ timeoutMs })], service(120000)),
      (error) => {
        assert.match(error.message, /is not shorter than idempotency\.pendingLeaseMs \(120000\)/);
        assert.match(error.message, /executed twice/);
        return true;
      },
      `timeoutMs=${timeoutMs} 應該被擋下`
    );
  }
});

test("a route timeout below the pending lease is accepted", () => {
  validate([route({ timeoutMs: 119999 })], service(120000));
});

test("the check also covers routes that inherit the application timeout", () => {
  // 沒有自己的 timeoutMs 時，套用的是應用層預設——它同樣可能超過租約。
  assert.throws(
    () => validate([route()], service(30000), { defaultRequestTimeoutMs: 30000 }),
    /is not shorter than idempotency\.pendingLeaseMs \(30000\)/
  );
});

test("a route without idempotency is not subject to the lease check", () => {
  validate(
    [route({ idempotency: { enabled: false }, timeoutMs: 999999 })],
    service(120000)
  );
});

// --- 清理工作 ------------------------------------------------------------------

test("the purge job is cluster scoped and reaches the service", async () => {
  const purged = [];
  const registered = [];
  const job = new IdempotencyPurgeJob({
    config: {},
    services: {
      require: (name) =>
        ({
          idempotency: {
            async purge() {
              purged.push("purge");
              return 0;
            }
          },
          scheduler: { register: (instance) => registered.push(instance) }
        })[name]
    }
  });

  await job.initialize();
  await job.run();

  const [declared] = IdempotencyPurgeJob.jobs;
  // 表是所有實例共用的；instance scope 只會讓每台重複同一個 DELETE。
  assert.equal(declared.scope, "cluster");
  assert.equal(declared.name, "idempotency.purge");
  assert.equal(typeof job[declared.method], "function");
  assert.deepEqual(registered, [job]);
  assert.deepEqual(purged, ["purge"]);
});

test("the purge job is discovered, and the service itself stays free of the scheduler", async () => {
  const definitions = await discoverServiceDefinitions();

  assert.ok(definitions.some(({ name }) => name === "job.idempotencyPurge"));

  // 排程器依賴隔離在葉子裡：掛在 IdempotencyService 上的話，停用排程器會讓
  // idempotency 建構失敗，而那會連帶讓所有宣告 idempotency 的 route 起不來。
  const idempotency = definitions.find(({ name }) => name === "idempotency");
  assert.equal(idempotency.dependencies.includes("scheduler"), false);
});

// --- 設定驗證 ------------------------------------------------------------------

test("the configuration rejects values that would silently weaken idempotency", async () => {
  const { normalizeIdempotencyConfig } = await import(
    "../src/services/idempotency/normalizeIdempotencyConfig.js"
  );
  const base = {
    headerName: "Idempotency-Key",
    maxKeyLength: 128,
    defaultTtlMs: 3600000,
    pendingLeaseMs: 120000,
    cacheableStatusCodes: [200, 201],
    storeAdapter: "mysql",
    storeKeyPrefix: "test",
    memoryMaxEntries: 10,
    maxResponseBytes: 1024
  };

  assert.throws(() => normalizeIdempotencyConfig(null), /must be an object/);
  // 全域開關已經移到 static service.enabled。
  assert.throws(
    () => normalizeIdempotencyConfig({ ...base, enabled: false }),
    /"enabled" was removed/
  );
  // 打錯的 adapter 名字先前會一路走到 Factory；在共享 store 這件事上，錯字的
  // 代價是整個叢集靜默失去 idempotency。
  assert.throws(
    () => normalizeIdempotencyConfig({ ...base, storeAdapter: "redis" }),
    /must be one of: memory, mysql/
  );
  assert.throws(
    () => normalizeIdempotencyConfig({ ...base, headerName: "Bad Header" }),
    /"headerName" is invalid/
  );
  assert.throws(
    () => normalizeIdempotencyConfig({ ...base, storeKeyPrefix: "" }),
    /"storeKeyPrefix" is invalid/
  );
  assert.throws(
    () => normalizeIdempotencyConfig({ ...base, cacheableStatusCodes: [500] }),
    /must contain HTTP 2xx codes/
  );
  assert.throws(
    () => normalizeIdempotencyConfig({ ...base, pendingLeaseMs: 0 }),
    /"pendingLeaseMs" must be a positive integer/
  );
  assert.throws(
    () => normalizeIdempotencyConfig({ ...base, maxResponseBytes: -1 }),
    /"maxResponseBytes" must be a positive integer/
  );
  assert.throws(
    () => normalizeIdempotencyConfig({ ...base, purgeMaxBatches: 0 }),
    /"purgeMaxBatches" must be a positive integer/
  );

  const defaults = normalizeIdempotencyConfig({
    headerName: "Idempotency-Key",
    cacheableStatusCodes: [200],
    storeKeyPrefix: "test"
  });
  assert.equal(defaults.storeAdapter, "mysql");
  assert.equal(defaults.defaultTtlMs, 3600000);
  assert.equal(defaults.pendingLeaseMs, 120000);
  assert.equal(defaults.purgeMaxBatches, 50);
});

// --- 落後訊號 ------------------------------------------------------------------

async function purgeThrough(storePurgeResult) {
  const { IdempotencyService } = await import(
    "../src/services/idempotency/IdempotencyService.js"
  );
  const { normalizeIdempotencyConfig } = await import(
    "../src/services/idempotency/normalizeIdempotencyConfig.js"
  );
  const entries = [];
  const record = (level) => async (event, message, context) =>
    entries.push({ level, event, context });
  const service = new IdempotencyService({
    config: normalizeIdempotencyConfig({
      headerName: "Idempotency-Key",
      cacheableStatusCodes: [200],
      storeKeyPrefix: "test",
      storeAdapter: "memory",
      purgeMaxBatches: 7
    }),
    store: {
      begin: async () => ({ state: "started" }),
      complete: async () => {},
      fail: async () => {},
      purge: async () => storePurgeResult
    },
    logger: { info: record("info"), warn: record("warn"), error: record("error") },
    context: { get: () => ({}) }
  });

  const removed = await service.purge();
  return { removed, entries };
}

test("a purge that hits its batch limit warns that cleanup is falling behind", async () => {
  const { removed, entries } = await purgeThrough({ removed: 7000, exhausted: true });

  assert.equal(removed, 7000);

  // 沒有這一筆的話，「清理追不上」完全沒有徵兆：過期判斷是逐筆做的，所以
  // 行為一切正常，只有表在單調成長。
  const warning = entries.find(
    ({ event }) => event === "idempotency.purge_incomplete"
  );
  assert.equal(warning.level, "warn");
  assert.equal(warning.context.purgeMaxBatches, 7);
  assert.equal(warning.context.removedRecords, 7000);
  assert.match(warning.context.remedy, /purgeMaxBatches/);
});

test("a purge that finishes its work does not warn", async () => {
  const { entries } = await purgeThrough({ removed: 12, exhausted: false });

  assert.equal(
    entries.some(({ event }) => event === "idempotency.purge_incomplete"),
    false
  );
  assert.equal(
    entries.find(({ event }) => event === "idempotency.purged").context.removedRecords,
    12
  );
});

test("an adapter with nothing to purge neither logs nor throws", async () => {
  // memory adapter 繼承基底的 no-op：它有自己的節流掃描，也沒有共享表。
  const { removed, entries } = await purgeThrough({ removed: 0, exhausted: false });

  assert.equal(removed, 0);
  assert.deepEqual(entries, []);
});
