import { BaseService } from "../../../framework/services/BaseService.js";

/**
 * 刪除早已無意義的撤銷切線。
 *
 * scope 必須是 cluster：這張表是所有實例共用的，每台都掃一次就是把同一個
 * DELETE 重複 N 次。改成 instance 不會產生錯誤結果（DELETE 是冪等的），只會
 * 白白增加資料庫負載——這種錯誤不會壞掉任何東西，所以也不會有人發現。
 *
 * 這是框架第一個真正用到 cluster scope 的工作，租約機制在此之前只有測試在用。
 */
export class TokenRevocationPurgeJob extends BaseService {
  static service = Object.freeze({
    name: "job.tokenRevocationPurge",
    lifecycle: "singleton",
    dependencies: ["scheduler", "tokenRevocation"],
    eager: true
  });

  static jobs = Object.freeze([
    {
      name: "tokenRevocation.purge",
      method: "run",
      scope: "cluster",
      // 保留期以天計，所以每小時掃一次已經遠比需要的密集。
      intervalMs: 3_600_000,
      timeoutMs: 60_000
    }
  ]);

  constructor({ config, services, options = {} } = {}) {
    super({ config, services, options });
    this.tokenRevocation = services.require("tokenRevocation");
    this.scheduler = services.require("scheduler");
  }

  async initialize() {
    this.scheduler.register(this);
  }

  async run() {
    await this.tokenRevocation.purge();
  }
}
