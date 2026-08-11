import { BaseService } from "../../framework/services/BaseService.js";

/**
 * 週期性清除過期的日誌檔案。
 *
 * 這件事以前掛在 FileLogWriter.write() 上，於是一台不寫日誌的伺服器永遠不會
 * 清理：request logger 要有流量才寫，system logger 更是只在啟動、錯誤與關機時
 * 才寫。一個長期安靜、沒有錯誤的實例，過期檔案會一直留著，而 retentionDays
 * 說好了只留 30 天。
 *
 * 這是一個獨立的 service 而不是把 job 掛在 LoggingService 上，因為 scheduler
 * 依賴 logging：logging 反過來依賴 scheduler 會形成循環，容器會在啟動時擋下。
 * 由第三者同時依賴兩邊是打破這個環的標準做法。
 *
 * scope 維持 instance：日誌檔在各自的本機磁碟上，每個實例都得清自己的。
 */
export class LogRetentionService extends BaseService {
  static service = Object.freeze({
    name: "logRetention",
    lifecycle: "singleton",
    dependencies: ["scheduler", "logging"],
    eager: true
  });

  static jobs = Object.freeze([
    {
      name: "logging.retentionCleanup",
      method: "cleanup",
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

  async cleanup() {
    await this.logging.cleanup();
  }
}
