import { describeMissingTable } from "../mysqldatabase/missingTableError.js";
import { IdempotencyStore } from "./IdempotencyStore.js";

const TABLE = "fr_idempotency_keys";
const SQL_FILE = "server/database/framework/idempotency.sql";
// 一次 DELETE 掃掉數百萬列會長時間持有鎖，所以分批刪。批次大小是「單次 DELETE
// 不要鎖太久」的取捨，與部署規模無關，所以是常數；每輪能刪幾批則取決於流量，
// 由 purgeMaxBatches 設定。
const PURGE_BATCH_SIZE = 1000;

/**
 * 共享的 idempotency store。
 *
 * 記憶體 adapter 的狀態在各自的行程裡，所以多實例部署下同一個 key 打到不同
 * 實例會各自認為自己是第一個——負載平衡輪詢時那是常態而不是邊緣情況。這個
 * adapter 用資料庫的主鍵當互斥鎖，讓「誰先搶到這個 key」有唯一答案。
 *
 * 互斥靠 INSERT 本身，不靠交易：
 *
 * - `INSERT ... ON DUPLICATE KEY UPDATE` 配 IF(過期) 判斷，正確與否取決於
 *   SET 子句的求值順序，讀的人幾乎不可能一眼看出對錯。JobLeaseStore 已經為了
 *   同一個理由否決過那個寫法。
 * - 交易加 `SELECT ... FOR UPDATE`（JobLeaseStore 的做法）在這裡不成立：那個
 *   做法能避開間隙鎖，是因為 prepare() 預先插好所有列。idempotency key 是無界
 *   且即時產生的，對不存在的列加鎖會產生間隙鎖，相鄰 key 的併發插入會死鎖。
 *
 * 所以：INSERT 成功就是搶到，ER_DUP_ENTRY 就是輸了，再去讀那一列決定回什麼。
 * 快樂路徑一句 SQL、無交易、無間隙鎖。
 */
export class MySqlIdempotencyStore extends IdempotencyStore {
  constructor({
    database,
    time,
    maxResponseBytes = 1048576,
    purgeMaxBatches = 50
  } = {}) {
    super();

    if (!database || typeof database.execute !== "function") {
      throw new TypeError("MySqlIdempotencyStore requires the mysqldatabase service");
    }

    if (!time || typeof time.nowMs !== "function") {
      throw new TypeError("MySqlIdempotencyStore requires a time service");
    }

    this.database = database;
    this.time = time;
    this.maxResponseBytes = maxResponseBytes;
    this.purgeMaxBatches = purgeMaxBatches;
  }

  async begin(key, { fingerprint, ttlMs, pendingLeaseMs = ttlMs, owner = "" }) {
    if (await this.claim(key, fingerprint, pendingLeaseMs, owner)) {
      return { state: "started" };
    }

    const existing = await this.readLive(key);

    if (existing) {
      return this.classify(existing, fingerprint);
    }

    // 有列擋著 INSERT，但它已經過期。刪掉再搶一次——只搶一次，避免兩個實例
    // 互相刪掉對方的列而永遠繞下去。
    await this.deleteExpired(key);

    if (await this.claim(key, fingerprint, pendingLeaseMs, owner)) {
      return { state: "started" };
    }

    const winner = await this.readLive(key);

    // 對手在這幾微秒之間搶走了。讀不到列代表它又立刻結束並被清掉，回
    // inProgress 讓客戶端重試——比假設自己贏了而重複執行安全。
    return winner ? this.classify(winner, fingerprint) : { state: "inProgress" };
  }

  /**
   * INSERT 成功即取得這個 key；主鍵衝突代表別人先到。
   *
   * owner 隨這次 claim 一起寫入，是後面 complete／fail／markUnavailable 唯一
   * 能證明「這一列還是我的」的憑證。租約過期後別人可以刪掉這列重搶，那一刻
   * 起 owner 就換了人——原本的呼叫者拿著舊值回來寫，WHERE 會擋下它，而不是
   * 讓它覆寫或刪掉接手者的資料。
   */
  async claim(key, fingerprint, pendingLeaseMs, owner) {
    try {
      await this.database.execute(
        `INSERT INTO ${TABLE} (store_key, fingerprint, state, lease_owner, expires_at)
         VALUES (?, ?, 'pending', ?, UNIX_TIMESTAMP() + ?)`,
        [key, fingerprint, owner, this.leaseSeconds(pendingLeaseMs)]
      );
      return true;
    } catch (error) {
      if (error?.cause?.code === "ER_DUP_ENTRY") {
        return false;
      }

      throw describeMissingTable(error, { table: TABLE, sqlFile: SQL_FILE });
    }
  }

  classify(row, fingerprint) {
    if (row.fingerprint !== fingerprint) {
      return { state: "conflict" };
    }

    if (row.state === "pending") {
      return { state: "inProgress" };
    }

    // 成功執行過，但回應沒有保存。不能當成 replay——那會回一個空 body 給
    // 客戶端，讓它以為那就是原本的回應。
    if (row.state === "unavailable") {
      return { state: "completedWithoutResponse" };
    }

    return {
      state: "replay",
      response: {
        statusCode: Number(row.status_code),
        body: row.response === null ? undefined : JSON.parse(row.response)
      }
    };
  }

  /** 過期的列一律當作不存在，判斷交給 SQL 的 WHERE 而不是讀出來再比。 */
  async readLive(key) {
    const [rows] = await this.database.query(
      `SELECT fingerprint, state, status_code, response
       FROM ${TABLE}
       WHERE store_key = ? AND expires_at > UNIX_TIMESTAMP()`,
      [key]
    );

    return rows[0] ?? null;
  }

  async deleteExpired(key) {
    await this.database.execute(
      `DELETE FROM ${TABLE} WHERE store_key = ? AND expires_at <= UNIX_TIMESTAMP()`,
      [key]
    );
  }

  /**
   * 回傳這次寫入是否真的套用到那一列（affectedRows === 1）。false 代表租約
   * 在這次呼叫抵達前就已經易主：owner 不比對的話，pendingLeaseMs 保護不了
   * 「同一列被兩個持有者輪流覆寫」，只保護得了「已完成的列被誤判成 pending」。
   */
  async complete(key, response, { ttlMs, owner = "" }) {
    const body = response.body === undefined ? null : JSON.stringify(response.body);

    if (body !== null && Buffer.byteLength(body, "utf8") > this.maxResponseBytes) {
      // 只拋錯，不動那一列。先前這裡會先 fail()——也就是釋放 key——好讓重試
      // 拿得到一個回應，代價是已經成功的業務操作再執行一次。那不是罕見的
      // 競態，是任何回應超過上限的 route 每一次都會發生的事。
      //
      // 現在由呼叫端決定怎麼收尾（markUnavailable），store 不做策略決定。
      throw new Error(
        `Idempotent response is ${Buffer.byteLength(body, "utf8")} bytes, over the ${this.maxResponseBytes} byte limit`
      );
    }

    // state='pending' 擋掉一個晚到的寫入覆蓋已完成的紀錄；lease_owner 擋掉一個
    // 晚到的寫入覆蓋「租約過期後被別的持有者接手、但還在 pending」的那一列——
    // 前者防的是狀態倒退，後者防的是張冠李戴，state 相同擋不住它。
    const [result] = await this.database.execute(
      `UPDATE ${TABLE}
       SET state = 'completed',
           status_code = ?,
           response = ?,
           expires_at = UNIX_TIMESTAMP() + ?
       WHERE store_key = ? AND state = 'pending' AND lease_owner = ?`,
      [Number(response.statusCode), body, this.leaseSeconds(ttlMs), key, owner]
    );

    return Number(result?.affectedRows ?? 0) === 1;
  }

  /**
   * 記下「成功執行完，但回應沒有保存」。expires_at 用完整的 TTL——租約的作用是
   * 讓崩潰的實例解鎖，而這裡已經確定執行完了。回傳值意義同 complete()。
   */
  async markUnavailable(key, { ttlMs, owner = "" }) {
    // 條件與 complete() 同一組理由：state='pending' 擋狀態倒退，lease_owner
    // 擋張冠李戴。
    const [result] = await this.database.execute(
      `UPDATE ${TABLE}
       SET state = 'unavailable',
           status_code = NULL,
           response = NULL,
           expires_at = UNIX_TIMESTAMP() + ?
       WHERE store_key = ? AND state = 'pending' AND lease_owner = ?`,
      [this.leaseSeconds(ttlMs), key, owner]
    );

    return Number(result?.affectedRows ?? 0) === 1;
  }

  /** 只釋放自己仍持有、且仍在處理中的列。回傳值意義同 complete()。 */
  async fail(key, owner = "") {
    // 已完成的紀錄必須留到 TTL 結束，否則一次晚到的釋放會把一個可重播的回應
    // 刪掉；lease_owner 則擋掉一次晚到的釋放刪掉別人已經接手的租約。
    const [result] = await this.database.execute(
      `DELETE FROM ${TABLE} WHERE store_key = ? AND state = 'pending' AND lease_owner = ?`,
      [key, owner]
    );

    return Number(result?.affectedRows ?? 0) === 1;
  }

  async purge() {
    let removed = 0;

    for (let batch = 0; batch < this.purgeMaxBatches; batch += 1) {
      // LIMIT 不能用佔位符：MySQL 的 binary protocol 會以
      // ER_WRONG_ARGUMENTS 拒絕 `LIMIT ?`。這裡內插的是一個模組常數，不是
      // 任何外部輸入，所以沒有注入面。
      const [result] = await this.database.execute(
        `DELETE FROM ${TABLE} WHERE expires_at <= UNIX_TIMESTAMP() LIMIT ${PURGE_BATCH_SIZE}`
      );
      const affected = Number(result?.affectedRows ?? 0);
      removed += affected;

      // 沒刪滿一批代表已經沒有過期的列了。
      if (affected < PURGE_BATCH_SIZE) {
        return { removed, exhausted: false };
      }
    }

    // 批次上限用完，而最後一批還是滿的——很可能還有沒刪到的。剛好整除時這會
    // 是個假警報，但寧可偶爾多叫一聲，也不要讓「清理追不上」一直沒有訊號。
    return { removed, exhausted: true };
  }

  /** 秒是資料庫時鐘的精度；不足一秒的租約會立刻過期，所以至少給一秒。 */
  leaseSeconds(milliseconds) {
    return Math.max(1, Math.ceil(milliseconds / 1000));
  }
}
