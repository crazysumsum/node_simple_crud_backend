import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { describeMissingTable } from "../src/services/mysqldatabase/missingTableError.js";
import { MySqlJobLeaseStore } from "../src/services/scheduler/JobLeaseStore.js";

// 框架自己建的表以 fr_ 前綴命名，並放在 database/framework/ 底下。前綴回答的是
// 「這張表誰擁有、升級框架時什麼會變」——那個問題在只有一個 init.sql 的時候
// 無從回答。

const databaseDirectory = fileURLToPath(new URL("../database/", import.meta.url));

async function sqlFor(name) {
  return readFile(`${databaseDirectory}${name}`, "utf8");
}

test("every table created under database/framework uses the fr_ prefix", async () => {
  const files = await readdir(`${databaseDirectory}framework/`);
  const tables = [];

  for (const file of files.filter((name) => name.endsWith(".sql"))) {
    const sql = await sqlFor(`framework/${file}`);

    for (const [, table] of sql.matchAll(/CREATE TABLE IF NOT EXISTS\s+(\w+)/gi)) {
      tables.push({ file, table });
    }
  }

  assert.ok(tables.length > 0, "framework/ 底下應該有建表語句");

  for (const { file, table } of tables) {
    assert.ok(
      table.startsWith("fr_"),
      `${file} 建立了沒有 fr_ 前綴的表：${table}`
    );
  }
});

test("init.sql creates no framework table and no business table carries the prefix", async () => {
  const sql = await sqlFor("init.sql");
  const tables = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS\s+(\w+)/gi)].map(
    ([, table]) => table
  );

  // 業務資料與框架資料分開，是為了讓升級框架時該跑哪些 SQL 一目了然。
  for (const table of tables) {
    assert.equal(
      table.startsWith("fr_"),
      false,
      `init.sql 不該建立框架表：${table}`
    );
  }
});

test("the framework SQL files match the tables the code actually queries", async () => {
  const scheduler = await sqlFor("framework/scheduler.sql");
  const jwt = await sqlFor("framework/jwt.sql");

  // 表名寫死在 DDL 裡，所以它不可設定；漏改一邊只會在執行期炸出
  // ER_NO_SUCH_TABLE，那正是這個檢查要提前抓到的。
  assert.match(scheduler, /CREATE TABLE IF NOT EXISTS fr_job_leases/);
  assert.match(scheduler, /CREATE TABLE IF NOT EXISTS fr_job_stats/);
  assert.match(jwt, /CREATE TABLE IF NOT EXISTS fr_token_revocations/);

  const leaseStoreSource = await readFile(
    fileURLToPath(new URL("../src/services/scheduler/JobLeaseStore.js", import.meta.url)),
    "utf8"
  );
  const statsStoreSource = await readFile(
    fileURLToPath(new URL("../src/services/scheduler/JobStatsStore.js", import.meta.url)),
    "utf8"
  );
  const revocationSource = await readFile(
    fileURLToPath(
      new URL("../src/services/tokenRevocation/TokenRevocationService.js", import.meta.url)
    ),
    "utf8"
  );

  assert.equal(leaseStoreSource.includes("fr_job_leases"), true);
  assert.equal(statsStoreSource.includes("fr_job_stats"), true);
  assert.equal(revocationSource.includes("fr_token_revocations"), true);

  // 改名漏掉一句 SQL 的話，那一句會在執行期才失敗——而 acquire()／release()
  // 只在 cluster 工作真的觸發時才跑，可能好幾小時後才發現。
  assert.equal(
    leaseStoreSource.replace(/fr_job_leases/g, "").includes("job_leases"),
    false,
    "還有沒有加上 fr_ 前綴的舊表名"
  );
});

test("a missing table says which SQL file creates it", () => {
  // 框架的 DDL 現在有三個檔案，所以「忘了跑其中一個」是很容易犯的錯，而裸的
  // ER_NO_SUCH_TABLE 只會說表不見了，不會說它本來該從哪裡來。
  const original = Object.assign(new Error("MySQL database execute failed"), {
    cause: Object.assign(new Error("Table 'erp_dev.fr_job_leases' doesn't exist"), {
      code: "ER_NO_SUCH_TABLE"
    })
  });

  const described = describeMissingTable(original, {
    table: "fr_job_leases",
    sqlFile: "server/database/framework/scheduler.sql"
  });

  assert.match(described.message, /Table "fr_job_leases" does not exist/);
  assert.match(described.message, /server\/database\/framework\/scheduler\.sql/);
  assert.equal(described.cause, original);
});

test("an unrelated database error is passed through untouched", () => {
  // 誤判成缺表會把一個連線問題導向完全錯誤的排查方向。
  const connectionRefused = Object.assign(new Error("connect ECONNREFUSED"), {
    cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })
  });

  assert.equal(
    describeMissingTable(connectionRefused, { table: "fr_x", sqlFile: "x.sql" }),
    connectionRefused
  );
  assert.equal(
    describeMissingTable(new Error("plain"), { table: "fr_x", sqlFile: "x.sql" }).message,
    "plain"
  );
});

test("the lease store turns a missing table into an actionable error", async () => {
  const database = {
    withTransaction: async () => {},
    execute: async () => {
      throw Object.assign(new Error("MySQL database execute failed"), {
        cause: Object.assign(new Error("no such table"), { code: "ER_NO_SUCH_TABLE" })
      });
    }
  };
  const store = new MySqlJobLeaseStore({ database });

  // prepare() 是第一個碰這張表的地方，所以缺表一定在這裡先浮現。
  await assert.rejects(
    () => store.prepare(["some.job"]),
    /Table "fr_job_leases" does not exist\. Run server\/database\/framework\/scheduler\.sql/
  );
});
