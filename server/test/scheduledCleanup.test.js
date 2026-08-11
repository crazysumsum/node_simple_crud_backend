import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FileLogWriter } from "../src/services/logging/fileLogWriter.js";
import { LogRetentionService } from "../src/services/logging/LogRetentionService.js";
import { normalizeLoggerConfig } from "../src/services/logging/normalizeLoggingConfig.js";
import { createTestTime } from "../test-support/createTestTime.js";

// 清理原本只掛在 write() 上，所以一台不寫日誌的伺服器永遠不會清理。request
// logger 要有流量才寫，system logger 更是只在啟動、錯誤與關機時才寫——一個長期
// 安靜、沒有錯誤的實例，過期檔案會一直留著，而 retentionDays 說好了只留 30 天。

const time = createTestTime();

async function writerWithExpiredFile(t, overrides = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "erp-retention-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const expired = path.join(directory, "test-2020-01-01.log");
  await writeFile(expired, "old\n", "utf8");
  const staleDate = time.at(time.nowMs() - 10 * 24 * 60 * 60 * 1000);
  await utimes(expired, staleDate, staleDate);

  const config = normalizeLoggerConfig(
    {
      directory,
      filePrefix: "test",
      retentionDays: 2,
      cleanupIntervalHours: 1,
      maxFileSizeBytes: 1048576,
      ...overrides
    },
    "test"
  );

  return { writer: new FileLogWriter({ config, time }), directory, expired };
}

test("runCleanup removes expired files without any log being written", async (t) => {
  const { writer, directory } = await writerWithExpiredFile(t);

  // 沒有任何 write()——這正是先前永遠清不掉的情況。
  await writer.runCleanup();

  assert.deepEqual(await readdir(directory), []);
});

test("cleanup and writes share one queue, so the write target stays consistent", async (t) => {
  const { writer, directory } = await writerWithExpiredFile(t);

  // 兩者都會動到 this.target；同時進行而不排隊的話，寫入可能落到一個
  // 已經被清理掉的檔案上。
  await Promise.all([
    writer.write({
      timestamp: time.timestamp(),
      level: "info",
      event: "test.entry",
      message: "first",
      context: {}
    }),
    writer.runCleanup(),
    writer.write({
      timestamp: time.timestamp(),
      level: "info",
      event: "test.entry",
      message: "second",
      context: {}
    })
  ]);

  await writer.flush();

  const files = await readdir(directory);
  assert.equal(files.includes("test-2020-01-01.log"), false, "過期檔案仍要被清掉");
  assert.equal(files.length, 1, "兩筆寫入應落在同一個目前檔案");
});

test("cleanup still honours each profile's cleanupIntervalHours", async (t) => {
  const { writer, directory, expired } = await writerWithExpiredFile(t, {
    cleanupIntervalHours: 24
  });

  // 建構子已經清過一次，所以這一輪還不到期——把檔案放回去確認它沒有被再清一次。
  await writer.ready;
  await writeFile(expired, "old\n", "utf8");
  const staleDate = time.at(time.nowMs() - 10 * 24 * 60 * 60 * 1000);
  await utimes(expired, staleDate, staleDate);

  await writer.runCleanup();

  // 排程器每小時叫一次，但清理頻率仍由設定決定，語意不變。
  assert.deepEqual(await readdir(directory), ["test-2020-01-01.log"]);
});

test("a disabled logger has no writer and cleanup is a no-op", async () => {
  const { Logger } = await import("../src/services/logging/Logger.js");
  const logger = new Logger({
    name: "test",
    config: {
      enabled: false,
      directory: "logs/test",
      filePrefix: "test",
      retentionDays: 1,
      cleanupIntervalHours: 1,
      maxFileSizeBytes: 1024,
      redactedFields: []
    },
    time
  });

  assert.equal(logger.writer, null);
  await logger.cleanup();
});

test("the retention service registers its job and cleans every logger profile", async () => {
  const cleaned = [];
  const registered = [];
  const logging = {
    async cleanup() {
      cleaned.push("all");
    }
  };
  const scheduler = {
    register(instance) {
      registered.push(instance);
    }
  };
  const service = new LogRetentionService({
    config: {},
    services: { require: (name) => ({ logging, scheduler }[name]) }
  });

  await service.initialize();

  // Push 模式：service 自己提交，排程器不走訪容器。
  assert.deepEqual(registered, [service]);

  const [job] = LogRetentionService.jobs;
  assert.equal(job.name, "logging.retentionCleanup");
  assert.equal(job.method, "cleanup");
  // 日誌檔在各自的本機磁碟上，每個實例都得清自己的。
  assert.equal(job.scope, undefined, "預設 instance scope");

  await service[job.method]();
  assert.deepEqual(cleaned, ["all"]);
});

test("the rate limit store is purged without traffic", async () => {
  const { MemoryRateLimitStore } = await import("../src/framework/limiting/RateLimitStore.js");
  let now = 10_000;
  const store = new MemoryRateLimitStore({ now: () => now });

  await store.consume("10.0.0.1", { limit: 5, windowMs: 1000 });
  await store.consume("10.0.0.2", { limit: 5, windowMs: 1000 });
  assert.equal(store.entries.size, 2);

  // 閒置期間沒有 consume()，過期項目原本就會一直留著。
  now += 60_000;
  await store.purgeExpired({ windowMs: 1000 });

  assert.equal(store.entries.size, 0);
});

test("purging keeps entries that are still inside the window", async () => {
  const { MemoryRateLimitStore } = await import("../src/framework/limiting/RateLimitStore.js");
  let now = 10_000;
  const store = new MemoryRateLimitStore({ now: () => now });

  await store.consume("10.0.0.1", { limit: 5, windowMs: 10_000 });
  now += 500;
  await store.purgeExpired({ windowMs: 10_000 });

  assert.equal(store.entries.size, 1, "還在視窗內的配額不得被清掉");
});

test("a shared adapter without native purging is left alone", async () => {
  const { RateLimitStore } = await import("../src/framework/limiting/RateLimitStore.js");

  class SharedStore extends RateLimitStore {
    async consume() {
      return { allowed: true, remaining: 1, retryAfterMs: 0 };
    }
  }

  // Redis 之類有原生 TTL，基底的 no-op 才是正確行為。
  await new SharedStore().purgeExpired({ windowMs: 1000 });
});

test("the request limiter submits its own purge job when given a scheduler", async () => {
  const { RequestLimiter } = await import("../src/framework/middleware/requestLimiter.js");
  const registered = [];
  const silent = {
    debug: async () => {},
    info: async () => {},
    warn: async () => {},
    error: async () => {}
  };
  const limiter = new RequestLimiter({
    logger: silent,
    time: { nowMs: () => 0, timestamp: () => "t" },
    scheduler: { register: (instance) => registered.push(instance) }
  });

  // 限流器不是 service，排程器以協作者身分傳入，工作仍由它自己送出。
  assert.deepEqual(registered, [limiter]);

  const [job] = RequestLimiter.jobs;
  assert.equal(job.name, "requestLimits.purgeExpired");
  assert.equal(typeof limiter[job.method], "function");

  // 沒有排程器時不註冊，清理仍走 consume() 觸發的舊路徑。
  const standalone = new RequestLimiter({
    logger: silent,
    time: { nowMs: () => 0, timestamp: () => "t" }
  });
  assert.equal(typeof standalone.purgeExpired, "function");
});

test("the registry fans cleanup out to every profile", async () => {
  const { LoggerRegistry } = await import("../src/services/logging/LoggerRegistry.js");
  const cleaned = [];
  const registry = new LoggerRegistry({
    configs: { request: {}, system: {} },
    loggerFactory: (name) => ({
      name,
      async cleanup() {
        cleaned.push(name);
      },
      async flush() {}
    })
  });

  await registry.cleanup();

  assert.deepEqual(cleaned.sort(), ["request", "system"]);
});
