import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { up as addIdempotencyLeaseOwner } from "../database/migrations/0001_add_idempotency_lease_owner.js";

const databaseDirectory = fileURLToPath(new URL("../database/", import.meta.url));

test("framework SQL files don't hard-code a database name", async () => {
  const files = await readdir(`${databaseDirectory}framework/`);

  for (const file of files.filter((name) => name.endsWith(".sql"))) {
    const sql = await readFile(`${databaseDirectory}framework/${file}`, "utf8");

    assert.doesNotMatch(
      sql,
      /^\s*USE\s/im,
      `${file} 不應該寫死 USE 陳述式——連線已經指向 DB_NAME 指定的資料庫`
    );
  }
});

test("migrations directory files are named for a stable execution order", async () => {
  const entries = await readdir(`${databaseDirectory}migrations/`);
  const names = entries.filter((name) => name.endsWith(".sql") || name.endsWith(".js"));

  assert.ok(names.length > 0, "database/migrations/ 底下應該有檔案");

  for (const name of names) {
    assert.match(
      name,
      /^\d{4}_/,
      `${name} 應該用 4 位數字前綴命名，讓執行順序不必依賴檔案系統列出順序`
    );
  }
});

test("0001_add_idempotency_lease_owner adds the column when it's missing", async () => {
  const calls = [];
  const connection = {
    query: async (sql) => {
      calls.push(sql);
      if (sql.includes("information_schema")) {
        return [[]];
      }
      return [{ affectedRows: 0 }];
    }
  };

  await addIdempotencyLeaseOwner(connection);

  assert.equal(calls.length, 2);
  assert.match(calls[1], /ALTER TABLE fr_idempotency_keys ADD COLUMN lease_owner/);
});

test("0001_add_idempotency_lease_owner is a no-op once the column already exists", async () => {
  const calls = [];
  const connection = {
    query: async (sql) => {
      calls.push(sql);
      return [[{ COLUMN_NAME: "lease_owner" }]];
    }
  };

  await addIdempotencyLeaseOwner(connection);

  assert.equal(calls.length, 1);
});
