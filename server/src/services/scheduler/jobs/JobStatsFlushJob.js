import { BaseService } from "../../../framework/services/BaseService.js";
import { MySqlJobStatsStore } from "../JobStatsStore.js";

const JOB_NAME = "scheduler.statsFlush";
const DEFAULT_INTERVAL_MS = 300_000;

/**
 * 把這個實例的排程統計發佈出去。
 *
 * 這件工作屬於排程器本身，所以它住在 scheduler/jobs/ 底下——同一條規則讓
 * LogRetentionJob 住在 logging/ 底下。排程器先前沒有自己的 job，是因為它只負責
 * 執行別人的工作；而「公開自己的統計」確實是它自己的事。
 *
 * 統計原本只活在 SchedulerService 的記憶體裡，沒有任何輸出管道：五件工作跑了
 * 多少次、失敗多少次、逾時多少次，全都記著，但沒有人看得到。這件工作補上那條
 * 管道，一次寫兩個地方：
 *
 *   日誌  一筆彙總，落在維運本來就在看的地方，不需要任何人主動去查。
 *   表    fr_job_stats，可以跨實例一次看完整個叢集的當下狀態。
 *
 * 兩者刻意不互相依賴：資料庫寫不進去時，日誌照樣輸出。統計是診斷資料，它自己
 * 壞掉不該變成應用的故障，所以寫入失敗只會讓這件工作在本行程內把自己關掉並記
 * 一筆 warn——這是刻意偏離 describeMissingTable 的「大聲失敗」慣例，那個慣例是
 * 給功能正確性用的。
 *
 * scope 是 instance：每個實例都必須回報自己。改成 cluster 就只剩 leader 那一台
 * 有資料，而「哪一台不健康」正是這張表要回答的問題。
 */
export class JobStatsFlushJob extends BaseService {
  static service = Object.freeze({
    name: "job.schedulerStatsFlush",
    lifecycle: "singleton",
    dependencies: ["scheduler", "logging", "mysqldatabase"],
    eager: true
  });

  static jobs = Object.freeze([
    {
      name: JOB_NAME,
      method: "run",
      scope: "instance",
      intervalMs: DEFAULT_INTERVAL_MS,
      timeoutMs: 15_000
      // runOnStart 維持 false：多實例同時啟動時，抖動正是用來避免所有實例在
      // 同一毫秒一起打資料庫的，而剛啟動的實例已經有 scheduler.started 那筆
      // 日誌宣告過自己了。
    }
  ]);

  constructor({ config, services, options = {} } = {}) {
    super({ config, services, options });
    this.scheduler = services.require("scheduler");
    this.logger = services.require("logging").logger;
    this.statsConfig = config.scheduler.stats;
    this.store =
      options.store ||
      new MySqlJobStatsStore({ database: services.require("mysqldatabase") });
    // 發佈失敗之後就不再重試，避免每一輪都對著同一個壞掉的表再撞一次。
    this.publishing = true;
  }

  async initialize() {
    this.scheduler.register(this);
  }

  /**
   * 過期門檻跟著這件工作真正的間隔走，而不是寫死的毫秒。部署時用
   * scheduler.jobs["scheduler.statsFlush"].intervalMs 把間隔調大之後，寫死的
   * 門檻會讓還活著的實例被自己的清理刪掉。
   */
  staleAfterMs() {
    const own = this.scheduler.describeJobs().find((job) => job.name === JOB_NAME);
    return (own?.intervalMs ?? DEFAULT_INTERVAL_MS) * this.statsConfig.staleAfterRuns;
  }

  async run() {
    const snapshot = this.scheduler.statsSnapshot();

    // 日誌先寫。它不依賴資料庫，所以資料庫壞掉的時候它是唯一還在的輸出。
    await this.report(snapshot);

    if (!this.publishing) {
      return;
    }

    try {
      await this.store.write(
        snapshot.jobs.map((job) => ({
          instanceId: snapshot.owner,
          jobName: job.name,
          host: snapshot.host,
          address: this.statsConfig.address,
          scope: job.scope,
          lastStartedAt: job.lastStartedAt,
          lastFinishedAt: job.lastFinishedAt,
          lastSuccessAt: job.lastSuccessAt,
          lastOutcome: job.lastOutcome,
          lastDurationMs: job.lastDurationMs,
          lastError: job.lastError,
          runs: job.runs,
          failures: job.failures,
          timeouts: job.timeouts,
          skippedOverlapping: job.skippedOverlapping,
          skippedNotLeader: job.skippedNotLeader,
          consecutiveFailures: job.consecutiveFailures
        }))
      );

      // 清掉崩潰實例留下的列。每個實例都做一次是重複的，但 DELETE 是冪等的，
      // 而為此再切一件 cluster 工作出來，成本高於它省下的那幾句 SQL。
      const removed = await this.store.purgeStale(this.staleAfterMs());

      if (removed > 0) {
        await this.logger.info(
          "scheduler.stats.stale_removed",
          "Removed job stats left behind by instances that are gone",
          { removedRows: removed, staleAfterMs: this.staleAfterMs() }
        );
      }
    } catch (error) {
      this.publishing = false;
      await this.logger.warn(
        "scheduler.stats.publish_failed",
        "Could not publish job stats; the summary log continues but fr_job_stats will go stale",
        {
          instanceId: snapshot.owner,
          error: { name: error.name, message: error.message }
        }
      );
    }
  }

  /** 一筆彙總日誌，外加連續失敗時的升級。 */
  async report(snapshot) {
    const failing = snapshot.jobs.filter(
      (job) => job.consecutiveFailures >= this.statsConfig.consecutiveFailureAlertThreshold
    );
    const context = {
      instanceId: snapshot.owner,
      host: snapshot.host,
      address: this.statsConfig.address,
      jobs: snapshot.jobs
    };

    if (failing.length > 0) {
      // 表是被動的，得有人去查才看得到。連續失敗是唯一需要有人現在就知道的
      // 事，所以它必須是一筆 error，而不只是一列資料。
      await this.logger.error(
        "scheduler.stats.jobs_failing",
        "Background jobs are failing repeatedly",
        {
          ...context,
          failingJobs: failing.map((job) => ({
            job: job.name,
            consecutiveFailures: job.consecutiveFailures,
            lastOutcome: job.lastOutcome,
            lastError: job.lastError
          }))
        }
      );
      return;
    }

    await this.logger.info("scheduler.stats", "Background job stats", context);
  }

  async shutdown() {
    // 正常關機刪掉自己的列。這是「重啟後表裡沒有舊資料」的主要路徑；崩潰時沒
    // 有人執行到這裡，那些列改由 purgeStale 收拾。
    //
    // 絕不能是 TRUNCATE 或無條件 DELETE：多實例部署下那會抹掉同儕正在用的列，
    // 而滾動重啟就是讓每個實例輪流做一次。
    try {
      await this.store.deleteInstance(this.scheduler.owner);
    } catch (error) {
      // 關機路徑上拋錯會擋住後面的 service。留下的列會自然過期。
      void this.logger.warn(
        "scheduler.stats.cleanup_failed",
        "Could not remove this instance's job stats; they will expire instead",
        {
          instanceId: this.scheduler.owner,
          error: { name: error.name, message: error.message }
        }
      );
    }
  }
}
