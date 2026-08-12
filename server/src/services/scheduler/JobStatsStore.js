import { describeMissingTable } from "../mysqldatabase/missingTableError.js";

const TABLE = "fr_job_stats";
const SQL_FILE = "server/database/framework/scheduler.sql";

/**
 * 排程統計的發佈目的地。
 *
 * 抽成介面不是為了將來換 Redis，而是為了讓「統計寫不進去」在測試裡是一個能構造
 * 出來的情況——那條路徑必須降級而不是讓應用崩潰，所以它需要被測到。
 */
export class JobStatsStore {
  /** 寫入這個實例當下的統計。同一個 (instance_id, job_name) 重複覆蓋。 */
  async write(_rows) {}

  /** 刪除超過 staleAfterMs 沒有更新的列，也就是崩潰實例留下的。 */
  async purgeStale(_staleAfterMs) {
    return 0;
  }

  /** 刪除某個實例的所有列。正常關機時用。 */
  async deleteInstance(_instanceId) {}

  async close() {}
}

/**
 * MySQL 實作。
 *
 * 寫入是 UPSERT：一列代表「某個實例的某件工作現在是什麼狀態」，不是一筆歷史。
 *
 * updated_at 一律取資料庫時鐘 UNIX_TIMESTAMP()，而 last_* 是實例自己量的。
 * 兩者混用是刻意的：過期判斷必須在所有實例之間可比較，所以要用同一個時鐘；
 * 而工作實際何時開始、跑了多久，只有那個行程知道。
 */
export class MySqlJobStatsStore extends JobStatsStore {
  constructor({ database }) {
    super();

    if (!database || typeof database.execute !== "function") {
      throw new TypeError("MySqlJobStatsStore requires the mysqldatabase service");
    }

    this.database = database;
  }

  async write(rows) {
    // 逐列寫。工作數是個位數，攢成一句多值 INSERT 只省下幾個來回，卻要動態
    // 拼接佔位符——這裡沒有值得用可讀性換的東西。
    for (const row of rows) {
      try {
        await this.database.execute(
          `INSERT INTO ${TABLE} (
             instance_id, job_name, host, address, scope,
             last_started_at, last_finished_at, last_success_at,
             last_outcome, last_duration_ms, last_error,
             runs, failures, timeouts,
             skipped_overlapping, skipped_not_leader, consecutive_failures,
             updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UNIX_TIMESTAMP())
           ON DUPLICATE KEY UPDATE
             host = VALUES(host),
             address = VALUES(address),
             scope = VALUES(scope),
             last_started_at = VALUES(last_started_at),
             last_finished_at = VALUES(last_finished_at),
             last_success_at = VALUES(last_success_at),
             last_outcome = VALUES(last_outcome),
             last_duration_ms = VALUES(last_duration_ms),
             last_error = VALUES(last_error),
             runs = VALUES(runs),
             failures = VALUES(failures),
             timeouts = VALUES(timeouts),
             skipped_overlapping = VALUES(skipped_overlapping),
             skipped_not_leader = VALUES(skipped_not_leader),
             consecutive_failures = VALUES(consecutive_failures),
             updated_at = VALUES(updated_at)`,
          [
            row.instanceId,
            row.jobName,
            row.host,
            row.address,
            row.scope,
            row.lastStartedAt,
            row.lastFinishedAt,
            row.lastSuccessAt,
            row.lastOutcome,
            row.lastDurationMs,
            row.lastError,
            row.runs,
            row.failures,
            row.timeouts,
            row.skippedOverlapping,
            row.skippedNotLeader,
            row.consecutiveFailures
          ]
        );
      } catch (error) {
        throw describeMissingTable(error, { table: TABLE, sqlFile: SQL_FILE });
      }
    }
  }

  async purgeStale(staleAfterMs) {
    // 秒是資料庫時鐘的精度。至少一秒，否則 0 會把剛寫好的列一起刪掉。
    const staleSeconds = Math.max(1, Math.ceil(staleAfterMs / 1000));
    const [result] = await this.database.execute(
      `DELETE FROM ${TABLE} WHERE updated_at <= UNIX_TIMESTAMP() - ?`,
      [staleSeconds]
    );
    return Number(result?.affectedRows ?? 0);
  }

  async deleteInstance(instanceId) {
    await this.database.execute(`DELETE FROM ${TABLE} WHERE instance_id = ?`, [instanceId]);
  }
}
