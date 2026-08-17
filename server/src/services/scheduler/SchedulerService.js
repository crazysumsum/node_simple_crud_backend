import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { normalizeJobDefinition } from "./normalizeJobDefinition.js";
import { MySqlJobLeaseStore } from "./JobLeaseStore.js";
import { BaseService } from "../../framework/services/BaseService.js";

/**
 * 統計欄位存的錯誤上限。這個值同時是 fr_job_stats.last_error 的欄寬——留一份在
 * 記憶體裡的統計沒有理由無界成長，而截斷在來源做，兩邊就不會不一致。
 */
export const MAX_STATS_ERROR_LENGTH = 500;

// race() 用的哨兵值：租約取得跟 job.run() 共用同一個 timeoutMs 預算，逾時是
// 誰先發生分不出來單看回傳值，要一個跟正常回傳值（true/false）不會混淆的記號。
const LEASE_ACQUIRE_TIMED_OUT = Symbol("schedulerLeaseAcquireTimedOut");

function describeError(error) {
  const text = `${error?.name || "Error"}: ${error?.message || ""}`;
  return text.length > MAX_STATS_ERROR_LENGTH
    ? `${text.slice(0, MAX_STATS_ERROR_LENGTH - 1)}…`
    : text;
}

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

  constructor({ config, services, options = {} } = {}) {
    super({ config, services, options });
    this.schedulerConfig = config.scheduler;
    this.logger = services.require("logging").logger;
    this.time = services.require("time");
    this.database = services.require("mysqldatabase");

    // 計時器可注入，測試才能確定性地推進時間而不用 sleep。
    this.setTimer = options.setTimer || ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer || ((handle) => clearTimeout(handle));
    this.random = options.random || Math.random;
    this.leaseStore =
      options.leaseStore || new MySqlJobLeaseStore({ database: this.database });
    // 租約的持有者識別。UUID 保證唯一，主機名與 pid 是給人看的。
    // 統計表也用它當識別，所以「誰持有租約」與「誰真的跑了」對得起來。
    this.host = hostname();
    this.owner = `${this.host}:${process.pid}:${randomUUID().slice(0, 8)}`;

    this.jobs = new Map();
    this.timers = new Map();
    this.running = new Map();
    this.stats = new Map();
    // 每次替一個 cluster job 開新的 acquire 嘗試就遞增。逾時之後遲到的
    // acquirePromise 補償釋放前要核對這個世代，否則會釋放掉同一個 owner
    // 後續嘗試剛拿到的租約，見 runJob() 裡的補償邏輯。
    this.leaseAttempt = new Map();
    this.started = false;
    this.stopped = false;
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
        consecutiveFailures: 0,
        // 計數器答得出「壞過幾次」，答不出「上一次是什麼時候、結果如何」，
        // 而後者才是看到告警之後第一個要問的問題。
        lastStartedAt: null,
        lastFinishedAt: null,
        lastSuccessAt: null,
        lastOutcome: null,
        lastDurationMs: null,
        lastError: null
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

  /**
   * 這個實例目前的排程統計。JobStatsFlushJob 週期性地取它並發佈出去。
   *
   * 只包含實際會執行的工作。被停用的工作不放進來，因為「停用」與「啟用但還沒
   * 跑過」在一列資料上長得一模一樣，而 scheduler.started／scheduler.disabled
   * 這兩筆啟動日誌已經完整列出過工作清單了。
   */
  statsSnapshot() {
    const jobs = [];

    for (const job of this.jobs.values()) {
      if (!job.enabled || !this.schedulerConfig.enabled) {
        continue;
      }

      jobs.push(
        Object.freeze({
          name: job.name,
          scope: job.scope,
          intervalMs: job.intervalMs,
          ...this.stats.get(job.name)
        })
      );
    }

    return Object.freeze({ owner: this.owner, host: this.host, jobs: Object.freeze(jobs) });
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

    const controller = new AbortController();
    const startedAt = this.time.nowMs();
    // timeoutMs 從這裡開始算，取租約也算在裡面——租約取得本身沒有計時器保護，
    // 慢的資料庫可以讓它無限期掛著；不把它包進同一個預算的話，這段 await 就
    // 完全不受任何上限節制。
    const timeout = this.setTimer(() => {
      controller.abort(new Error(`Job "${job.name}" exceeded ${job.timeoutMs}ms`));
    }, job.timeoutMs);
    timeout?.unref?.();

    // running 的佔位必須在這裡、在任何 await 之前完成同步設定。租約取得是一個
    // await：慢的話，排程器可能在它 resolve 之前就已經觸發下一輪 tick，那一輪
    // 一樣會看到 running 是空的，通過上面的重疊檢查，對同一個 job 重複發出
    // acquire()。把租約取得整段搬進這個立即呼叫的 async function 裡，
    // 讓外層在它第一次 await 之前就跑到 running.set()，這個空窗就不存在了。
    const settled = (async () => {
      let leaseHeld = false;

      try {
        if (job.scope === "cluster") {
          // 世代編號要在 acquire() 呼叫之前遞增並記住——補償邏輯要能分辨
          // 「這次逾時的嘗試」跟「同一個 owner 之後又開的新嘗試」。
          const attemptGeneration = (this.leaseAttempt.get(job.name) || 0) + 1;
          this.leaseAttempt.set(job.name, attemptGeneration);

          const acquirePromise = this.leaseStore.acquire(job.name, {
            owner: this.owner,
            leaseMs: job.timeoutMs + this.schedulerConfig.clusterLeaseGraceMs,
            // 逾時時把同一個 signal 往下傳，讓 acquire() 能中斷還在飛的交易，
            // 而不是繼續跑到底。這把下面的「遲到成功」窗口從整段 acquire
            // 耗時，縮小到 abort 事件跟 COMMIT ack 競爭的那幾毫秒。
            signal: controller.signal
          });
          // 逾時獲勝的話這個 promise 還在背景跑，沒有人會再 await 它——不接住
          // 的話它遲早 reject 成一個 unhandled rejection。
          acquirePromise.catch(() => {});

          const timedOut = new Promise((resolve) => {
            controller.signal.addEventListener("abort", () => resolve(LEASE_ACQUIRE_TIMED_OUT), {
              once: true
            });
          });
          let result;

          try {
            result = await Promise.race([acquirePromise, timedOut]);
          } catch (error) {
            stats.failures += 1;
            stats.consecutiveFailures += 1;
            // 工作本身沒有跑，但這一輪確實失敗了。記成一次結果為 leaseFailed 的
            // 嘗試，否則症狀只剩下「runs 停止增加」，看不出是資料庫的問題。
            const finishedAt = this.time.nowMs();
            stats.lastStartedAt = startedAt;
            stats.lastFinishedAt = finishedAt;
            stats.lastDurationMs = finishedAt - startedAt;
            stats.lastOutcome = "leaseFailed";
            stats.lastError = describeError(error);
            void this.logger.error("scheduler.lease.failed", "Could not acquire a cluster job lease", {
              job: job.name,
              owner: this.owner,
              error: { name: error.name, message: error.message }
            });
            return;
          }

          if (result === LEASE_ACQUIRE_TIMED_OUT) {
            stats.failures += 1;
            stats.consecutiveFailures += 1;
            stats.timeouts += 1;
            const finishedAt = this.time.nowMs();
            stats.lastStartedAt = startedAt;
            stats.lastFinishedAt = finishedAt;
            stats.lastDurationMs = finishedAt - startedAt;
            stats.lastOutcome = "leaseTimedOut";
            stats.lastError = `Lease acquisition for job "${job.name}" exceeded ${job.timeoutMs}ms`;
            void this.logger.error(
              "scheduler.lease.timeout",
              "Cluster job lease acquisition exceeded the job timeout",
              { job: job.name, owner: this.owner, timeoutMs: job.timeoutMs }
            );

            // signal 取消交易通常會讓 acquirePromise 直接 reject，但 abort
            // 事件跟 COMMIT ack 之間仍有一個窄窗：acquire() 可能還是遲來地
            // 回傳 true——那是一個沒有人在等的租約，會一路留到自然過期。
            // 只要它真的拿到了，就立刻補償性釋放；但如果同一個 owner 這段
            // 時間內已經開了更新的嘗試（世代編號變了），代表現在的租約可能
            // 是那個新嘗試合法拿到的，不能碰。
            //
            // 用 then(onFulfilled, onRejected) 而不是 .catch()：acquirePromise
            // 因為取消而 reject 是預期行為，不該被當成錯誤記錄；只有下面
            // release() 本身失敗才值得記一筆。
            void acquirePromise.then((acquired) => {
              if (!acquired || this.leaseAttempt.get(job.name) !== attemptGeneration) {
                return;
              }

              return this.leaseStore.release(job.name, this.owner).then(
                () => {
                  void this.logger.warn(
                    "scheduler.lease.late_release",
                    "A lease acquisition that had already timed out succeeded afterwards; released it",
                    { job: job.name, owner: this.owner }
                  );
                },
                (error) => {
                  void this.logger.error(
                    "scheduler.lease.late_release_failed",
                    "Could not release a lease that succeeded after its acquisition timed out",
                    { job: job.name, owner: this.owner, error: { name: error.name, message: error.message } }
                  );
                }
              );
            }, () => {});

            return;
          }

          leaseHeld = result;

          if (!leaseHeld) {
            // 另一個實例拿到了這一輪。這是正常運作，不是問題。
            stats.skippedNotLeader += 1;
            void this.logger.debug?.("scheduler.job.not_leader", "Another instance holds this job lease", {
              job: job.name
            });
            return;
          }
        }

        // 只有真的要跑了才進入「執行中」狀態。not-leader 這類正常跳過不該
        // 覆蓋上一輪真正執行的紀錄，計數器已經表達過那件事了。
        stats.lastStartedAt = startedAt;
        // 進行中就是進行中：把上一輪的完成時間留在欄位裡，會讓讀的人以為那是
        // 這一輪的結果。
        stats.lastFinishedAt = null;
        stats.lastDurationMs = null;
        stats.lastOutcome = "running";

        await job.run(controller.signal);
        stats.runs += 1;
        stats.consecutiveFailures = 0;
        const finishedAt = this.time.nowMs();
        stats.lastFinishedAt = finishedAt;
        stats.lastSuccessAt = finishedAt;
        stats.lastDurationMs = finishedAt - startedAt;
        stats.lastOutcome = "succeeded";
        stats.lastError = null;
        void this.logger.debug?.("scheduler.job.completed", "Background job completed", {
          job: job.name,
          durationMs: finishedAt - startedAt
        });
      } catch (error) {
        stats.failures += 1;
        stats.consecutiveFailures += 1;

        if (controller.signal.aborted) {
          stats.timeouts += 1;
        }

        const finishedAt = this.time.nowMs();
        stats.lastFinishedAt = finishedAt;
        stats.lastDurationMs = finishedAt - startedAt;
        stats.lastOutcome = controller.signal.aborted ? "timedOut" : "failed";
        stats.lastError = describeError(error);

        // 工作拋錯絕不能變成 unhandled rejection，也絕不能中斷排程。但連續
        // 失敗必須看得見，否則「壞了三天沒人發現」是可能的。
        void this.logger.error("scheduler.job.failed", "Background job failed", {
          job: job.name,
          durationMs: finishedAt - startedAt,
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
