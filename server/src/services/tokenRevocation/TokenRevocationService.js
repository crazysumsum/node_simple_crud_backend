import { BaseService } from "../../framework/services/BaseService.js";
import { describeMissingTable } from "../mysqldatabase/missingTableError.js";
import { normalizeTokenRevocationConfig } from "./normalizeTokenRevocationConfig.js";

const TABLE = "fr_token_revocations";
const SQL_FILE = "server/database/framework/jwt.sql";

/**
 * JWT 撤銷。
 *
 * JWT 是自證的：簽章對、還沒過期，就有效。要在到期前作廢它，唯一的辦法是在
 * 驗證之後加一道查詢——而那道查詢絕不能是每個請求打一次資料庫。
 *
 * 所以撤銷用「切線」表示：一個使用者一列，記下「這個時間點之前簽發的 token
 * 全部作廢」。整張表小到可以整份載入記憶體（一個使用者一列，不是一個 token
 * 一列），請求路徑只做一次 Map 查詢與一次數字比較。定時工作負責把快照刷新。
 *
 * 代價是撤銷有延遲上界，等於刷新間隔。那個上界是明碼寫出來的設定
 * （maxStalenessSeconds），而且啟動時會與實際的刷新間隔交叉檢查，不會變成一個
 * 只有讀原始碼才知道的數字。
 *
 * 這個 service 只提供能力，不決定什麼時候撤銷。登出、強制下線、改密碼這些
 * 觸發點屬於業務 handler，注入它並呼叫 revoke() 即可。
 */
export class TokenRevocationService extends BaseService {
  static service = Object.freeze({
    name: "tokenRevocation",
    lifecycle: "singleton",
    dependencies: ["mysqldatabase", "logging", "time"],
    eager: true
  });

  constructor({ config, services, options = {} } = {}) {
    super({ config, services, options });
    this.revocationConfig = normalizeTokenRevocationConfig(config?.tokenRevocation);
    this.database = services.require("mysqldatabase");
    this.logger = services.require("logging").logger;
    this.time = services.require("time");

    // subject -> 切線（UNIX 秒）。空 Map 代表「沒有人被撤銷」，而不是「還沒
    // 載入」——後者由 loadedAtMs 為 null 表示，兩者必須分得開。
    this.snapshot = new Map();
    this.loadedAtMs = null;
    this.lastFailureAtMs = null;
  }

  async initialize() {
    // 阻塞式首載。若在第一次載入完成前就開始服務請求，所有已撤銷的 token 都會
    // 被短暫接受——而那正是撤銷最需要生效的時刻（剛發生資安事件、剛開除員工）。
    // 載入失敗就啟動失敗，符合「啟動成功就代表狀態穩定」的規則。執行期的刷新
    // 失敗則是 fail open，那是另一回事：見 refresh()。
    await this.load();
  }

  /**
   * token 是否已被撤銷。這是熱路徑，每個帶 JWT 的請求都會走一次。
   */
  isRevoked(claims) {
    const subject = claims?.sub;

    if (subject === undefined || subject === null) {
      return false;
    }

    const revokedBefore = this.snapshot.get(String(subject));

    if (revokedBefore === undefined) {
      return false;
    }

    const issuedAt = claims?.iat;

    // iat 缺失的 token 無從與切線比較。jsonwebtoken 預設一定會帶 iat，所以少了
    // 它代表這個 token 是用 noTimestamp 簽的或是手工造的。放行的話它會天然免疫
    // 於所有撤銷——這正是攻擊者想要的那種 token。
    if (!Number.isFinite(issuedAt)) {
      return true;
    }

    return issuedAt < revokedBefore;
  }

  /**
   * 撤銷一個 subject 在此刻之前簽發的所有 token。
   */
  async revoke(subject, { reason = "" } = {}) {
    const key = String(subject ?? "").trim();

    if (!key) {
      throw new TypeError("Token revocation requires a subject");
    }

    // 切線取自資料庫時鐘而不是本機時鐘：多實例的機器時鐘不保證同步，用本機
    // 時間會讓一台機器上簽發的 token 逃過另一台機器發起的撤銷。
    //
    // +1 秒是為了蓋掉同一秒簽發的 token。iat 只有秒精度，切線若正好等於當下
    // 這一秒，同一秒內簽發的 token 會因為 iat < revokedBefore 不成立而存活。
    const [rows] = await this.database.query(
      "SELECT UNIX_TIMESTAMP() + 1 AS cutoff"
    );
    const cutoff = Number(rows[0].cutoff);

    await this.database.execute(
      `INSERT INTO ${TABLE} (subject, revoked_before, reason, updated_at)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         revoked_before = GREATEST(revoked_before, VALUES(revoked_before)),
         reason = VALUES(reason),
         updated_at = VALUES(updated_at)`,
      [key, cutoff, String(reason).slice(0, 190), cutoff]
    );

    // GREATEST 保證資料庫端的切線只會往後推。本機快照要照同一條規則更新，
    // 否則兩個實例同時撤銷時，較舊的那個切線會在本機蓋掉較新的。
    this.snapshot.set(key, Math.max(this.snapshot.get(key) ?? 0, cutoff));

    await this.logger.info(
      "auth.revocation.recorded",
      "Tokens issued before the cutoff were revoked",
      { subject: key, revokedBefore: cutoff, reason: String(reason) }
    );

    return cutoff;
  }

  /**
   * 重新載入快照。由 TokenRevocationRefreshJob 排程。
   *
   * 失敗時 fail open：保留舊快照繼續服務，已撤銷的 token 會在資料庫恢復之前
   * 繼續有效。反過來（fail closed）會讓一次資料庫抖動變成全站登出，把認證服務
   * 變成 DoS 放大器；而這裡的攻擊窗口上界是故障時長，且攻擊者需要一個「已經
   * 被撤銷」的 token 才吃得到。
   *
   * fail open 的前提是失效看得見，所以失敗記 error，並附上快照年齡。
   */
  async refresh() {
    try {
      await this.load();
      this.lastFailureAtMs = null;
      return true;
    } catch (error) {
      this.lastFailureAtMs = this.time.nowMs();
      await this.logger.error(
        "auth.revocation.refresh_failed",
        "Token revocation snapshot refresh failed; serving a stale snapshot",
        {
          error: { name: error.name, message: error.message },
          // 「撤銷已經失效多久」是這則日誌唯一真正要回答的問題。
          snapshotAgeSeconds: this.snapshotAgeSeconds(),
          cachedSubjects: this.snapshot.size
        }
      );
      return false;
    }
  }

  /** 快照距離上次成功載入過了多久（秒）。從未載入成功時回傳 null。 */
  snapshotAgeSeconds() {
    if (this.loadedAtMs === null) {
      return null;
    }

    return Math.max(0, Math.round((this.time.nowMs() - this.loadedAtMs) / 1000));
  }

  /** 刪除早已無意義的切線。由 TokenRevocationPurgeJob 以 cluster scope 排程。 */
  async purge() {
    const [result] = await this.database.execute(
      `DELETE FROM ${TABLE}
       WHERE revoked_before < UNIX_TIMESTAMP() - ?`,
      [this.revocationConfig.retentionSeconds]
    );
    const removedSubjects = Number(result?.affectedRows ?? 0);

    if (removedSubjects > 0) {
      await this.logger.info(
        "auth.revocation.purged",
        "Expired token revocation rows were removed",
        {
          removedSubjects,
          retentionSeconds: this.revocationConfig.retentionSeconds
        }
      );
    }

    return removedSubjects;
  }

  async load() {
    let rows;

    try {
      [rows] = await this.database.query(
        `SELECT subject, revoked_before FROM ${TABLE}`
      );
    } catch (error) {
      throw describeMissingTable(error, { table: TABLE, sqlFile: SQL_FILE });
    }

    const snapshot = new Map();

    for (const row of rows) {
      snapshot.set(String(row.subject), Number(row.revoked_before));
    }

    if (snapshot.size > this.revocationConfig.maxCachedSubjects) {
      // 繼續載入而不是拒絕：撤銷名單異常增長是要看見的訊號，但把它變成啟動
      // 失敗，等於讓一個監控問題升級成服務中斷。
      await this.logger.warn(
        "auth.revocation.snapshot_oversized",
        "Token revocation snapshot exceeded the configured subject limit",
        {
          cachedSubjects: snapshot.size,
          maxCachedSubjects: this.revocationConfig.maxCachedSubjects
        }
      );
    }

    this.snapshot = snapshot;
    this.loadedAtMs = this.time.nowMs();
    return snapshot.size;
  }
}
