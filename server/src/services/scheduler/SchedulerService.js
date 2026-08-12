import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { normalizeJobDefinition } from "./normalizeJobDefinition.js";
import { MySqlJobLeaseStore } from "./JobLeaseStore.js";
import { BaseService } from "../../framework/services/BaseService.js";

/**
 * 背景定時作業。
 *
 * 工作宣告在提供它的 service 的 static jobs 上，並由那個 service 自己呼叫
 * register() 提交——排程器不走訪容器。這是 push 而不是 pull，差別在於：
 *
 * - Application Factory 完全不需要知道排程器的存在。先前由 Factory 呼叫
 *   collectFrom() 的寫法，讓「排程器被 static service.enabled 停用」直接變成
 *   整個應用無法啟動。
 * - 依賴方向是明示的：需要排程的 service 把 "scheduler" 宣告成依賴，容器因此
 *   保證排程器先建立，收集時機的問題根本不存在。
 * - 排程關係會出現在依賴圖與啟動日誌裡，不再是隱形的一條邊。
 *
 * 排程器是「工作來源」而不是「葉子資源」：它必須在它所使用的 service 被拆掉
 * 之前先停下來，所以 Factory 會在關閉 HTTP server 的同一階段呼叫 stop()。那是
 * 生命週期的先後安排，與工作的收集無關。容器之後還會再呼叫一次 shutdown()，
 * 兩者都是冪等的。
 */
export class SchedulerService extends BaseService {
  static service = Object.freeze({
    name: "scheduler",
    lifecycle: "singleton",
    dependencies: ["logging", "time", "mysqldatabase"],
    eager: true
  });

  /**
   * 框架自己的維護工作。
   *
   * 放在這裡而不是獨立一個 service，是因為那樣的 service 必須宣告 scheduler
   * 為依賴，於是把排程器 static service.enabled 停掉會讓整個應用起不來——
   * 只是不想跑背景工作的部署不該有這種後果。掛在排程器身上，停用它就只是
   * 「沒有背景工作」，清理自動退回由活動觸發的舊路徑。
   *
   * 排程器本來就依賴 logging，所以沒有引入任何新的耦合。
   */
  static jobs = Object.freeze([
    {
      name: "logging.retentionCleanup",
      method: "cleanupLogs",
      // 每小時檢查一次；真正是否清理仍由各 profile 的 cleanupIntervalHours
      // 決定，所以既有設定的語意完全不變。
      intervalMs: 3_600_000,
      timeoutMs: 60_000
    }
  ]);

  constructor({ config, services, options = {} } = {}) {
    super({ config, services, options });
    this.schedulerConfig = config.scheduler;
    this.logging = services.require("logging");
    this.logger = this.logging.logger;
    this.time = services.require("time");
    this.database = services.require("mysqldatabase");

    // 計時器可注入，測試才能確定性地推進時間而不用 sleep。
    this.setTimer = options.setTimer || ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer || ((handle) => clearTimeout(handle));
    this.random = options.random || Math.random;
    this.leaseStore =
      options.leaseStore || new MySqlJobLeaseStore({ database: this.database });
    // 租約的持有者識別。UUID 保證唯一，主機名與 pid 是給人看的。
    this.owner = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

    this.jobs = new Map();
    this.timers = new Map();
    this.running = new Map();
    this.stats = new Map();
    this.started = false;
    this.stopped = false;
  }

  async initialize() {
    // 排程器也照一般規則提交自己的工作，沒有特例路徑。
    this.register(this);
  }

  /** 清除過期的日誌檔。原本只掛在 write() 上，安靜的伺服器因此永遠不清理。 */
  async cleanupLogs() {
    await this.logging.cleanup();
  }

  /**
   * 由 service 自己提交它宣告的 static jobs，通常在自己的 initialize() 裡呼叫。
   * 呼叫端不需要在意排程器啟動了沒有：已經啟動之後才提交的工作會立即排入。
   */
  register(instance) {
    const serviceName =
      instance?.constructor?.service?.name || instance?.constructor?.name || "unknown";
    const declared = instance?.constructor?.jobs;

    if (!declared) {
      throw new Error(
        `Service "${serviceName}" called scheduler.register() without declaring static jobs`
      );
    }

    if (!Array.isArray(declared)) {
      throw new Error(`Service "${serviceName}" static jobs must be an array`);
    }

    for (const source of declared) {
      const job = normalizeJobDefinition(source, instance, serviceName, this.schedulerConfig);

      if (this.jobs.has(job.name)) {
        throw new Error(
          `Duplicate job name "${job.name}" declared by services "${this.jobs.get(job.name).serviceName}" and "${serviceName}"`
        );
      }

      this.jobs.set(job.name, job);
      this.stats.set(job.name, {
        runs: 0,
        failures: 0,
        skippedOverlapping: 0,
        skippedNotLeader: 0,
        timeouts: 0,
        consecutiveFailures: 0
      });

      if (this.started && !this.stopped && this.schedulerConfig.enabled && job.enabled) {
        void this.prepareAndSchedule(job);
      }
    }

    return this;
  }

  async prepareAndSchedule(job) {
    if (job.scope === "cluster") {
      await this.leaseStore.prepare([job.name]);
    }

    this.schedule(job, this.initialDelayFor(job));
  }

  describeJobs() {
    return [...this.jobs.values()].map(
      ({ name, serviceName, method, scope, intervalMs, timeoutMs, enabled, runOnStart }) =>
        Object.freeze({
          name,
          service: serviceName,
          method,
          scope,
          intervalMs,
          timeoutMs,
          enabled: enabled && this.schedulerConfig.enabled,
          runOnStart
        })
    );
  }

  async start() {
    if (this.started || this.stopped) {
      return this;
    }

    this.started = true;
    const active = [...this.jobs.values()].filter((job) => job.enabled);

    if (!this.schedulerConfig.enabled) {
      // 整個排程器被關掉時，工作清單仍要記錄下來——「背景工作為什麼沒跑」
      // 不該是一個要翻原始碼才能回答的問題。
      await this.logger.info("scheduler.disabled", "Scheduler is disabled; no jobs scheduled", {
        jobs: this.describeJobs()
      });
      return this;
    }

    const clusterJobs = active.filter((job) => job.scope === "cluster");

    if (clusterJobs.length > 0) {
      await this.leaseStore.prepare(clusterJobs.map((job) => job.name));
    }

    for (const job of active) {
      this.schedule(job, this.initialDelayFor(job));
    }

    await this.logger.info("scheduler.started", "Background jobs scheduled", {
      owner: this.owner,
      jobCount: active.length,
      jobs: this.describeJobs()
    });
    return this;
  }

  /**
   * 首次執行加隨機延遲：多實例同時啟動時，所有實例會在同一毫秒一起打資料庫。
   * runOnStart 的工作跳過抖動，因為那代表「現在就要跑一次」。
   */
  initialDelayFor(job) {
    if (job.runOnStart) {
      return 0;
    }

    const jitter = job.intervalMs * this.schedulerConfig.startupJitterRatio;
    return Math.floor(job.intervalMs - jitter + this.random() * jitter);
  }

  schedule(job, delayMs) {
    if (this.stopped) {
      return;
    }

    const timer = this.setTimer(() => {
      // 先排下一輪再執行：這一輪就算拋錯或逾時，排程也不會斷掉。
      this.schedule(job, job.intervalMs);
      void this.execute(job);
    }, delayMs);

    // 背景工作不該讓程序無法結束。
    timer?.unref?.();
    this.timers.set(job.name, timer);
  }

  async execute(job) {
    const stats = this.stats.get(job.name);

    // 上一輪還沒跑完就跳過這一輪。不這樣做的話，一個變慢的工作會堆積成無限並行。
    if (this.running.has(job.name)) {
      stats.skippedOverlapping += 1;
      void this.logger.warn("scheduler.job.overlapping", "Skipped a job run still in progress", {
        job: job.name,
        skippedOverlapping: stats.skippedOverlapping
      });
      return;
    }

    let leaseHeld = false;

    if (job.scope === "cluster") {
      try {
        leaseHeld = await this.leaseStore.acquire(job.name, {
          owner: this.owner,
          leaseMs: job.timeoutMs + this.schedulerConfig.clusterLeaseGraceMs
        });
      } catch (error) {
        stats.failures += 1;
        stats.consecutiveFailures += 1;
        void this.logger.error("scheduler.lease.failed", "Could not acquire a cluster job lease", {
          job: job.name,
          owner: this.owner,
          error: { name: error.name, message: error.message }
        });
        return;
      }

      if (!leaseHeld) {
        // 另一個實例拿到了這一輪。這是正常運作，不是問題。
        stats.skippedNotLeader += 1;
        void this.logger.debug?.("scheduler.job.not_leader", "Another instance holds this job lease", {
          job: job.name
        });
        return;
      }
    }

    const controller = new AbortController();
    const startedAt = this.time.nowMs();
    const timeout = this.setTimer(() => {
      controller.abort(new Error(`Job "${job.name}" exceeded ${job.timeoutMs}ms`));
    }, job.timeoutMs);
    timeout?.unref?.();

    const settled = (async () => {
      try {
        await job.run(controller.signal);
        stats.runs += 1;
        stats.consecutiveFailures = 0;
        void this.logger.debug?.("scheduler.job.completed", "Background job completed", {
          job: job.name,
          durationMs: this.time.nowMs() - startedAt
        });
      } catch (error) {
        stats.failures += 1;
        stats.consecutiveFailures += 1;

        if (controller.signal.aborted) {
          stats.timeouts += 1;
        }

        // 工作拋錯絕不能變成 unhandled rejection，也絕不能中斷排程。但連續
        // 失敗必須看得見，否則「壞了三天沒人發現」是可能的。
        void this.logger.error("scheduler.job.failed", "Background job failed", {
          job: job.name,
          durationMs: this.time.nowMs() - startedAt,
          timedOut: controller.signal.aborted,
          consecutiveFailures: stats.consecutiveFailures,
          error: { name: error.name, message: error.message }
        });
      } finally {
        this.clearTimer(timeout);
        this.running.delete(job.name);

        if (leaseHeld) {
          await this.leaseStore
            .release(job.name, this.owner)
            .catch((error) =>
              // 釋放失敗只是讓下一輪等租約自然過期，不算工作失敗，但要看得見。
              this.logger.error("scheduler.lease.release_failed", "Could not release a cluster job lease", {
                job: job.name,
                owner: this.owner,
                error: { name: error.name, message: error.message }
              })
            );
        }
      }
    })();

    this.running.set(job.name, { promise: settled, controller });
    await settled;
  }

  /** 停止排程並等待進行中的工作結束。冪等。 */
  async stop({ timeoutMs } = {}) {
    if (this.stopped) {
      return { stopped: true, drained: true };
    }

    this.stopped = true;

    for (const timer of this.timers.values()) {
      this.clearTimer(timer);
    }

    this.timers.clear();

    const inFlight = [...this.running.values()];

    if (inFlight.length === 0) {
      return { stopped: true, drained: true };
    }

    for (const { controller } of inFlight) {
      controller.abort(new Error("Scheduler is shutting down"));
    }

    const drained = await Promise.race([
      Promise.allSettled(inFlight.map(({ promise }) => promise)).then(() => true),
      new Promise((resolve) => {
        const timer = this.setTimer(() => resolve(false), timeoutMs ?? 5000);
        timer?.unref?.();
      })
    ]);

    if (!drained) {
      void this.logger.warn("scheduler.stop.timed_out", "Background jobs did not finish before shutdown", {
        jobs: [...this.running.keys()]
      });
    }

    return { stopped: true, drained };
  }

  async shutdown() {
    await this.stop();
    await this.leaseStore.close?.();
  }
}
