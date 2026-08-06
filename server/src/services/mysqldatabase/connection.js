import mysql from "mysql2/promise";
import databaseConfig from "../../../config/database.js";

export function createMySqlDatabasePool(config = databaseConfig) {
  const {
    queryTimeoutMs: _queryTimeoutMs,
    transactionTimeoutMs: _transactionTimeoutMs,
    ...poolConfig
  } = config;
  return mysql.createPool(poolConfig);
}

export async function checkMySqlDatabaseConnection(pool) {
  if (!pool || typeof pool.query !== "function") {
    throw new TypeError("A MySQL connection pool is required");
  }

  const [rows] = await pool.query("SELECT 1 AS ok");
  return rows[0]?.ok === 1;
}
