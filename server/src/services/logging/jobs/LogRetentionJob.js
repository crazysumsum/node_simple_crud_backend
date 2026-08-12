import { BaseService } from "../../../framework/services/BaseService.js";

/**
 * 清除過期的日誌檔案。
 *
 * Job 就是 service 的一個變種：這個目錄本來就在 src/services/ 底下，所以既有的
 * service 自發現機制會載入它，不需要第四套發現機制。定義（static jobs）、提交
 * （initialize 裡的 register）與實作（run）都在同一個檔案裡，看程式碼的人不必
 * 熟悉框架也找得到全貌。
 *
 * 它放在 logging 底下而不是排程器底下：這件工作屬於日誌，排程器只是執行它的
 * 人。jobs/ 是放置慣例而不是強制的——任何 service 都可以宣告 static jobs 並
 * 自行提交——放進這個子目錄代表「這個 service 的存在理由就是這件定時工作」。
 *
 * 因為它是一般 service，別處也能注入它來手動觸發——例如一個「立即清理」的
 * 管理接口，就是 services.require("job.logRetention").run()。
 *
 * scope 維持 instance：日誌檔在各自的本機磁碟上，每個實例都得清自己的。
 */
export class LogRetentionJob extends BaseService {
  static service = Object.freeze({
    name: "job.logRetention",
    lifecycle: "singleton",
    dependencies: ["scheduler", "logging"],
    eager: true
  });

  static jobs = Object.freeze([
    {
      name: "logging.retentionCleanup",
      method: "run",
      // 每小時檢查一次；真正是否清理仍由各 profile 的 cleanupIntervalHours
      // 決定，所以既有設定的語意完全不變。
      intervalMs: 3_600_000,
      timeoutMs: 60_000
    }
  ]);

  constructor({ config, services, options = {} } = {}) {
    super({ config, services, options });
    this.logging = services.require("logging");
    this.scheduler = services.require("scheduler");
  }

  async initialize() {
    this.scheduler.register(this);
  }

  async run() {
    await this.logging.cleanup();
  }
}
