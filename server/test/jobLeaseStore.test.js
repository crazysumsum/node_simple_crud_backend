import assert from "node:assert/strict";
import test from "node:test";
import {
  JobLeaseStore,
  MySqlJobLeaseStore
} from "../src/services/scheduler/JobLeaseStore.js";

// 這是 cluster 工作唯一的互斥機制：它出錯的後果是同一輪在多個實例上重複執行。
// 假資料庫只實作這個 store 真正用到的那幾句 SQL，讓判斷邏輯確實被執行到。

function fakeDatabase({ now = 1000, rows = new Map(), onTransaction } = {}) {
  const log = [];

  const runStatement = (sql, params) => {
    log.push({ sql: sql.replace(/\s+/g, " ").trim(), params });

    if (sql.includes("SELECT UNIX_TIMESTAMP()")) {
      return [[{ now: state.now }]];
    }

    if (sql.includes("SELECT owner, expires_at")) {
      const row = rows.get(params[0]);
      return [row ? [{ ...row }] : []];
    }

    if (sql.startsWith("UPDATE fr_job_leases SET owner")) {
      const [owner, acquiredAt, expiresAt, jobName] = params;
      rows.set(jobName, { owner, acquired_at: acquiredAt, expires_at: expiresAt });
      return [{ affectedRows: 1 }];
    }

    if (sql.includes("SET expires_at = 0")) {
      const [jobName, owner] = params;
      const row = rows.get(jobName);

      // 只釋放自己持有的，這正是要驗證的條件。
      if (row && row.owner === owner) {
        rows.set(jobName, { ...row, expires_at: 0 });
        return [{ affectedRows: 1 }];
      }

      return [{ affectedRows: 0 }];
    }

    if (sql.includes("INSERT INTO fr_job_leases")) {
      const [jobName] = params;

      if (!rows.has(jobName)) {
        rows.set(jobName, { owner: "", acquired_at: 0, expires_at: 0 });
      }

      return [{ affectedRows: 1 }];
    }

    throw new Error(`Unexpected SQL: ${sql}`);
  };

  const state = {
    now,
    rows,
    log,
    async withTransaction(work, options) {
      log.push({ transaction: options ?? {} });

      if (onTransaction) {
        await onTransaction();
      }

      return work({
        query: async (sql, params) => runStatement(sql, params),
        execute: async (sql, params) => runStatement(sql, params)
      });
    },
    async execute(sql, params) {
      return runStatement(sql, params);
    }
  };

  return state;
}

test("the base class refuses to be used without an acquire implementation", async () => {
  class Incomplete extends JobLeaseStore {}

  await assert.rejects(
    () => new Incomplete().acquire("job", {}),
    /Incomplete must implement acquire\(\)/
  );
  // release/prepare/close 有可用的預設值，不強制實作。
  await new Incomplete().release("job", "owner");
  await new Incomplete().prepare(["job"]);
  await new Incomplete().close();
});

test("the store requires a database that can run transactions", () => {
  assert.throws(
    () => new MySqlJobLeaseStore({}),
    /requires the mysqldatabase service/
  );
  assert.throws(
    () => new MySqlJobLeaseStore({ database: { execute: async () => {} } }),
    /requires the mysqldatabase service/
  );
});

test("prepare seeds a row so acquire only ever locks an existing one", async () => {
  const database = fakeDatabase();
  const store = new MySqlJobLeaseStore({ database });

  await store.prepare(["a.job", "b.job"]);

  assert.deepEqual([...database.rows.keys()], ["a.job", "b.job"]);
  assert.deepEqual(database.rows.get("a.job"), {
    owner: "",
    acquired_at: 0,
    expires_at: 0
  });

  // 再次 prepare 不得覆蓋既有的持有者。
  database.rows.set("a.job", { owner: "A", acquired_at: 5, expires_at: 999 });
  await store.prepare(["a.job"]);
  assert.equal(database.rows.get("a.job").owner, "A");
});

test("an unheld lease is granted and recorded with an expiry", async () => {
  const database = fakeDatabase({ now: 1000 });
  const store = new MySqlJobLeaseStore({ database });
  await store.prepare(["a.job"]);

  assert.equal(await store.acquire("a.job", { owner: "A", leaseMs: 30_000 }), true);
  assert.deepEqual(database.rows.get("a.job"), {
    owner: "A",
    acquired_at: 1000,
    expires_at: 1030
  });

  // 用資料庫的時鐘而不是應用實例的，多實例之間才不會因為時鐘偏移而互相踩踏。
  assert.ok(database.log.some(({ sql }) => sql?.includes("SELECT UNIX_TIMESTAMP()")));
  // 讀取要加鎖，否則兩個實例可能同時判斷「沒人持有」。
  assert.ok(database.log.some(({ sql }) => sql?.includes("FOR UPDATE")));
});

test("a lease held by someone else is refused until it expires", async () => {
  const database = fakeDatabase({ now: 1000 });
  const store = new MySqlJobLeaseStore({ database });
  await store.prepare(["a.job"]);
  await store.acquire("a.job", { owner: "A", leaseMs: 30_000 });

  assert.equal(await store.acquire("a.job", { owner: "B", leaseMs: 30_000 }), false);
  assert.equal(database.rows.get("a.job").owner, "A", "拒絕時不得改動持有者");

  // 持有者崩潰後租約自然過期，其他實例才能接手——這是 at-least-once 的來源。
  database.now = 1031;
  assert.equal(await store.acquire("a.job", { owner: "B", leaseMs: 30_000 }), true);
  assert.equal(database.rows.get("a.job").owner, "B");
});

test("the holder can renew its own unexpired lease", async () => {
  const database = fakeDatabase({ now: 1000 });
  const store = new MySqlJobLeaseStore({ database });
  await store.prepare(["a.job"]);
  await store.acquire("a.job", { owner: "A", leaseMs: 30_000 });

  database.now = 1010;
  assert.equal(await store.acquire("a.job", { owner: "A", leaseMs: 30_000 }), true);
  assert.equal(database.rows.get("a.job").expires_at, 1040);
});

test("release frees only the caller's own lease", async () => {
  const database = fakeDatabase({ now: 1000 });
  const store = new MySqlJobLeaseStore({ database });
  await store.prepare(["a.job"]);
  await store.acquire("a.job", { owner: "A", leaseMs: 30_000 });

  // 非持有者的釋放不得生效，否則任何實例都能把別人的工作踢掉。
  await store.release("a.job", "B");
  assert.equal(database.rows.get("a.job").expires_at, 1030);
  assert.equal(await store.acquire("a.job", { owner: "B", leaseMs: 30_000 }), false);

  await store.release("a.job", "A");
  assert.equal(database.rows.get("a.job").expires_at, 0);
  assert.equal(await store.acquire("a.job", { owner: "B", leaseMs: 30_000 }), true);
});

test("a missing row is refused rather than silently recreated", async () => {
  const database = fakeDatabase({ now: 1000 });
  const store = new MySqlJobLeaseStore({ database });

  // prepare() 應該已經建好列。沒有列代表有人動了表，這一輪跳過比默默插入安全。
  assert.equal(await store.acquire("never.prepared", { owner: "A", leaseMs: 30_000 }), false);
  assert.equal(database.rows.has("never.prepared"), false);
});

test("a sub-second lease still reserves at least one second", async () => {
  const database = fakeDatabase({ now: 1000 });
  const store = new MySqlJobLeaseStore({ database });
  await store.prepare(["a.job"]);

  // expires_at 的粒度是秒，向下取整成 0 會讓租約立刻過期。
  await store.acquire("a.job", { owner: "A", leaseMs: 200 });
  assert.equal(database.rows.get("a.job").expires_at, 1001);
});

test("acquire threads the caller's signal into the transaction so it can be cancelled", async () => {
  const database = fakeDatabase({ now: 1000 });
  const store = new MySqlJobLeaseStore({ database });
  await store.prepare(["a.job"]);

  const controller = new AbortController();
  await store.acquire("a.job", { owner: "A", leaseMs: 30_000, signal: controller.signal });

  const transactionCall = database.log.find((entry) => "transaction" in entry);
  assert.equal(
    transactionCall.transaction.signal,
    controller.signal,
    "逾時時排程器要能中斷還在飛的交易，而不是讓它跑到底才發現沒人在等"
  );
});

test("a transaction failure propagates so the scheduler can report it", async () => {
  const database = fakeDatabase({
    onTransaction: () => {
      throw new Error("database is unreachable");
    }
  });
  const store = new MySqlJobLeaseStore({ database });

  // 吞掉的話排程器會以為自己沒拿到租約，而真正的原因永遠不會浮現。
  await assert.rejects(
    () => store.acquire("a.job", { owner: "A", leaseMs: 30_000 }),
    /database is unreachable/
  );
});
