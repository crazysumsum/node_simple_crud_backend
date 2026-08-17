import { describeMissingTable } from "../mysqldatabase/missingTableError.js";

/**
 * scope: "cluster" 的工作在執行前必須先取得租約，確保同一輪只有一個實例執行。
 *
 * 語意是 at-least-once，不是 exactly-once。持有者若在執行途中崩潰，租約會過期
 * 讓其他實例在下一輪接手，而崩潰前已經做到一半的事不會被回復——跨程序崩潰的
 * exactly-once 在這個層級做不到，工作本身必須是可重入的。
 */
export class JobLeaseStore {
  /**
   * 必須是原子操作：同一個 jobName 同時被多個實例呼叫時，只有一個能得到 true。
   *
   * options 可以帶一個 signal：呼叫端的等待逾時後會 abort 它，實作應該盡力
   * 中斷還在進行中的取得動作，而不是讓它繼續跑到底——逾時之後沒有人會再
   * await 這個 promise，跑到底而且成功的話，租約會沒有人釋放。
   * @returns {Promise<boolean>} 是否取得租約
   */
  async acquire(_jobName, _options) {
    throw new Error(`${this.constructor.name} must implement acquire()`);
  }

  /** 釋放租約，讓下一輪可以由任何實例執行。釋放失敗不應讓工作視為失敗。 */
  async release(_jobName, _owner) {}

  /** 預先建立列，讓 acquire() 只需要處理「列已存在」這一種情況。 */
  async prepare(_jobNames) {}

  async close() {}
}

/**
 * MySQL 實作。
 *
 * 用交易加 SELECT ... FOR UPDATE 而不是把判斷塞進一句
 * INSERT ... ON DUPLICATE KEY UPDATE：後者需要依賴 MySQL 對 SET 子句的求值
 * 順序，正確與否取決於欄位的排列，讀的人幾乎不可能一眼看出對錯。租約競爭本來
 * 就不頻繁（cluster 工作依定義是低頻的），沒有理由用可讀性換那點效能。
 *
 * prepare() 會預先插入所有 cluster 工作的列，因此 acquire() 永遠是對既有列加
 * 記錄鎖，不會產生間隙鎖，也就沒有幻讀與死鎖的問題。
 */
export class MySqlJobLeaseStore extends JobLeaseStore {
  constructor({ database }) {
    super();

    if (!database || typeof database.withTransaction !== "function") {
      throw new TypeError("MySqlJobLeaseStore requires the mysqldatabase service");
    }

    this.database = database;
  }

  async prepare(jobNames) {
    for (const jobName of jobNames) {
      try {
        // 已存在就什麼都不做；expires_at 為 0 代表沒有人持有。
        await this.database.execute(
          `INSERT INTO fr_job_leases (job_name, owner, acquired_at, expires_at)
           VALUES (?, '', 0, 0)
           ON DUPLICATE KEY UPDATE job_name = job_name`,
          [jobName]
        );
      } catch (error) {
        // prepare() 是第一個碰這張表的地方，所以缺表一定在這裡先浮現。
        throw describeMissingTable(error, {
          table: "fr_job_leases",
          sqlFile: "server/database/framework/scheduler.sql"
        });
      }
    }
  }

  async acquire(jobName, { owner, leaseMs, signal }) {
    const leaseSeconds = Math.max(1, Math.ceil(leaseMs / 1000));

    return this.database.withTransaction(
      async (transaction) => {
        const [clock] = await transaction.query("SELECT UNIX_TIMESTAMP() AS now");
        const now = Number(clock[0].now);
        const [rows] = await transaction.query(
          "SELECT owner, expires_at FROM fr_job_leases WHERE job_name = ? FOR UPDATE",
          [jobName]
        );
        const existing = rows[0];

        // prepare() 應該已經建好列。沒有列代表有人手動刪了表內容，此時讓這一輪
        // 跳過並在下次 prepare 補回，比在這裡默默插入安全。
        if (!existing) {
          return false;
        }

        if (Number(existing.expires_at) > now && existing.owner !== owner) {
          return false;
        }

        await transaction.execute(
          "UPDATE fr_job_leases SET owner = ?, acquired_at = ?, expires_at = ? WHERE job_name = ?",
          [owner, now, now + leaseSeconds, jobName]
        );
        return true;
      },
      // signal 讓呼叫端（排程器）能在自己的逾時發生時中斷這筆交易，而不是讓
      // 它跑到底才發現已經沒有人在等結果了。
      { signal }
    );
  }

  async release(jobName, owner) {
    // 只釋放自己持有的。租約若已經過期並被別人接手，這裡不能把它踢掉。
    await this.database.execute(
      "UPDATE fr_job_leases SET expires_at = 0 WHERE job_name = ? AND owner = ?",
      [jobName, owner]
    );
  }
}
