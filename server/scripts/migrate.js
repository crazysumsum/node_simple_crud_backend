/**
 * 套用框架的資料庫 schema，並在 fr_schema_migrations 記錄套過哪些檔案。
 *
 * 取代原本「照 README 手動一個個跑 framework/*.sql，改 schema 時再手動下
 * ALTER」的流程：這裡把同一批 SQL 檔案（加上 database/migrations/ 底下處理
 * 既有部署差異的檔案）包成可重複執行的步驟——每個檔案只會真的套用一次，
 * 重跑會直接跳過已經套用的部分，適合放進部署流程而不用先確認資料庫現況。
 *
 * 連線一律用 DB_NAME 指定的資料庫（跟應用程式執行期用的是同一份設定），
 * SQL 檔案本身不再寫死資料庫名稱。
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import databaseConfig from "../config/database.js";
import { normalizeDatabaseConfig } from "../src/framework/configuration/normalizeDatabaseConfig.js";
import { createMySqlDatabasePool } from "../src/services/mysqldatabase/connection.js";

const databaseDirectory = fileURLToPath(new URL("../database/", import.meta.url));

// 框架的建表 SQL。順序固定寫死，不靠檔案系統列出的順序——彼此之間沒有外鍵
// 關聯，但固定順序讓每次執行的行為都可預期。
const FRAMEWORK_SQL_FILES = [
  "framework/idempotency.sql",
  "framework/jwt.sql",
  "framework/scheduler.sql"
];

async function loadDeltaMigrations() {
  const directory = path.join(databaseDirectory, "migrations");
  const entries = await readdir(directory).catch((error) => {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  });

  return entries
    .filter((name) => name.endsWith(".sql") || name.endsWith(".js"))
    .sort()
    .map((name) => `migrations/${name}`);
}

async function ensureMigrationsTable(connection) {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS fr_schema_migrations (
      name VARCHAR(190) NOT NULL,
      applied_at BIGINT UNSIGNED NOT NULL,
      PRIMARY KEY (name)
    )
  `);
}

async function isApplied(connection, name) {
  const [rows] = await connection.query(
    "SELECT 1 FROM fr_schema_migrations WHERE name = ?",
    [name]
  );
  return rows.length > 0;
}

async function recordApplied(connection, name) {
  await connection.query(
    "INSERT INTO fr_schema_migrations (name, applied_at) VALUES (?, ?)",
    [name, Date.now()]
  );
}

async function applySql(connection, name) {
  const sql = await readFile(path.join(databaseDirectory, name), "utf8");
  await connection.query(sql);
}

async function applyJs(connection, name) {
  const module = await import(pathToFileURL(path.join(databaseDirectory, name)).href);
  await module.up(connection);
}

async function migrate() {
  // 用跟應用程式執行期一樣的路徑正規化設定：config/database.js 的 ssl 是
  // { enabled, ca, rejectUnauthorized } 這種給人讀的形狀，直接把它塞進
  // mysql2 的 ssl 選項會不管 enabled 是不是 false 都建出一個物件、逼出 TLS
  // 交握。normalizeDatabaseConfig 才會把它轉成 mysql2 認得的形狀（停用時是
  // undefined）。
  //
  // multipleStatements：framework SQL 檔案裡不只一句 CREATE/ALTER，一般執行期
  // 的連線池不會開這個選項——只有這支腳本讀的是受信任的本機檔案，不是使用者
  // 輸入，開了也不會多出注入面。
  const pool = createMySqlDatabasePool({
    ...normalizeDatabaseConfig(databaseConfig),
    multipleStatements: true
  });
  const connection = await pool.getConnection();

  try {
    await ensureMigrationsTable(connection);

    const names = [...FRAMEWORK_SQL_FILES, ...(await loadDeltaMigrations())];

    for (const name of names) {
      if (await isApplied(connection, name)) {
        console.log(`skip   ${name} (already applied)`);
        continue;
      }

      if (name.endsWith(".js")) {
        await applyJs(connection, name);
      } else {
        await applySql(connection, name);
      }

      await recordApplied(connection, name);
      console.log(`applied ${name}`);
    }
  } finally {
    connection.release();
    await pool.end();
  }
}

migrate()
  .then(() => {
    console.log("Migrations complete.");
  })
  .catch((error) => {
    console.error("Migration failed:", error);
    process.exitCode = 1;
  });
