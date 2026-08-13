import { BaseService } from "../../../framework/services/BaseService.js";

/**
 * 清除過期的限流記錄。
 *
 * 記憶體限流 store 的清理原本只掛在 consume() 上，所以一台沒有流量的實例永遠
 * 不會清——最後一波訪客的記錄會一直留在記憶體裡。那個流量觸發的路徑刻意保留，
 * 排程停用時只是退回「有流量才清」，清理能力不會整個消失。
 *
 * 這件工作獨立成一個檔案，而不是掛在 RequestLimiterService 的 static jobs 上，
 * 是為了把排程器依賴隔離在一個沒有人依賴的葉子裡。掛在限流器身上的話，停用
 * 排程器會讓限流器建構失敗，而框架用 get() 取限流器——結果是「關掉排程器」
 * 靜默地換來「關掉限流」，最壞的一種耦合。
 *
 * scope 維持 instance：記憶體 store 在各自的行程裡，每個實例都得清自己的。
 * 共享 adapter 通常靠儲存層的 TTL 過期，purge() 預設是 no-op。
 *
 * 刪除的判準是「桶已經完全回滿」，不是「桶存在很久了」。RequestLimiterService
 * 傳的 before 是 now - ipWindowMs，而從空桶回滿正好需要 ipWindowMs，所以兩者
 * 剛好對齊。放寬這個條件會把還沒回滿的桶一起刪掉——那等於把剩下的配額免費送
 * 給那個 IP，而且沒有任何症狀。
 */
export class RateLimitPurgeJob extends BaseService {
  static service = Object.freeze({
    name: "job.rateLimitPurge",
    lifecycle: "singleton",
    dependencies: ["scheduler", "requestLimiter"],
    eager: true
  });

  static jobs = Object.freeze([
    {
      name: "requestLimit.purge",
      method: "run",
      intervalMs: 60_000,
      timeoutMs: 10_000
    }
  ]);

  constructor({ config, services, options = {} } = {}) {
    super({ config, services, options });
    this.requestLimiter = services.require("requestLimiter");
    this.scheduler = services.require("scheduler");
  }

  async initialize() {
    this.scheduler.register(this);
  }

  async run() {
    await this.requestLimiter.purge();
  }
}
