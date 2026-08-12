import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryRateLimitStore,
  RateLimitStore
} from "../src/services/requestLimiter/RateLimitStore.js";
import { RequestLimiterService } from "../src/services/requestLimiter/RequestLimiterService.js";
import { RateLimitPurgeJob } from "../src/services/scheduler/jobs/RateLimitPurgeJob.js";
import { createTestTime } from "../test-support/createTestTime.js";

// 記憶體限流 store 的清理原本只掛在 consume() 上：一台不再有流量的實例永遠不會
// 走到那裡，最後一波訪客的記錄就一直留在記憶體裡。沒有流量正是最不會有人去看
// 的情況，所以這個洩漏能安靜地長很久。

const baseConfig = {
  apiPathPrefix: "/api",
  storeKeyPrefix: "test:rate-limit",
  maxConcurrentRequests: 10,
  maxQueueSize: 10,
  queueTimeoutMs: 1000,
  maxRequestsPerIpPerWindow: 5,
  ipWindowMs: 1000,
  retryAfterSeconds: 1
};

function silentLogger() {
  const noop = async () => {};
  return { debug: noop, info: noop, warn: noop, error: noop };
}

function createLimiter({ clock } = {}) {
  const time = createTestTime(clock ? { clock } : undefined);
  const limiter = new RequestLimiterService({
    config: baseConfig,
    logger: silentLogger(),
    time
  });

  return { limiter, time };
}

// --- store 這一層 ------------------------------------------------------------

test("purge removes stale keys even though no request ever arrives", async () => {
  let now = 10_000;
  const store = new MemoryRateLimitStore({ now: () => now });

  await store.consume("ip:1.1.1.1", { limit: 5, windowMs: 1000 });
  await store.consume("ip:2.2.2.2", { limit: 5, windowMs: 1000 });
  assert.equal(store.entries.size, 2);

  // 流量停了。沒有 consume()，節流版 cleanup() 永遠不會被觸發。
  now += 60_000;
  const removedKeys = await store.purge({ before: now - 1000 });

  assert.equal(removedKeys, 2);
  assert.equal(store.entries.size, 0);
});

test("purge keeps records that are still inside the window", async () => {
  let now = 10_000;
  const store = new MemoryRateLimitStore({ now: () => now });

  await store.consume("ip:1.1.1.1", { limit: 5, windowMs: 1000 });
  now += 500;
  await store.consume("ip:2.2.2.2", { limit: 5, windowMs: 1000 });

  const removedKeys = await store.purge({ before: now - 1000 });

  // 第一筆已經出窗，第二筆還在窗內——清理不能把還算數的配額一起抹掉。
  assert.equal(removedKeys, 0);
  assert.deepEqual([...store.entries.keys()], ["ip:1.1.1.1", "ip:2.2.2.2"]);

  now += 1000;
  await store.purge({ before: now - 1000 });
  assert.equal(store.entries.size, 0);
});

test("traffic still triggers cleanup, so no scheduler is not no cleanup", async () => {
  let now = 10_000;
  const store = new MemoryRateLimitStore({ now: () => now });

  await store.consume("ip:1.1.1.1", { limit: 5, windowMs: 1000 });
  now += 120_000;
  await store.consume("ip:2.2.2.2", { limit: 5, windowMs: 1000 });

  // 排程器或 purge job 被停用時，清理能力只是退回「有流量才清」，不會消失。
  assert.deepEqual([...store.entries.keys()], ["ip:2.2.2.2"]);
});

test("the base store treats purge as a no-op for TTL-backed adapters", async () => {
  class RedisLikeStore extends RateLimitStore {
    async consume() {
      return { allowed: true, remaining: 0, retryAfterMs: 0 };
    }
  }

  // 共享 adapter 通常靠儲存層自己的 TTL 過期，不該被要求實作清理。
  assert.equal(await new RedisLikeStore().purge({ before: 0 }), 0);
});

// --- 限流器這一層 ------------------------------------------------------------

test("the limiter purges using its own window, and purge is safe without support", async () => {
  let now = 10_000;
  const { limiter } = createLimiter({ clock: () => new Date(now) });

  await limiter.store.consume("ip:1.1.1.1", { limit: 5, windowMs: 1000 });
  now += 60_000;

  assert.equal(await limiter.purge(), 1);
  assert.equal(limiter.store.entries.size, 0);

  // 注入的 adapter 沒有 purge() 時只是沒有東西可做，不該爆。
  limiter.store = { consume: async () => ({ allowed: true }) };
  assert.equal(await limiter.purge(), 0);
});

// --- job 這一層 --------------------------------------------------------------

function createJob() {
  const purged = [];
  const registered = [];
  const requestLimiter = {
    async purge() {
      purged.push("purge");
      return 0;
    }
  };
  const scheduler = {
    register(instance) {
      registered.push(instance);
    }
  };
  const job = new RateLimitPurgeJob({
    config: {},
    services: { require: (name) => ({ requestLimiter, scheduler })[name] }
  });

  return { job, purged, registered };
}

test("the purge job submits itself and its declaration is complete", async () => {
  const { job, registered } = createJob();

  await job.initialize();

  // Push 模式：job 自己提交，排程器不走訪容器。
  assert.deepEqual(registered, [job]);

  const [declared] = RateLimitPurgeJob.jobs;
  assert.equal(declared.name, "requestLimit.purge");
  assert.equal(typeof job[declared.method], "function");
  // 記憶體 store 在各自的行程裡，每個實例都得清自己的。
  assert.equal(declared.scope, undefined, "預設就是 instance scope");
});

test("running the purge job reaches the limiter", async () => {
  const { job, purged } = createJob();

  await job.run();

  assert.deepEqual(purged, ["purge"]);
});

test("the purge job is discovered by the ordinary service mechanism", async () => {
  const { discoverServiceDefinitions } = await import(
    "../src/framework/services/serviceDiscovery.js"
  );
  const definitions = await discoverServiceDefinitions();
  const found = definitions.find(({ name }) => name === "job.rateLimitPurge");

  assert.ok(found, "jobs/ 底下的 job 應由既有的 service 自發現載入");
  assert.deepEqual([...found.dependencies], ["scheduler", "requestLimiter"]);
});
