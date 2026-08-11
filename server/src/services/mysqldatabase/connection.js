import mysql from "mysql2/promise";
import databaseConfig from "../../../config/database.js";
import { revealSecret } from "../../framework/configuration/SecretValue.js";

/**
 * 把應用設定翻譯成 mysql2 的連線池選項。
 *
 * 抽成純函式是為了測得到：這是整個系統裡少數該把密鑰攤開的地方之一，而
 * mysql.createPool 本身無法在單元測試裡呼叫，弄錯的話症狀是啟動時連不上資料庫。
 */
export function mySqlPoolOptions(config) {
  const {
    queryTimeoutMs: _queryTimeoutMs,
    transactionTimeoutMs: _transactionTimeoutMs,
    ...poolConfig
  } = config;

  return {
    ...poolConfig,
    // 正規化後的設定裡 password 是 SecretValue，mysql2 需要真正的字串。
    // 預設參數走的是尚未正規化的設定檔，所以兩種形式都要接。
    password: revealSecret(poolConfig.password)
  };
}

export function createMySqlDatabasePool(config = databaseConfig) {
  return mysql.createPool(mySqlPoolOptions(config));
}

export async function checkMySqlDatabaseConnection(pool) {
  if (!pool || typeof pool.query !== "function") {
    throw new TypeError("A MySQL connection pool is required");
  }

  const [rows] = await pool.query("SELECT 1 AS ok");
  return rows[0]?.ok === 1;
}
