import { normalizeSchedulerConfig } from "../src/services/scheduler/normalizeSchedulerConfig.js";
import { SchedulerService } from "../src/services/scheduler/SchedulerService.js";

/**
 * 驅動 SchedulerService 的測試替身。
 *
 * 這一組替身原本住在 scheduler.test.js 裡。統計發佈的測試需要完全一樣的東西
 * ——尤其是那個假計時器——而它有一百多行，且它的正確性本身就很微妙（微任務排
 * 空的順序）。複製一份的話，兩份會慢慢分岔，而分岔的那一份會測出真實環境不會
 * 發生的競態。
 */

// 排程器的測試全部用注入的假計時器驅動，沒有一個 sleep。這個工作階段已經被
// 計時器競賽咬過一次（shutdown 的 flaky 測試），排程的行為必須是確定性的。

/** 手動推進的計時器，順帶記錄 unref 有沒有被呼叫。 */
export function fakeTimers() {
  let now = 0;
  let nextId = 1;
  const pending = new Map();
  const unrefed = new Set();

  return {
    get now() {
      return now;
    },
    unrefCount: () => unrefed.size,
    pendingCount: () => pending.size,
    setTimer(fn, ms) {
      const id = nextId++;
      pending.set(id, { fn, dueAt: now + ms });
      return { id, unref: () => unrefed.add(id) };
    },
    clearTimer(handle) {
      pending.delete(handle?.id);
    },
    /** 推進時間並執行所有到期的計時器，之後排空 microtask。 */
    async advance(ms) {
      const target = now + ms;
      // 也要在推進之前排空一次：呼叫端剛剛做的事（例如 resolve 一個進行中的
      // 工作）在真實環境裡會在下一個計時器觸發之前就完成。
      await new Promise((resolve) => {
        setImmediate(resolve);
      });

      for (;;) {
        const due = [...pending.entries()]
          .filter(([, timer]) => timer.dueAt <= target)
          .sort(([, a], [, b]) => a.dueAt - b.dueAt);

        if (due.length === 0) {
          break;
        }

        const [id, timer] = due[0];
        pending.delete(id);
        now = timer.dueAt;
        timer.fn();
        // 真實的計時器是 macrotask，所以在下一個計時器執行之前，微任務佇列
        // 一定已經排空。假計時器必須忠實模擬這個順序保證，否則會測出真實環境
        // 不會發生的競態。
        await new Promise((resolve) => {
          setImmediate(resolve);
        });
      }

      now = target;
      await new Promise((resolve) => {
        setImmediate(resolve);
      });
    }
  };
}

export function collectingLogger() {
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

export function fakeLeaseStore({ grantTo = () => true } = {}) {
  const calls = [];
  return {
    calls,
    prepared: [],
    async prepare(names) {
      this.prepared.push(...names);
    },
    async acquire(jobName, options) {
      const granted = grantTo(jobName, options);
      calls.push({ type: "acquire", jobName, granted, owner: options.owner });
      return granted;
    },
    async release(jobName, owner) {
      calls.push({ type: "release", jobName, owner });
    }
  };
}

/** 最小的 service 容器替身，只提供 describe()/get()/require()。 */
export function fakeServices(instances) {
  return {
    describe: () => Object.keys(instances).map((name) => ({ name })),
    get: (name) => instances[name],
    require: (name) => instances[name]
  };
}

export function createScheduler({
  jobs = {},
  services = {},
  config = {},
  leaseStore = fakeLeaseStore(),
  timers = fakeTimers(),
  logger = collectingLogger(),
  random = () => 0.5
} = {}) {
  const schedulerConfig = normalizeSchedulerConfig(config);
  const database = { withTransaction: async () => {}, execute: async () => {} };
  const scheduler = new SchedulerService({
    config: { scheduler: schedulerConfig },
    services: fakeServices({
      logging: { logger },
      time: { nowMs: () => timers.now },
      mysqldatabase: database
    }),
    options: {
      setTimer: timers.setTimer.bind(timers),
      clearTimer: timers.clearTimer.bind(timers),
      leaseStore,
      random
    }
  });
  for (const instance of Object.values({ ...services, ...jobs })) {
    scheduler.register(instance);
  }
  return { scheduler, timers, logger, leaseStore };
}

/** 宣告了 static jobs 的 service 替身。 */
export function jobService(jobs, run) {
  const calls = [];
  const instance = {
    calls,
    async work(signal) {
      calls.push({ at: calls.length, aborted: signal.aborted });
      return run ? run(signal, calls) : undefined;
    }
  };
  instance.constructor = { jobs: Object.freeze(jobs), name: "JobService" };
  return instance;
}
