import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSchedulerConfig } from "../src/services/scheduler/normalizeSchedulerConfig.js";
import {
  createScheduler,
  fakeLeaseStore,
  jobService
} from "../test-support/schedulerHarness.js";


// --- 基本排程 ----------------------------------------------------------------

test("a job runs on its interval, and the first run is jittered", async () => {
  const service = jobService([
    { name: "demo.tick", method: "work", intervalMs: 1000, timeoutMs: 200 }
  ]);
  const { scheduler, timers } = createScheduler({
    jobs: { demo: service },
    random: () => 0
  });

  await scheduler.start();

  // startupJitterRatio 0.2、random 0 → 首次延遲 = 1000 - 200 = 800ms
  await timers.advance(799);
  assert.equal(service.calls.length, 0);
  await timers.advance(1);
  assert.equal(service.calls.length, 1);

  // 之後回到固定間隔。
  await timers.advance(1000);
  assert.equal(service.calls.length, 2);
  await timers.advance(1000);
  assert.equal(service.calls.length, 3);

  await scheduler.stop();
});

test("jitter always lands inside the interval and runOnStart skips it", async () => {
  for (const value of [0, 0.5, 0.999]) {
    const service = jobService([
      { name: "demo.tick", method: "work", intervalMs: 1000, timeoutMs: 100 }
    ]);
    const { scheduler, timers } = createScheduler({
      jobs: { demo: service },
      random: () => value
    });
    await scheduler.start();

    await timers.advance(799);
    const before = service.calls.length;
    await timers.advance(201);

    assert.equal(before, 0, `random=${value} 的首次執行不應早於 800ms`);
    assert.equal(service.calls.length, 1, `random=${value} 的首次執行不應晚於 1000ms`);
    await scheduler.stop();
  }

  const eager = jobService([
    { name: "demo.now", method: "work", intervalMs: 1000, timeoutMs: 100, runOnStart: true }
  ]);
  const { scheduler, timers } = createScheduler({ jobs: { demo: eager } });
  await scheduler.start();

  // runOnStart 代表「現在就跑一次」，不套抖動。
  await timers.advance(0);
  assert.equal(eager.calls.length, 1);
  await scheduler.stop();
});

test("a disabled job is never scheduled", async () => {
  const service = jobService([
    { name: "demo.tick", method: "work", intervalMs: 1000, timeoutMs: 100 }
  ]);
  const { scheduler, timers } = createScheduler({
    jobs: { demo: service },
    config: { jobs: { "demo.tick": { enabled: false } } }
  });

  await scheduler.start();
  await timers.advance(10_000);

  assert.equal(service.calls.length, 0);
  assert.equal(scheduler.describeJobs()[0].enabled, false);
  await scheduler.stop();
});

test("a disabled scheduler still reports the jobs it skipped", async () => {
  const service = jobService([
    { name: "demo.tick", method: "work", intervalMs: 1000, timeoutMs: 100 }
  ]);
  const { scheduler, timers, logger } = createScheduler({
    jobs: { demo: service },
    config: { enabled: false }
  });

  await scheduler.start();
  await timers.advance(10_000);

  assert.equal(service.calls.length, 0);
  // 「背景工作為什麼沒跑」不該需要翻原始碼。
  const entry = logger.entries.find((candidate) => candidate.event === "scheduler.disabled");
  assert.ok(entry);
  assert.deepEqual(entry.context.jobs.map(({ name }) => name), ["demo.tick"]);
});

test("config overrides the interval declared in static jobs", async () => {
  const service = jobService([
    { name: "demo.tick", method: "work", intervalMs: 10_000, timeoutMs: 100 }
  ]);
  const { scheduler, timers } = createScheduler({
    jobs: { demo: service },
    config: { jobs: { "demo.tick": { intervalMs: 1000 } } },
    random: () => 0
  });

  await scheduler.start();
  await timers.advance(800);

  assert.equal(service.calls.length, 1);
  assert.equal(scheduler.describeJobs()[0].intervalMs, 1000);
  await scheduler.stop();
});

// --- 失敗與重疊 --------------------------------------------------------------

test("a job that throws is logged and keeps its schedule", async () => {
  let attempts = 0;
  const service = jobService(
    [{ name: "demo.tick", method: "work", intervalMs: 1000, timeoutMs: 500 }],
    () => {
      attempts += 1;

      if (attempts <= 2) {
        throw new Error("job exploded");
      }
    }
  );
  const { scheduler, timers, logger } = createScheduler({
    jobs: { demo: service },
    random: () => 0
  });

  await scheduler.start();
  await timers.advance(800);
  await timers.advance(1000);

  const failures = logger.entries.filter(
    (candidate) => candidate.event === "scheduler.job.failed"
  );
  assert.equal(failures.length, 2);
  // 連續失敗要累計，否則「壞了三天沒人發現」是可能的。
  assert.equal(failures[1].context.consecutiveFailures, 2);

  // 排程沒有因為失敗而中斷。
  await timers.advance(1000);
  assert.equal(attempts, 3);
  assert.equal(scheduler.stats.get("demo.tick").consecutiveFailures, 0);

  await scheduler.stop();
});

test("a run still in progress causes the next tick to be skipped, not stacked", async () => {
  let release;
  const service = jobService(
    [{ name: "demo.slow", method: "work", intervalMs: 1000, timeoutMs: 100_000 }],
    () => new Promise((resolve) => { release = resolve; })
  );
  const { scheduler, timers, logger } = createScheduler({
    jobs: { demo: service },
    random: () => 0
  });

  await scheduler.start();
  await timers.advance(800);
  assert.equal(service.calls.length, 1);

  // 三輪都撞上還沒結束的那一次。
  await timers.advance(3000);
  assert.equal(service.calls.length, 1, "不得堆疊出第二次並行執行");
  assert.equal(scheduler.stats.get("demo.slow").skippedOverlapping, 3);
  assert.equal(
    logger.entries.filter((c) => c.event === "scheduler.job.overlapping").length,
    3
  );

  release();
  await timers.advance(1000);
  assert.equal(service.calls.length, 2, "前一輪結束後應恢復正常");

  // 這個工作刻意不理會中止訊號，收尾時先讓第二輪結束，否則 stop() 會等到它的
  // 逾時退路——而那個退路用的是假計時器，沒人推進就永遠不會到。
  release();
  await timers.advance(0);
  await scheduler.stop();
});

test("a job that exceeds its timeout is aborted and reported", async () => {
  let observed = null;
  const service = jobService(
    [{ name: "demo.hang", method: "work", intervalMs: 10_000, timeoutMs: 500 }],
    (signal) =>
      new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => {
          observed = signal.reason;
          reject(signal.reason);
        });
      })
  );
  const { scheduler, timers, logger } = createScheduler({
    jobs: { demo: service },
    random: () => 0
  });

  await scheduler.start();
  await timers.advance(8000);
  await timers.advance(500);

  assert.match(observed?.message ?? "", /exceeded 500ms/);
  const entry = logger.entries.find((c) => c.event === "scheduler.job.failed");
  assert.equal(entry.context.timedOut, true);
  assert.equal(scheduler.stats.get("demo.hang").timeouts, 1);

  await scheduler.stop();
});

// --- cluster 範圍 -------------------------------------------------------------

test("a cluster job only runs on the instance that holds the lease", async () => {
  const service = jobService([
    { name: "demo.cluster", method: "work", intervalMs: 1000, timeoutMs: 200, scope: "cluster" }
  ]);
  const leaseStore = fakeLeaseStore({ grantTo: () => true });
  const { scheduler, timers } = createScheduler({
    jobs: { demo: service },
    leaseStore,
    random: () => 0
  });

  await scheduler.start();
  assert.deepEqual(leaseStore.prepared, ["demo.cluster"], "cluster 工作要先預建列");

  await timers.advance(800);

  assert.equal(service.calls.length, 1);
  // 執行完要釋放，下一輪才能由任何實例接手。
  assert.deepEqual(
    leaseStore.calls.map(({ type }) => type),
    ["acquire", "release"]
  );
  assert.equal(leaseStore.calls[0].owner, leaseStore.calls[1].owner);

  await scheduler.stop();
});

test("an instance without the lease skips the run entirely", async () => {
  const service = jobService([
    { name: "demo.cluster", method: "work", intervalMs: 1000, timeoutMs: 200, scope: "cluster" }
  ]);
  const leaseStore = fakeLeaseStore({ grantTo: () => false });
  const { scheduler, timers } = createScheduler({
    jobs: { demo: service },
    leaseStore,
    random: () => 0
  });

  await scheduler.start();
  await timers.advance(2800);

  assert.equal(service.calls.length, 0);
  assert.equal(scheduler.stats.get("demo.cluster").skippedNotLeader, 3);
  // 沒拿到租約是正常運作，不該釋放別人的租約。
  assert.equal(leaseStore.calls.some(({ type }) => type === "release"), false);

  await scheduler.stop();
});

test("a lease store failure is reported and does not run the job", async () => {
  const service = jobService([
    { name: "demo.cluster", method: "work", intervalMs: 1000, timeoutMs: 200, scope: "cluster" }
  ]);
  const leaseStore = {
    async prepare() {},
    async acquire() {
      throw new Error("database is unreachable");
    },
    async release() {}
  };
  const { scheduler, timers, logger } = createScheduler({
    jobs: { demo: service },
    leaseStore,
    random: () => 0
  });

  await scheduler.start();
  await timers.advance(800);

  assert.equal(service.calls.length, 0);
  const entry = logger.entries.find((c) => c.event === "scheduler.lease.failed");
  assert.ok(entry, "取租約失敗必須留下記錄");
  assert.equal(entry.context.error.message, "database is unreachable");

  await scheduler.stop();
});

test("a slow lease acquisition reserves the running slot immediately, so a second tick cannot re-issue acquire()", async () => {
  let releaseAcquire;
  const acquireCalls = [];
  const leaseStore = {
    async prepare() {},
    acquire(jobName, options) {
      acquireCalls.push({ jobName, owner: options.owner });
      return new Promise((resolve) => {
        releaseAcquire = resolve;
      });
    },
    async release() {}
  };
  const service = jobService([
    { name: "demo.cluster", method: "work", intervalMs: 1000, timeoutMs: 100_000, scope: "cluster" }
  ]);
  const { scheduler, timers } = createScheduler({
    jobs: { demo: service },
    leaseStore,
    random: () => 0
  });

  await scheduler.start();
  await timers.advance(800);
  assert.equal(acquireCalls.length, 1, "首次執行應該呼叫 acquire()");

  // 第一輪的 acquire() 還沒 resolve，下一輪 tick 已經到了。
  await timers.advance(1000);
  assert.equal(acquireCalls.length, 1, "running 佔位必須在 acquire() 還沒 resolve 前就擋住下一輪");
  assert.equal(scheduler.stats.get("demo.cluster").skippedOverlapping, 1);

  releaseAcquire(true);
  await timers.advance(0);
  assert.equal(service.calls.length, 1, "租約終於拿到之後，工作應該正常執行一次");

  await scheduler.stop();
});

test("a lease acquisition that exceeds the job timeout is aborted and reported, without running the job", async () => {
  const acquireCalls = [];
  const leaseStore = {
    async prepare() {},
    acquire(jobName, options) {
      acquireCalls.push({ jobName, owner: options.owner });
      return new Promise(() => {}); // 模擬卡住、永遠不 resolve 的租約查詢
    },
    async release() {}
  };
  const service = jobService([
    { name: "demo.cluster", method: "work", intervalMs: 10_000, timeoutMs: 500, scope: "cluster" }
  ]);
  const { scheduler, timers, logger } = createScheduler({
    jobs: { demo: service },
    leaseStore,
    random: () => 0
  });

  await scheduler.start();
  await timers.advance(8000);
  assert.equal(acquireCalls.length, 1);
  await timers.advance(500);

  assert.equal(service.calls.length, 0, "拿不到租約，工作本身不該執行");
  const entry = logger.entries.find((c) => c.event === "scheduler.lease.timeout");
  assert.ok(entry, "租約取得逾時必須留下記錄");
  assert.equal(entry.context.job, "demo.cluster");
  const stats = scheduler.stats.get("demo.cluster");
  assert.equal(stats.timeouts, 1);
  assert.equal(stats.lastOutcome, "leaseTimedOut");

  await scheduler.stop();
});

test("instance-scoped jobs never touch the lease store", async () => {
  const service = jobService([
    { name: "demo.local", method: "work", intervalMs: 1000, timeoutMs: 200 }
  ]);
  const leaseStore = fakeLeaseStore();
  const { scheduler, timers } = createScheduler({
    jobs: { demo: service },
    leaseStore,
    random: () => 0
  });

  await scheduler.start();
  await timers.advance(1800);

  assert.equal(service.calls.length, 2);
  assert.deepEqual(leaseStore.calls, []);
  assert.deepEqual(leaseStore.prepared, []);

  await scheduler.stop();
});

// --- 關機 ---------------------------------------------------------------------

test("stop clears timers, aborts in-flight work and is idempotent", async () => {
  let aborted = false;
  const service = jobService(
    [{ name: "demo.slow", method: "work", intervalMs: 1000, timeoutMs: 100_000 }],
    (signal) =>
      new Promise((resolve) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          resolve();
        });
      })
  );
  const { scheduler, timers } = createScheduler({
    jobs: { demo: service },
    random: () => 0
  });

  await scheduler.start();
  await timers.advance(800);
  assert.equal(service.calls.length, 1);

  const first = await scheduler.stop();
  assert.equal(aborted, true, "進行中的工作要收到中止訊號");
  assert.deepEqual(first, { stopped: true, drained: true });

  // 冪等：容器之後還會再呼叫一次 shutdown()。
  assert.deepEqual(await scheduler.stop(), { stopped: true, drained: true });
  await scheduler.shutdown();

  // 停止之後不再排下一輪。
  await timers.advance(10_000);
  assert.equal(service.calls.length, 1);
  assert.equal(timers.pendingCount(), 0);
});

test("stop reports when a job refuses to finish", async () => {
  const service = jobService(
    [{ name: "demo.stuck", method: "work", intervalMs: 1000, timeoutMs: 100_000 }],
    () => new Promise(() => {})
  );
  const { scheduler, timers, logger } = createScheduler({
    jobs: { demo: service },
    random: () => 0
  });

  await scheduler.start();
  await timers.advance(800);

  const stopping = scheduler.stop({ timeoutMs: 1000 });
  await timers.advance(1000);
  const result = await stopping;

  assert.equal(result.drained, false);
  assert.ok(logger.entries.some((c) => c.event === "scheduler.stop.timed_out"));
});

test("every timer is unref'd so background work cannot hold the process open", async () => {
  const service = jobService([
    { name: "demo.tick", method: "work", intervalMs: 1000, timeoutMs: 200 }
  ]);
  const { scheduler, timers } = createScheduler({
    jobs: { demo: service },
    random: () => 0
  });

  await scheduler.start();
  await timers.advance(800);

  // 排程計時器與逾時計時器都要 unref。
  assert.ok(timers.unrefCount() >= 2);
  await scheduler.stop();
});

// --- 宣告驗證 -----------------------------------------------------------------

test("invalid job declarations fail at startup, not on first tick", () => {
  const build = (jobs) => () =>
    createScheduler({ jobs: { demo: jobService(jobs) } });

  // 字串形式的方法參照沒有任何工具檢查得到，只能在啟動時驗證它存在。
  assert.throws(
    build([{ name: "demo.typo", method: "wrok", intervalMs: 1000 }]),
    /refers to method "wrok", which does not exist/
  );
  assert.throws(
    build([{ name: "bad name", method: "work", intervalMs: 1000 }]),
    /invalid job name/
  );
  assert.throws(
    build([{ name: "demo.x", method: "work", intervalMs: 0 }]),
    /intervalMs" must be a positive integer/
  );
  assert.throws(
    build([{ name: "demo.x", method: "work", intervalMs: 1000, scope: "global" }]),
    /invalid scope "global"/
  );

  // timeoutMs 大於 intervalMs 是合法的：逾時是安全上限而不是預期時長，而
  // defaultTimeoutMs 本來就大於多數合理的間隔。真的重疊時由執行期保護處理。
  const { scheduler } = createScheduler({
    jobs: { demo: jobService([{ name: "demo.ok", method: "work", intervalMs: 1000 }]) }
  });
  assert.equal(scheduler.describeJobs()[0].timeoutMs, 30000);
});

test("registering without static jobs fails loudly", () => {
  const { scheduler } = createScheduler();
  const plain = {};
  plain.constructor = { name: "PlainService" };

  // 呼叫了 register() 卻沒有東西可註冊，多半是把 static jobs 寫錯地方了。
  assert.throws(
    () => scheduler.register(plain),
    /called scheduler.register\(\) without declaring static jobs/
  );

  const wrongShape = {};
  wrongShape.constructor = { name: "WrongService", jobs: { name: "not-an-array" } };
  assert.throws(() => scheduler.register(wrongShape), /static jobs must be an array/);
});

test("a job submitted after start is scheduled without the caller sequencing it", async () => {
  const { scheduler, timers } = createScheduler({ random: () => 0 });

  await scheduler.start();

  // service 在自己的 initialize() 裡提交，通常早於 start()；晚到的也要能運作，
  // 呼叫端不需要知道排程器啟動了沒有。
  const late = jobService([
    { name: "demo.late", method: "work", intervalMs: 1000, timeoutMs: 100 }
  ]);
  scheduler.register(late);

  await timers.advance(800);
  assert.equal(late.calls.length, 1);

  await scheduler.stop();
});

test("two services cannot declare the same job name", () => {
  const first = jobService([{ name: "shared.tick", method: "work", intervalMs: 1000 }]);
  const second = jobService([{ name: "shared.tick", method: "work", intervalMs: 1000 }]);

  assert.throws(
    () => createScheduler({ jobs: { a: first, b: second } }),
    /Duplicate job name "shared.tick"/
  );
});

test("scheduler config rejects unknown per-job override fields", () => {
  // 靜默忽略打錯的欄位名，會讓設定看起來生效但完全沒作用。
  assert.throws(
    () => normalizeSchedulerConfig({ jobs: { "demo.tick": { scope: "cluster" } } }),
    /unsupported fields: scope/
  );
  assert.throws(
    () => normalizeSchedulerConfig({ jobs: { "demo.tick": { intervalMs: -1 } } }),
    /must be a positive integer/
  );
  assert.throws(
    () => normalizeSchedulerConfig({ startupJitterRatio: 2 }),
    /between 0 and 1/
  );

  const config = normalizeSchedulerConfig({});
  assert.equal(config.enabled, true);
  assert.equal(config.defaultTimeoutMs, 30000);
});
