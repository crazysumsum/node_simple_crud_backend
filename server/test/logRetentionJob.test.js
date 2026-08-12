import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FileLogWriter } from "../src/services/logging/fileLogWriter.js";
import { Logger } from "../src/services/logging/Logger.js";
import { LoggerRegistry } from "../src/services/logging/LoggerRegistry.js";
import { normalizeLoggerConfig } from "../src/services/logging/normalizeLoggingConfig.js";
import { LogRetentionJob } from "../src/services/scheduler/jobs/LogRetentionJob.js";
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

const entry = (message) => ({
  timestamp: time.timestamp(),
  level: "info",
  event: "test.entry",
  message,
  context: {}
});

// --- writer 這一層 -----------------------------------------------------------

test("runCleanup removes expired files without any log being written", async (t) => {
  const { writer, directory } = await writerWithExpiredFile(t);

  // 完全沒有 write()——這正是先前永遠清不掉的情況。
  await writer.runCleanup();

  assert.deepEqual(await readdir(directory), []);
});

test("cleanup and writes share one queue, so the write target stays consistent", async (t) => {
  const { writer, directory } = await writerWithExpiredFile(t);

  // 兩者都會動到 this.target；不排隊的話，寫入可能落到一個已被清掉的檔案上。
  await Promise.all([
    writer.write(entry("first")),
    writer.runCleanup(),
    writer.write(entry("second"))
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

test("a write still triggers cleanup, so no scheduler is not no cleanup", async (t) => {
  const { writer, directory } = await writerWithExpiredFile(t);

  // 活動觸發的路徑刻意保留：排程器不存在時，清理能力不該跟著消失。
  await writer.write(entry("only write"));
  await writer.flush();

  assert.equal(
    (await readdir(directory)).includes("test-2020-01-01.log"),
    false
  );
});

test("a disabled logger has no writer and cleanup is a no-op", async () => {
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

test("the registry fans cleanup out to every profile", async () => {
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

// --- job 這一層 --------------------------------------------------------------

function createJob() {
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
  const job = new LogRetentionJob({
    config: {},
    services: { require: (name) => ({ logging, scheduler })[name] }
  });

  return { job, cleaned, registered };
}

test("the job submits itself and its declaration is complete", async () => {
  const { job, registered } = createJob();

  await job.initialize();

  // Push 模式：job 自己提交，排程器不走訪容器。
  assert.deepEqual(registered, [job]);

  const [declared] = LogRetentionJob.jobs;
  assert.equal(declared.name, "logging.retentionCleanup");
  // method 是字串形式的方法參照，沒有工具檢查得到，所以至少測它存在。
  assert.equal(typeof job[declared.method], "function");
  // 日誌檔在各自的本機磁碟上，每個實例都得清自己的。
  assert.equal(declared.scope, undefined, "預設就是 instance scope");
});

test("running the job cleans every logger profile", async () => {
  const { job, cleaned } = createJob();

  await job.run();

  assert.deepEqual(cleaned, ["all"]);
});

test("the job is an ordinary service, so it can be triggered by hand", async () => {
  // 它被注入到別處時就是一個普通 service，例如做一個「立即清理」的管理接口。
  assert.equal(LogRetentionJob.service.name, "job.logRetention");
  assert.equal(LogRetentionJob.service.lifecycle, "singleton");
  // 依賴照常宣告，容器因此保證排程器先建立——收集時機的問題根本不存在。
  assert.deepEqual(LogRetentionJob.service.dependencies, ["scheduler", "logging"]);

  const { job, cleaned } = createJob();
  await job.run();
  assert.deepEqual(cleaned, ["all"]);
});

test("the job is discovered by the ordinary service mechanism", async () => {
  const { discoverServiceDefinitions } = await import(
    "../src/framework/services/serviceDiscovery.js"
  );
  const definitions = await discoverServiceDefinitions();
  const found = definitions.find(({ name }) => name === "job.logRetention");

  // jobs/ 是放置慣例而不是新的發現機制：它就在 src/services/ 底下，所以
  // 既有的掃描本來就會找到它。
  assert.ok(found, "jobs/ 底下的 job 應由既有的 service 自發現載入");
  assert.match(found.moduleUrl, /services\/scheduler\/jobs\/LogRetentionJob\.js$/);
});
