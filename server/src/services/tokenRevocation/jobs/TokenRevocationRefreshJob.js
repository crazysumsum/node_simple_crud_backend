import { BaseService } from "../../../framework/services/BaseService.js";

const JOB_NAME = "tokenRevocation.refresh";
const DEFAULT_INTERVAL_MS = 30_000;

/**
 * 定期把撤銷名單重新載入記憶體。
 *
 * scope 必須是 instance：快照在每個實例自己的記憶體裡，每一台都得自己刷新。
 * 改成 cluster 的話每一輪只有搶到租約的那台會更新，其餘實例的撤銷會永遠停在
 * 啟動時的狀態——而且完全沒有錯誤訊息，因為對排程器而言工作確實跑成功了。
 */
export class TokenRevocationRefreshJob extends BaseService {
  static service = Object.freeze({
    name: "job.tokenRevocationRefresh",
    lifecycle: "singleton",
    dependencies: ["scheduler", "tokenRevocation", "logging"],
    eager: true
  });

  static jobs = Object.freeze([
    {
      name: JOB_NAME,
      method: "run",
      scope: "instance",
      intervalMs: DEFAULT_INTERVAL_MS,
      timeoutMs: 10_000
    }
  ]);

  constructor({ config, services, options = {} } = {}) {
    super({ config, services, options });
    this.tokenRevocation = services.require("tokenRevocation");
    this.scheduler = services.require("scheduler");
    this.logger = services.require("logging").logger;

    // 與排程器同一套優先序（部署覆寫優先於 static 宣告），所以這裡算出來的
    // 就是實際會生效的間隔。
    this.intervalMs =
      config?.scheduler?.jobs?.[JOB_NAME]?.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.maxStalenessSeconds = config?.tokenRevocation?.maxStalenessSeconds ?? 60;
  }

  async initialize() {
    // 刷新間隔住在 config/scheduler.js，撤銷 SLA 住在 config/tokenRevocation.js。
    // 分開是對的——一個是排程參數，一個是安全承諾——但兩者必須相容，否則有人
    // 為了省資料庫負載把間隔調到 10 分鐘時，撤銷 SLA 會從 60 秒悄悄變成 10 分鐘，
    // 沒有任何地方會說出來。
    //
    // 這是三段鏈的第一段：intervalMs <= maxStalenessSeconds <= maxFailOpenSeconds。
    // 第二段由 normalizeTokenRevocationConfig 檢查。
    if (this.intervalMs > this.maxStalenessSeconds * 1000) {
      throw new Error(
        `Job "${JOB_NAME}" runs every ${this.intervalMs}ms, which exceeds ` +
          `tokenRevocation.maxStalenessSeconds (${this.maxStalenessSeconds}s). ` +
          "Revocation would take longer to apply than the configured guarantee. " +
          "Lower the interval, or raise maxStalenessSeconds to match."
      );
    }

    this.scheduler.register(this);
  }

  async run() {
    // refresh() 自己吞掉例外（fail open 是刻意的），所以這裡必須把回傳值變回
    // 一次失敗的工作。丟掉它的話，排程器會認為工作跑成功了，撤銷可以死好幾個
    // 小時而 fr_scheduler_stats 上的 lastOutcome 一路都是 succeeded——那張表
    // 就是為了看見這種事才建的。
    if (!(await this.tokenRevocation.refresh())) {
      throw new Error(
        "Token revocation snapshot refresh failed; see auth.revocation.refresh_failed"
      );
    }
  }
}
