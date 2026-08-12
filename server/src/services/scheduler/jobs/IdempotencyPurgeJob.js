import { BaseService } from "../../../framework/services/BaseService.js";

/**
 * 刪除過期的 idempotency 紀錄。
 *
 * scope 必須是 cluster：mysql adapter 的表是所有實例共用的，每台都掃一次就是
 * 把同一個 DELETE 重複 N 次。改成 instance 不會產生錯誤結果（DELETE 是冪等
 * 的），只會白白增加資料庫負載——這種錯誤不會壞掉任何東西，所以也不會有人
 * 發現。
 *
 * memory adapter 的 purge() 是 no-op：它有自己的節流掃描，而且狀態隨程序消失。
 * 兩種 adapter 都能跑這個 job，只是其中一種沒事做。
 */
export class IdempotencyPurgeJob extends BaseService {
  static service = Object.freeze({
    name: "job.idempotencyPurge",
    lifecycle: "singleton",
    dependencies: ["scheduler", "idempotency"],
    eager: true
  });

  static jobs = Object.freeze([
    {
      name: "idempotency.purge",
      method: "run",
      scope: "cluster",
      // 預設 TTL 以小時計，所以每 15 分鐘掃一次足以讓表維持在穩態大小。
      intervalMs: 900_000,
      timeoutMs: 60_000
    }
  ]);

  constructor({ config, services, options = {} } = {}) {
    super({ config, services, options });
    this.idempotency = services.require("idempotency");
    this.scheduler = services.require("scheduler");
  }

  async initialize() {
    this.scheduler.register(this);
  }

  async run() {
    await this.idempotency.purge();
  }
}
