import assert from "node:assert/strict";
import test from "node:test";
import { MySqlJobStatsStore } from "../src/services/scheduler/JobStatsStore.js";
import { JobStatsFlushJob } from "../src/services/scheduler/jobs/JobStatsFlushJob.js";
import { MAX_STATS_ERROR_LENGTH } from "../src/services/scheduler/SchedulerService.js";
import { normalizeSchedulerConfig } from "../src/services/scheduler/normalizeSchedulerConfig.js";
import {
  collectingLogger,
  createScheduler,
  fakeLeaseStore,
  jobService
} from "../test-support/schedulerHarness.js";

// 統計原本只活在記憶體裡，沒有任何輸出管道。這個檔案測的是那條管道的三段：
// 排程器記下了什麼、寫進資料庫的是什麼、以及發佈失敗時會不會拖垮應用。

// --- 排程器記錄的內容 ---------------------------------------------------------

test("a completed run records when it started, finished and succeeded", async () => {
  const service = jobService(
    [{ name: "demo.tick", method: "work", intervalMs: 1000, timeoutMs: 500 }],
    () => {}
  );
  const { scheduler, timers } = createScheduler({
    jobs: { demo: service },
    random: () => 0
  });

  await scheduler.start();
  await timers.advance(800);

  const [job] = scheduler.statsSnapshot().jobs;
  assert.equal(job.name, "demo.tick");
  assert.equal(job.lastOutcome, "succeeded");
  assert.equal(job.lastStartedAt, 800);
  assert.equal(job.lastFinishedAt, 800);
  assert.equal(job.lastSuccessAt, 800);
  assert.equal(job.lastDurationMs, 0);
  assert.equal(job.lastError, null);
  assert.equal(job.runs, 1);

  await scheduler.stop();
});

test("a run in progress reports running, not the previous run's finish time", async () => {
  let release;
  let first = true;
  const service = jobService(
    [{ name: "demo.slow", method: "work", intervalMs: 1000, timeoutMs: 100_000 }],
    () => {
      if (first) {
        first = false;
        return undefined;
      }

      return new Promise((resolve) => {
        release = resolve;
      });
    }
  );
  const { scheduler, timers } = createScheduler({
    jobs: { demo: service },
    random: () => 0
  });

  await scheduler.start();
  await timers.advance(800);
  assert.equal(scheduler.statsSnapshot().jobs[0].lastFinishedAt, 800);

  // 第二輪卡住。留著上一輪的完成時間會讓讀的人以為那是這一輪的結果。
  await timers.advance(1000);
  const [job] = scheduler.statsSnapshot().jobs;
  assert.equal(job.lastOutcome, "running");
  assert.equal(job.lastStartedAt, 1800);
  assert.equal(job.lastFinishedAt, null);
  assert.equal(job.lastDurationMs, null);
  // 但「上一次成功」不受影響——那正是判斷嚴重程度要看的東西。
  assert.equal(job.lastSuccessAt, 800);

  release();
  await scheduler.stop();
});

test("a failed run keeps the last success time and records the error", async () => {
  let attempts = 0;
  const service = jobService(
    [{ name: "demo.tick", method: "work", intervalMs: 1000, timeoutMs: 500 }],
    () => {
      attempts += 1;

      if (attempts > 1) {
        throw new Error("job exploded");
      }
    }
  );
  const { scheduler, timers } = createScheduler({
    jobs: { demo: service },
    random: () => 0
  });

  await scheduler.start();
  await timers.advance(800);
  await timers.advance(1000);

  const [job] = scheduler.statsSnapshot().jobs;
  assert.equal(job.lastOutcome, "failed");
  assert.equal(job.lastError, "Error: job exploded");
  assert.equal(job.lastFinishedAt, 1800);
  // 「多久沒成功過」是計數器答不出來的問題。
  assert.equal(job.lastSuccessAt, 800);
  assert.equal(job.consecutiveFailures, 1);

  await scheduler.stop();
});

test("a timed out run is distinguishable from a plain failure", async () => {
  const service = jobService(
    [{ name: "demo.hang", method: "work", intervalMs: 10_000, timeoutMs: 500 }],
    (signal) =>
      new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason));
      })
  );
  const { scheduler, timers } = createScheduler({
    jobs: { demo: service },
    random: () => 0
  });

  await scheduler.start();
  await timers.advance(8000);
  await timers.advance(500);

  const [job] = scheduler.statsSnapshot().jobs;
  // 壓成「異常」等於丟掉這個工作階段最有診斷價值的一項區別。
  assert.equal(job.lastOutcome, "timedOut");
  assert.equal(job.lastDurationMs, 500);
  assert.match(job.lastError, /exceeded 500ms/);

  await scheduler.stop();
});

test("a lease failure is recorded as an attempt, not as silence", async () => {
  const service = jobService([
    { name: "demo.cluster", method: "work", scope: "cluster", intervalMs: 1000, timeoutMs: 500 }
  ]);
  const leaseStore = fakeLeaseStore();
  leaseStore.acquire = async () => {
    throw new Error("connect ECONNREFUSED");
  };
  const { scheduler, timers } = createScheduler({
    jobs: { demo: service },
    leaseStore,
    random: () => 0
  });

  await scheduler.start();
  await timers.advance(800);

  const [job] = scheduler.statsSnapshot().jobs;
  // 資料庫壞掉時，症狀不該只剩下「runs 停止增加」。
  assert.equal(job.lastOutcome, "leaseFailed");
  assert.equal(job.lastError, "Error: connect ECONNREFUSED");
  assert.equal(job.failures, 1);
  assert.equal(job.runs, 0);

  await scheduler.stop();
});

test("skipping a run does not overwrite the last real run", async () => {
  const service = jobService(
    [{ name: "demo.cluster", method: "work", scope: "cluster", intervalMs: 1000, timeoutMs: 500 }],
    () => {}
  );
  let grant = true;
  const { scheduler, timers } = createScheduler({
    jobs: { demo: service },
    leaseStore: fakeLeaseStore({ grantTo: () => grant }),
    random: () => 0
  });

  await scheduler.start();
  await timers.advance(800);
  assert.equal(scheduler.statsSnapshot().jobs[0].lastOutcome, "succeeded");

  // 之後每一輪都是別的實例當 leader。
  grant = false;
  await timers.advance(3000);

  const [job] = scheduler.statsSnapshot().jobs;
  // 把 skippedNotLeader 寫進 lastOutcome 會讓非 leader 的實例看起來一直在動，
  // 同時抹掉它上一次真正執行的紀錄。計數器已經表達了這件事。
  assert.equal(job.lastOutcome, "succeeded");
  assert.equal(job.lastFinishedAt, 800);
  assert.equal(job.skippedNotLeader, 3);

  await scheduler.stop();
});

test("an overlapping skip does not overwrite the in-progress state either", async () => {
  let release;
  const service = jobService(
    [{ name: "demo.slow", method: "work", intervalMs: 1000, timeoutMs: 100_000 }],
    () => new Promise((resolve) => { release = resolve; })
  );
  const { scheduler, timers } = createScheduler({
    jobs: { demo: service },
    random: () => 0
  });

  await scheduler.start();
  await timers.advance(800);
  await timers.advance(1000);

  const [job] = scheduler.statsSnapshot().jobs;
  assert.equal(job.skippedOverlapping, 1);
  assert.equal(job.lastOutcome, "running");
  assert.equal(job.lastStartedAt, 800);

  release();
  await scheduler.stop();
});

test("a long error message is truncated to the column width", async () => {
  const service = jobService(
    [{ name: "demo.tick", method: "work", intervalMs: 1000, timeoutMs: 500 }],
    () => {
      throw new Error("x".repeat(2000));
    }
  );
  const { scheduler, timers } = createScheduler({
    jobs: { demo: service },
    random: () => 0
  });

  await scheduler.start();
  await timers.advance(800);

  const [job] = scheduler.statsSnapshot().jobs;
  // 記憶體裡的統計沒有理由無界成長，而截斷在來源做，兩邊就不會不一致。
  assert.equal(job.lastError.length, MAX_STATS_ERROR_LENGTH);
  assert.ok(job.lastError.endsWith("…"));

  await scheduler.stop();
});

test("the snapshot leaves out jobs that will never run", async () => {
  const active = jobService([
    { name: "demo.active", method: "work", intervalMs: 1000, timeoutMs: 500 }
  ]);
  const idle = jobService([
    { name: "demo.idle", method: "work", intervalMs: 1000, timeoutMs: 500 }
  ]);
  const { scheduler } = createScheduler({
    jobs: { active, idle },
    config: { jobs: { "demo.idle": { enabled: false } } }
  });

  // 「停用」與「啟用但還沒跑過」在一列資料上長得一模一樣，所以停用的不放進來；
  // 啟動日誌已經完整列出過工作清單了。
  assert.deepEqual(
    scheduler.statsSnapshot().jobs.map(({ name }) => name),
    ["demo.active"]
  );
});

test("the snapshot carries the same instance identity as the job leases", async () => {
  const service = jobService([
    { name: "demo.tick", method: "work", intervalMs: 1000, timeoutMs: 500 }
  ]);
  const { scheduler } = createScheduler({ jobs: { demo: service } });
  const snapshot = scheduler.statsSnapshot();

  // instance_id = fr_job_leases.owner，所以「誰持有租約」與「誰真的跑了」
  // 可以直接對照。
  assert.equal(snapshot.owner, scheduler.owner);
  assert.ok(snapshot.owner.startsWith(`${snapshot.host}:`));
});

// --- MySQL store --------------------------------------------------------------

function fakeStatsDatabase({ execute } = {}) {
  const calls = [];
  return {
    calls,
    execute: async (sql, params) => {
      calls.push({ sql, params });
      return execute ? execute(sql, params) : [{ affectedRows: 0 }];
    }
  };
}

function statsRow(overrides = {}) {
  return {
    instanceId: "host-a:11:abcd",
    jobName: "demo.tick",
    host: "host-a",
    address: "10.0.0.7",
    scope: "instance",
    lastStartedAt: 1000,
    lastFinishedAt: 1200,
    lastSuccessAt: 1200,
    lastOutcome: "succeeded",
    lastDurationMs: 200,
    lastError: null,
    runs: 4,
    failures: 1,
    timeouts: 0,
    skippedOverlapping: 0,
    skippedNotLeader: 2,
    consecutiveFailures: 0,
    ...overrides
  };
}

test("the store requires the database service", () => {
  assert.throws(() => new MySqlJobStatsStore({}), /requires the mysqldatabase service/);
  assert.throws(
    () => new MySqlJobStatsStore({ database: { query: async () => {} } }),
    /requires the mysqldatabase service/
  );
});

test("writing upserts one row per job and stamps the database clock", async () => {
  const database = fakeStatsDatabase();
  const store = new MySqlJobStatsStore({ database });

  await store.write([statsRow(), statsRow({ jobName: "demo.other" })]);

  assert.equal(database.calls.length, 2);
  const [first] = database.calls;
  assert.match(first.sql, /INSERT INTO fr_job_stats/);
  // 一列代表「現在是什麼狀態」，不是一筆歷史，所以重複寫入同一列。
  assert.match(first.sql, /ON DUPLICATE KEY UPDATE/);
  // updated_at 一律取資料庫時鐘，否則跨實例的過期判斷會受時鐘偏移影響。
  assert.match(first.sql, /UNIX_TIMESTAMP\(\)\)/);
  assert.equal(first.sql.includes("?, UNIX_TIMESTAMP()"), true);
  assert.deepEqual(first.params.slice(0, 5), [
    "host-a:11:abcd",
    "demo.tick",
    "host-a",
    "10.0.0.7",
    "instance"
  ]);
  assert.equal(first.params.length, 17);
  assert.equal(database.calls[1].params[1], "demo.other");
});

test("every column the write sends is also assigned on conflict", async () => {
  const database = fakeStatsDatabase();
  await new MySqlJobStatsStore({ database }).write([statsRow()]);

  const [, insertColumns] = /INSERT INTO fr_job_stats \(([^)]+)\)/.exec(database.calls[0].sql);
  const columns = insertColumns
    .split(",")
    .map((column) => column.trim())
    .filter(Boolean);
  const updateClause = database.calls[0].sql.split("ON DUPLICATE KEY UPDATE")[1];

  // 加了欄位卻忘了加進 UPDATE 子句，第一次寫入會是對的，之後那一欄就永遠凍結
  // 在初值——而它看起來完全正常。
  for (const column of columns.filter((name) => name !== "instance_id" && name !== "job_name")) {
    assert.match(
      updateClause,
      new RegExp(`${column} = VALUES\\(${column}\\)`),
      `${column} 沒有在衝突時更新`
    );
  }
});

test("a missing table points at the SQL file that creates it", async () => {
  const database = fakeStatsDatabase({
    execute: async () => {
      throw Object.assign(new Error("MySQL database execute failed"), {
        cause: Object.assign(new Error("no such table"), { code: "ER_NO_SUCH_TABLE" })
      });
    }
  });

  await assert.rejects(
    () => new MySqlJobStatsStore({ database }).write([statsRow()]),
    /Table "fr_job_stats" does not exist\. Run server\/database\/framework\/scheduler\.sql/
  );
});

test("purging stale rows uses the database clock and reports what it removed", async () => {
  const database = fakeStatsDatabase({ execute: async () => [{ affectedRows: 3 }] });
  const store = new MySqlJobStatsStore({ database });

  assert.equal(await store.purgeStale(900_000), 3);
  assert.match(database.calls[0].sql, /updated_at <= UNIX_TIMESTAMP\(\) - \?/);
  assert.deepEqual(database.calls[0].params, [900]);
});

test("a sub-second staleness window still keeps rows written this second", async () => {
  const database = fakeStatsDatabase();
  await new MySqlJobStatsStore({ database }).purgeStale(0);

  // 0 秒會把剛寫好的列一起刪掉，然後下一輪又寫回來——永遠在原地打轉。
  assert.deepEqual(database.calls[0].params, [1]);
});

test("deleting an instance touches only that instance's rows", async () => {
  const database = fakeStatsDatabase();
  await new MySqlJobStatsStore({ database }).deleteInstance("host-a:11:abcd");

  // 這是整個設計裡最要緊的一句 SQL：沒有 WHERE 的話，滾動重啟就是讓每個實例
  // 輪流抹掉同儕正在用的列。
  assert.match(database.calls[0].sql, /DELETE FROM fr_job_stats WHERE instance_id = \?/);
  assert.deepEqual(database.calls[0].params, ["host-a:11:abcd"]);
});

test("the base store is a no-op an adapter may only partly implement", async () => {
  const { JobStatsStore } = await import("../src/services/scheduler/JobStatsStore.js");
  const store = new JobStatsStore();

  await store.write([statsRow()]);
  await store.deleteInstance("x");
  await store.close();
  assert.equal(await store.purgeStale(1000), 0);
});

// --- 發佈工作 ------------------------------------------------------------------

function fakeStatsStore({ write, purgeStale, deleteInstance } = {}) {
  const calls = [];
  return {
    calls,
    async write(rows) {
      calls.push({ type: "write", rows });
      return write?.(rows);
    },
    async purgeStale(staleAfterMs) {
      calls.push({ type: "purgeStale", staleAfterMs });
      return purgeStale ? purgeStale(staleAfterMs) : 0;
    },
    async deleteInstance(instanceId) {
      calls.push({ type: "deleteInstance", instanceId });
      return deleteInstance?.(instanceId);
    }
  };
}

async function createFlushJob({ stats = {}, jobs = {}, store = fakeStatsStore() } = {}) {
  const logger = collectingLogger();
  const harness = createScheduler({ config: { stats, jobs }, logger });
  const schedulerConfig = normalizeSchedulerConfig({ stats, jobs });
  const flush = new JobStatsFlushJob({
    config: { scheduler: schedulerConfig },
    services: {
      require: (name) =>
        ({
          scheduler: harness.scheduler,
          logging: { logger },
          mysqldatabase: { execute: async () => [{}] }
        })[name]
    },
    options: { store }
  });
  await flush.initialize();
  return { ...harness, flush, store, logger };
}

test("a flush publishes one row per job and logs a summary", async () => {
  const { flush, scheduler, store, logger } = await createFlushJob();

  await flush.run();

  const write = store.calls.find((call) => call.type === "write");
  assert.deepEqual(
    write.rows.map(({ jobName }) => jobName),
    ["scheduler.statsFlush"]
  );
  assert.equal(write.rows[0].instanceId, scheduler.owner);
  assert.equal(write.rows[0].scope, "instance");

  const summary = logger.entries.find((entry) => entry.event === "scheduler.stats");
  assert.equal(summary.level, "info");
  assert.equal(summary.context.instanceId, scheduler.owner);
  assert.equal(summary.context.jobs.length, 1);
});

test("the summary log survives a store that cannot be written", async () => {
  const store = fakeStatsStore({
    write: () => {
      throw new Error("connect ECONNREFUSED");
    }
  });
  const { flush, logger } = await createFlushJob({ store });

  await flush.run();

  // 表寫不進去時，日誌是唯一還在的輸出管道，所以它必須先寫、而且不依賴資料庫。
  assert.ok(logger.entries.some((entry) => entry.event === "scheduler.stats"));
  const warning = logger.entries.find(
    (entry) => entry.event === "scheduler.stats.publish_failed"
  );
  assert.equal(warning.level, "warn");
  assert.equal(warning.context.error.message, "connect ECONNREFUSED");
});

test("a failed publish is not retried every tick", async () => {
  let attempts = 0;
  const store = fakeStatsStore({
    write: () => {
      attempts += 1;
      throw new Error("still broken");
    }
  });
  const { flush, logger } = await createFlushJob({ store });

  await flush.run();
  await flush.run();
  await flush.run();

  // 診斷資料壞掉不該變成每五分鐘對著同一個壞掉的表再撞一次。
  assert.equal(attempts, 1);
  assert.equal(
    logger.entries.filter((entry) => entry.event === "scheduler.stats.publish_failed").length,
    1
  );
  // 但彙總日誌照常輸出。
  assert.equal(logger.entries.filter((entry) => entry.event === "scheduler.stats").length, 3);
});

test("repeated failures escalate the summary from info to error", async () => {
  const { flush, scheduler, logger } = await createFlushJob({
    stats: { consecutiveFailureAlertThreshold: 2 }
  });
  const stats = scheduler.stats.get("scheduler.statsFlush");

  stats.consecutiveFailures = 1;
  await flush.run();
  assert.equal(logger.entries.at(-1).event, "scheduler.stats");

  stats.consecutiveFailures = 2;
  stats.lastOutcome = "failed";
  stats.lastError = "Error: nope";
  await flush.run();

  // 表是被動的，得有人去查才看得到。這一行才會叫醒人。
  const alert = logger.entries.find((entry) => entry.event === "scheduler.stats.jobs_failing");
  assert.equal(alert.level, "error");
  assert.deepEqual(alert.context.failingJobs, [
    {
      job: "scheduler.statsFlush",
      consecutiveFailures: 2,
      lastOutcome: "failed",
      lastError: "Error: nope"
    }
  ]);
});

test("the staleness window follows the configured flush interval", async () => {
  const { flush } = await createFlushJob({
    stats: { staleAfterRuns: 4 },
    jobs: { "scheduler.statsFlush": { intervalMs: 60_000 } }
  });

  // 寫死毫秒的話，把間隔調大就會讓還活著的實例被自己的清理刪掉。
  assert.equal(flush.staleAfterMs(), 240_000);
  await flush.run();
  assert.equal(
    flush.store.calls.find((call) => call.type === "purgeStale").staleAfterMs,
    240_000
  );
});

test("rows left behind by a dead instance are removed and reported", async () => {
  const store = fakeStatsStore({ purgeStale: () => 2 });
  const { flush, logger } = await createFlushJob({ store });

  await flush.run();

  const entry = logger.entries.find(
    (candidate) => candidate.event === "scheduler.stats.stale_removed"
  );
  assert.equal(entry.context.removedRows, 2);
  assert.equal(entry.context.staleAfterMs, 900_000);
});

test("a quiet flush does not log about stale rows it never removed", async () => {
  const { flush, logger } = await createFlushJob();
  await flush.run();

  assert.equal(
    logger.entries.some((entry) => entry.event === "scheduler.stats.stale_removed"),
    false
  );
});

test("shutdown removes this instance's rows and nobody else's", async () => {
  const { flush, scheduler, store } = await createFlushJob();

  await flush.run();
  await flush.shutdown();

  const removal = store.calls.filter((call) => call.type === "deleteInstance");
  assert.deepEqual(removal, [{ type: "deleteInstance", instanceId: scheduler.owner }]);
});

test("a shutdown that cannot clean up warns instead of blocking the shutdown", async () => {
  const store = fakeStatsStore({
    deleteInstance: () => {
      throw new Error("pool is closed");
    }
  });
  const { flush, logger } = await createFlushJob({ store });

  // 關機路徑上拋錯會擋住後面的 service；留下的列會自然過期。
  await flush.shutdown();

  const warning = logger.entries.find(
    (entry) => entry.event === "scheduler.stats.cleanup_failed"
  );
  assert.equal(warning.level, "warn");
});

// --- 設定 ----------------------------------------------------------------------

test("the stats block has working defaults", () => {
  const { stats } = normalizeSchedulerConfig({});

  assert.deepEqual(stats, {
    address: "",
    staleAfterRuns: 3,
    consecutiveFailureAlertThreshold: 3
  });
});

test("a staleness window of one run is rejected", () => {
  // 排程有抖動、資料庫偶爾慢一下，錯過一輪就當你死了會讓活著的實例被反覆刪掉
  // 又寫回來。
  assert.throws(
    () => normalizeSchedulerConfig({ stats: { staleAfterRuns: 1 } }),
    /must be at least 2/
  );
  assert.throws(
    () => normalizeSchedulerConfig({ stats: { staleAfterRuns: 0 } }),
    /must be a positive integer/
  );
  assert.equal(normalizeSchedulerConfig({ stats: { staleAfterRuns: 2 } }).stats.staleAfterRuns, 2);
});

test("the stats block rejects values the table cannot hold", () => {
  assert.throws(
    () => normalizeSchedulerConfig({ stats: { address: "x".repeat(65) } }),
    /at most 64 characters/
  );
  assert.throws(() => normalizeSchedulerConfig({ stats: [] }), /"stats" must be an object/);
  assert.throws(
    () => normalizeSchedulerConfig({ stats: { consecutiveFailureAlertThreshold: 0 } }),
    /consecutiveFailureAlertThreshold" must be a positive integer/
  );
});
