import { BaseService } from "../../framework/services/BaseService.js";
import { describeMissingTable } from "../mysqldatabase/missingTableError.js";
import { normalizeTokenRevocationConfig } from "./normalizeTokenRevocationConfig.js";

const TABLE = "fr_token_versions";
const SQL_FILE = "server/database/framework/jwt.sql";

/**
 * JWT 撤銷。
 *
 * JWT 是自證的：簽章對、還沒過期，就有效。要在到期前作廢它，唯一的辦法是在
 * 驗證之後加一道查詢——而那道查詢絕不能是每個請求打一次資料庫。
 *
 * 所以撤銷用「版本號」表示：一個使用者一列，記著一個單調遞增的計數器。token
 * 帶著簽發當下的 ver，比目前版本舊就是已撤銷。整張表小到可以整份載入記憶體
 * （一個使用者一列，不是一個 token 一列），請求路徑只做一次 Map 查詢與一次
 * 數字比較。定時工作負責把快照刷新。「小到」由 maxCachedSubjects 強制執行
 * ——見 load()。
 *
 * 上一版用時間切線（「這個時間點之前簽發的全部作廢」）。換掉它是因為那等於
 * 拿時間當版本號，於是每個毛病都跟時鐘有關：iat 取自簽發節點的時鐘而切線取自
 * 資料庫時鐘，偏快的節點簽出的 token 逃得掉；切線只有秒精度所以要 +1 秒去蓋
 * 同一秒；列刪得比 token 壽命早，已撤銷的 token 就會復活。計數器沒有這些問題
 * ——ver < version 兩邊都不是時間——而且列永久保留，連清理工作都不需要。
 *
 * 代價是簽發時要知道版本號，也就是登入時多一次查詢（見 currentVersion()）。
 * 登入本來就在打資料庫，而換到的是一整類無聲失效的消失。
 *
 * 撤銷仍然有延遲上界，等於刷新間隔——快照是每個實例自己的記憶體。那個上界是
 * 明碼寫出來的設定（maxStalenessSeconds），啟動時會與實際的刷新間隔交叉檢查。
 * 刷新失敗時舊快照還能撐多久，同樣是設定（maxFailOpenSeconds），超過就熔斷
 * ——見 snapshotUsable()。
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

    // subject -> 目前版本號。空 Map 代表「沒有人被撤銷」，而不是「還沒載入」
    // ——後者由 loadedAtMs 為 null 表示，兩者必須分得開。
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
    const subject = String(claims?.sub ?? "").trim();

    // sub 缺失就沒有 key 可查，唯一 fail closed 的答案是「當作已撤銷」。與下面
    // iat 缺失同一條規則：無從判斷就不放行。放行的話那個 token 對所有撤銷免疫。
    //
    // JwtService.verify() 已經先擋掉這種 token，所以正常路徑走不到這裡；這一行
    // 是留給未來其他呼叫端的，那時它們不必再自己想一次這個問題。
    if (!subject) {
      return true;
    }

    const version = claims?.ver;

    // ver 缺失的 token 無從與版本號比較。issue() 一定會帶它，所以少了它代表這個
    // token 是舊版簽的或是手工造的。放行的話它會天然免疫於所有撤銷——這正是
    // 攻擊者想要的那種 token，所以 fail closed。
    //
    // 這也是換掉切線之後唯一的相容性斷點：部署當下所有既存 token 一起失效。
    if (!Number.isInteger(version)) {
      return true;
    }

    // 沒有列代表從未撤銷過，等同版本 0——與 DEFAULT 1 的第一次撤銷銜接得上。
    return version < (this.snapshot.get(subject) ?? 0);
  }

  /**
   * 這個 subject 目前的版本號。簽發時要把它放進 token 的 ver。
   *
   * 讀資料庫而不是讀快照：快照可以落後 maxStalenessSeconds，用它簽出來的 token
   * 會在下一次刷新時被自己的實例判成過期。登入不是熱路徑，而且本來就在打資料
   * 庫，多這一次查詢換到的是「剛簽的 token 一定是有效的」。
   */
  async currentVersion(subject) {
    const key = String(subject ?? "").trim();

    if (!key) {
      throw new TypeError("Token revocation requires a subject");
    }

    let rows;

    try {
      [rows] = await this.database.query(
        `SELECT version FROM ${TABLE} WHERE subject = ?`,
        [key]
      );
    } catch (error) {
      throw describeMissingTable(error, { table: TABLE, sqlFile: SQL_FILE });
    }

    return rows.length === 0 ? 0 : Number(rows[0].version);
  }

  /**
   * 撤銷一個 subject 目前已經簽出去的所有 token。
   */
  async revoke(subject, { reason = "" } = {}) {
    const key = String(subject ?? "").trim();

    if (!key) {
      throw new TypeError("Token revocation requires a subject");
    }

    // version + 1 在資料庫裡算，不在這裡算：兩個實例同時撤銷同一個人時，各自
    // 讀到的舊值會是同一個，在應用層加一會讓其中一次撤銷被另一次蓋掉。交給
    // MySQL 做就是原子的，而且完全不牽涉任何一邊的時鐘。
    await this.database.execute(
      `INSERT INTO ${TABLE} (subject, version, reason, updated_at)
       VALUES (?, 1, ?, UNIX_TIMESTAMP())
       ON DUPLICATE KEY UPDATE
         version = version + 1,
         reason = VALUES(reason),
         updated_at = VALUES(updated_at)`,
      [key, String(reason).slice(0, 190)]
    );

    const version = await this.currentVersion(key);

    // 讀回來的值可能比這次寫的還新（別的實例也剛撤銷過）。那沒關係，也不該退
    // 回去：版本號只會往前，本機快照領先只代表多擋掉一些本來就要被擋的 token。
    this.snapshot.set(key, Math.max(this.snapshot.get(key) ?? 0, version));

    await this.logger.info(
      "auth.revocation.recorded",
      "The subject's token version was bumped; every token issued before it is now invalid",
      { subject: key, version, reason: String(reason) }
    );

    return version;
  }

  /**
   * 重新載入快照。由 TokenRevocationRefreshJob 排程。
   *
   * 失敗時 fail open：保留舊快照繼續服務，已撤銷的 token 會在資料庫恢復之前
   * 繼續有效。反過來（fail closed）會讓一次資料庫抖動變成全站登出，把認證服務
   * 變成 DoS 放大器。
   *
   * 但這個理由只對「抖動」成立，所以 fail open 有時間盒：快照超過
   * maxFailOpenSeconds 之後由 snapshotUsable() 熔斷。沒有上界的話，一張單獨
   * 壞掉的表就能讓撤銷靜默失效好幾個小時——其餘 SQL 照常，/health 是綠的。
   *
   * fail open 的前提是失效看得見，所以失敗記 error 並附上快照年齡，而且
   * TokenRevocationRefreshJob 會把它變成一次失敗的工作，寫進排程器的統計表。
   */
  async refresh() {
    try {
      await this.load();

      // 沒有這則日誌的話，「一片 error 之後恢復」與「一片 error 之後行程死掉」
      // 在日誌上長得一模一樣。停擺多久也只有這裡答得出來。
      if (this.lastFailureAtMs !== null) {
        await this.logger.info(
          "auth.revocation.recovered",
          "Token revocation snapshot refresh recovered",
          {
            outageSeconds: Math.max(
              0,
              Math.round((this.time.nowMs() - this.lastFailureAtMs) / 1000)
            ),
            cachedSubjects: this.snapshot.size
          }
        );
      }

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

  /**
   * 快照是否還在可信範圍內。false 代表撤銷判斷已經不能當數。
   *
   * isRevoked() 刻意不看年齡——它回答的是「這個版本號算不算舊」，那是一個純粹
   * 的比較。快照本身還算不算數是另一個問題，答錯的後果也不同（一個是放行錯的
   * 人，一個是整批人進不來），所以分成兩個問題問。
   */
  snapshotUsable() {
    if (this.loadedAtMs === null) {
      return false;
    }

    if (this.revocationConfig.failureMode === "open") {
      return true;
    }

    return this.snapshotAgeSeconds() <= this.revocationConfig.maxFailOpenSeconds;
  }

  /** 快照距離上次成功載入過了多久（秒）。從未載入成功時回傳 null。 */
  snapshotAgeSeconds() {
    if (this.loadedAtMs === null) {
      return null;
    }

    return Math.max(0, Math.round((this.time.nowMs() - this.loadedAtMs) / 1000));
  }

  /**
   * 本機時鐘與資料庫時鐘差多少。
   *
   * 撤銷本身已經不看時鐘了——版本號的比較兩邊都不是時間。但 token 的 iat 與
   * exp 仍然由簽發那台機器的時鐘決定，而驗證是在另一台機器上、只帶
   * clockToleranceSeconds（預設 5 秒）的容忍。一台快五分鐘的機器簽出來的
   * token，在每一台機器上都多活五分鐘；慢的那台簽出來的則會被提早當成過期。
   *
   * 這是唯一還有機器在管的共用時鐘，所以順手在刷新時量一次。只量測與記錄，
   * 不補償：時鐘該由 NTP 修，不該由應用層猜著補。
   */
  async #reportClockSkew(dbNowSeconds) {
    const skewSeconds = Math.round(this.time.nowMs() / 1000) - dbNowSeconds;

    if (Math.abs(skewSeconds) <= this.revocationConfig.maxClockSkewSeconds) {
      return;
    }

    await this.logger.error(
      "auth.revocation.clock_skew",
      "This node's clock disagrees with the database clock; token lifetimes will be wrong by that much",
      {
        skewSeconds,
        maxClockSkewSeconds: this.revocationConfig.maxClockSkewSeconds
      }
    );
  }

  async load() {
    let clockRows;
    let rows;

    // maxCachedSubjects 是記憶體上限，不是事後才看的門檻：LIMIT 讓查詢本身
    // 就不會讀進超過預算的列，所以峰值記憶體是設定的函數，不是這張表大小的
    // 函數。多要一列（+1）只是用來分辨「剛好等於上限」與「超過上限」，那一列
    // 永遠不會被放進快照。
    const budget = this.revocationConfig.maxCachedSubjects;

    try {
      // 兩次查詢而不是一次 JOIN：時鐘與名單是兩件無關的事，湊在一句 SQL 裡只會
      // 讓「表不見了」與「時鐘讀不到」在錯誤訊息上分不開。刷新間隔是 30 秒，
      // 多一次 SELECT UNIX_TIMESTAMP() 的成本可以忽略。
      [clockRows] = await this.database.query("SELECT UNIX_TIMESTAMP() AS db_now");
      // LIMIT 不能用佔位符：MySQL 的 binary protocol 會以 ER_WRONG_ARGUMENTS
      // 拒絕 `LIMIT ?`（見 MySqlIdempotencyStore.purge()）。這裡內插的是通過
      // normalizeTokenRevocationConfig 驗證過的正整數設定值，不是外部輸入，
      // 沒有注入面。
      [rows] = await this.database.query(
        `SELECT subject, version FROM ${TABLE} LIMIT ${budget + 1}`
      );
    } catch (error) {
      throw describeMissingTable(error, { table: TABLE, sqlFile: SQL_FILE });
    }

    // 排在溢位檢查之前：溢位是一場會持續一陣子的故障，時鐘監控不該跟著停掉。
    await this.#reportClockSkew(Number(clockRows[0].db_now));

    if (rows.length > budget) {
      // 截斷的快照比沒有快照更糟：落在 LIMIT 界外的 subject 會靜默地免疫於
      // 撤銷，而呼叫端看不出這份快照是殘的——那正是這整個模組要防的無聲失效。
      //
      // 所以溢位算一次載入失敗，交給既有的階梯處理：initialize() 時是啟動
      // 失敗；refresh() 時舊快照原封不動、記 refresh_failed、排程器記一次
      // 失敗工作，撐過 maxFailOpenSeconds 之後由 snapshotUsable() 熔斷成 jwt
      // route 的 503。
      await this.logger.error(
        "auth.revocation.snapshot_oversized",
        "Token revocation snapshot exceeded the configured subject limit; refusing to load a truncated one",
        {
          maxCachedSubjects: budget,
          snapshotAgeSeconds: this.snapshotAgeSeconds()
        }
      );
      throw new Error(
        `Token revocation snapshot exceeds maxCachedSubjects (${budget}). Loading it fully ` +
          "would risk exhausting the heap, and a truncated snapshot would silently exempt " +
          "the subjects it omits. Raise tokenRevocation.maxCachedSubjects after checking the " +
          `process has headroom for it, or find out why ${TABLE} grew this large.`
      );
    }

    const snapshot = new Map();

    for (const row of rows) {
      snapshot.set(String(row.subject), Number(row.version));
    }

    this.snapshot = snapshot;
    this.loadedAtMs = this.time.nowMs();
    return snapshot.size;
  }
}
