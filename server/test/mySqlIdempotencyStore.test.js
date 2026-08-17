import assert from "node:assert/strict";
import test from "node:test";
import { MySqlIdempotencyStore } from "../src/services/idempotency/MySqlIdempotencyStore.js";
import { createTestTime } from "../test-support/createTestTime.js";

// 這個 adapter 的存在理由只有一個：多實例部署下同一個 key 只能執行一次。互斥
// 靠主鍵，所以假資料庫必須真的模擬主鍵衝突，否則測試會通過而叢集會重複執行。

const OPTIONS = { fingerprint: "fp-1", ttlMs: 60000, pendingLeaseMs: 5000, owner: "owner-1" };

function duplicateKeyError() {
  return Object.assign(new Error("MySQL database execute failed"), {
    cause: Object.assign(new Error("Duplicate entry"), { code: "ER_DUP_ENTRY" })
  });
}

/**
 * 一張以 Map 模擬的表，含主鍵約束與 expires_at 語意。
 * dbNowSeconds 可控，才測得出租約與 TTL 的邊界。
 *
 * 每個 WHERE 條件只在 SQL 真的帶了它的時候才生效。這一點很重要：假資料庫若
 * 自己替生產程式碼把關（不管送來的 SQL 長怎樣都套用過期與 pending 判斷），
 * 那麼刪掉那些條件測試照樣全綠——突變測試就是這樣抓到第一版的。
 */
function fakeDatabase({ dbNowSeconds = 1000 } = {}) {
  const rows = new Map();
  const state = { dbNowSeconds, statements: [] };
  const live = (row) => row && row.expires_at > state.dbNowSeconds;

  const run = async (sql, params = []) => {
    const text = sql.replace(/\s+/g, " ").trim();
    state.statements.push(text);

    if (text.startsWith("INSERT INTO fr_idempotency_keys")) {
      const [store_key, fingerprint, lease_owner, leaseSeconds] = params;

      // 主鍵約束：已存在就衝突，不管過期沒有——過期的列仍然佔著主鍵。
      if (rows.has(store_key)) {
        throw duplicateKeyError();
      }

      rows.set(store_key, {
        store_key,
        fingerprint,
        state: "pending",
        lease_owner,
        status_code: null,
        response: null,
        expires_at: state.dbNowSeconds + leaseSeconds
      });
      return [{ affectedRows: 1 }];
    }

    if (text.startsWith("SELECT fingerprint")) {
      const row = rows.get(params[0]);
      const filtersExpired = text.includes("expires_at > UNIX_TIMESTAMP()");

      if (!row || (filtersExpired && !live(row))) {
        return [[]];
      }

      return [[{ ...row }]];
    }

    if (text.startsWith("DELETE FROM fr_idempotency_keys WHERE store_key = ? AND expires_at")) {
      const row = rows.get(params[0]);

      if (row && !live(row)) {
        rows.delete(params[0]);
        return [{ affectedRows: 1 }];
      }

      return [{ affectedRows: 0 }];
    }

    if (
      text.startsWith("DELETE FROM fr_idempotency_keys WHERE store_key = ?") &&
      !text.includes("expires_at")
    ) {
      const guardsOwner = text.includes("lease_owner = ?");
      const store_key = params[0];
      const ownerParam = guardsOwner ? params[1] : undefined;
      const row = rows.get(store_key);
      const guardsPending = text.includes("state = 'pending'");

      if (
        row &&
        (!guardsPending || row.state === "pending") &&
        (!guardsOwner || row.lease_owner === ownerParam)
      ) {
        rows.delete(store_key);
        return [{ affectedRows: 1 }];
      }

      return [{ affectedRows: 0 }];
    }

    if (text.startsWith("UPDATE fr_idempotency_keys")) {
      // 目標狀態從 SET 子句讀出來，而不是寫死成 completed：complete() 與
      // markUnavailable() 都走這個分支，寫死的話後者會被當成前者，測試就看不出
      // 兩者的差別。
      const targetState = text.match(/SET state = '(\w+)'/)[1];
      const guardsOwner = text.includes("lease_owner = ?");
      const store_key = guardsOwner ? params.at(-2) : params.at(-1);
      const ownerParam = guardsOwner ? params.at(-1) : undefined;
      const row = rows.get(store_key);
      const guardsPending = text.includes("state = 'pending'");

      if (
        !row ||
        (guardsPending && row.state !== "pending") ||
        (guardsOwner && row.lease_owner !== ownerParam)
      ) {
        return [{ affectedRows: 0 }];
      }

      const ttlSeconds = guardsOwner ? params.at(-3) : params.at(-2);
      Object.assign(row, {
        state: targetState,
        // 跟其他分支同一個原則：只有 SQL 真的寫了才套用。
        status_code: text.includes("status_code = NULL") ? null : params[0],
        response: text.includes("response = NULL") ? null : params[1],
        expires_at: state.dbNowSeconds + ttlSeconds
      });
      return [{ affectedRows: 1 }];
    }

    if (text.startsWith("DELETE FROM fr_idempotency_keys WHERE expires_at")) {
      // LIMIT 是內插的常數而不是佔位符——真 MySQL 的 binary protocol 不接受
      // `LIMIT ?`，而先前的假資料庫照單全收，所以這個限制只有實機才發現得了。
      const limit = Number(text.match(/LIMIT (\d+)$/)[1]);
      let affected = 0;

      for (const [key, row] of rows) {
        if (affected >= limit) {
          break;
        }

        if (row.expires_at <= state.dbNowSeconds) {
          rows.delete(key);
          affected += 1;
        }
      }

      return [{ affectedRows: affected }];
    }

    throw new Error(`Unexpected SQL: ${text}`);
  };

  return { rows, state, query: run, execute: run };
}

function createStore(overrides = {}) {
  const database = fakeDatabase(overrides.database);
  const store = new MySqlIdempotencyStore({
    database,
    time: createTestTime(),
    maxResponseBytes: overrides.maxResponseBytes ?? 1048576,
    purgeMaxBatches: overrides.purgeMaxBatches ?? 50
  });

  return { store, database };
}

// --- 互斥 --------------------------------------------------------------------

test("only one caller wins the same key, the other sees it in progress", async () => {
  const { store } = createStore();

  assert.deepEqual(await store.begin("k", OPTIONS), { state: "started" });
  // 第二個實例：INSERT 撞主鍵，讀到 pending。
  assert.deepEqual(await store.begin("k", OPTIONS), { state: "inProgress" });
});

test("two concurrent begins on one key produce exactly one winner", async () => {
  const { store } = createStore();

  const results = await Promise.all([
    store.begin("k", OPTIONS),
    store.begin("k", OPTIONS),
    store.begin("k", OPTIONS)
  ]);

  // 這是整個 adapter 的存在理由。多於一個 started 就代表叢集會重複執行。
  assert.equal(results.filter(({ state }) => state === "started").length, 1);
  assert.equal(results.filter(({ state }) => state === "inProgress").length, 2);
});

test("a different fingerprint on the same key is a conflict", async () => {
  const { store } = createStore();

  await store.begin("k", OPTIONS);
  assert.deepEqual(await store.begin("k", { ...OPTIONS, fingerprint: "fp-2" }), {
    state: "conflict"
  });
});

// --- 重播 --------------------------------------------------------------------

test("a completed key replays its stored response", async () => {
  const { store } = createStore();

  await store.begin("k", OPTIONS);
  await store.complete("k", { statusCode: 201, body: { id: 7 } }, { ttlMs: 60000, owner: OPTIONS.owner });

  assert.deepEqual(await store.begin("k", OPTIONS), {
    state: "replay",
    response: { statusCode: 201, body: { id: 7 } }
  });
});

test("a stale owner's complete() is rejected, even while the row is still pending", async () => {
  // 這是租約易主真正會發生的順序：接手者還沒 complete，原持有者的晚到寫入
  // 就先到了。state='pending' 這個條件單獨擋不住它——那一刻兩邊看到的
  // state 都是 pending，唯一能分辨「這是誰的租約」的只有 lease_owner。
  const { store, database } = createStore();

  await store.begin("k", { ...OPTIONS, owner: "owner-A" });
  // 租約到期，另一個實例接手，但還沒來得及 complete。
  database.state.dbNowSeconds += 10;
  await store.begin("k", { ...OPTIONS, owner: "owner-B" });

  // A 這時才回來寫入——沒有 owner 比對的話這裡會成功並覆寫 B 的列。
  const staleWrite = await store.complete(
    "k",
    { statusCode: 201, body: { from: "A" } },
    { ttlMs: 60000, owner: "owner-A" }
  );
  assert.equal(staleWrite, false, "owner 對不上，寫入不該套用");
  assert.equal(database.rows.get("k").state, "pending", "B 的列不該被 A 的晚到寫入改動");

  // B 自己完成，這次 owner 對得上。
  const ownWrite = await store.complete(
    "k",
    { statusCode: 201, body: { from: "B" } },
    { ttlMs: 60000, owner: "owner-B" }
  );
  assert.equal(ownWrite, true);

  assert.deepEqual(await store.begin("k", { ...OPTIONS, owner: "owner-C" }), {
    state: "replay",
    response: { statusCode: 201, body: { from: "B" } }
  });
});

test("a stale owner's fail() does not release a lease it no longer holds", async () => {
  // 對應報告裡最容易踩到的那條路：逾時的 handler 拿到 504，504 不在
  // cacheableStatusCodes 裡，所以晚到的清理動作走的是 fail()，不是 complete()。
  // fail() 若不比對 owner，會把接手者仍在使用的租約整列刪掉，讓第三個呼叫者
  // 也搶到同一個 key，跟 B 同時執行同一件工作。
  const { store, database } = createStore();

  await store.begin("k", { ...OPTIONS, owner: "owner-A" });
  database.state.dbNowSeconds += 10;
  await store.begin("k", { ...OPTIONS, owner: "owner-B" });

  const released = await store.fail("k", "owner-A");
  assert.equal(released, false, "owner 對不上，不該釋放");
  assert.ok(database.rows.has("k"), "B 的租約必須還在");
  assert.equal(database.rows.get("k").lease_owner, "owner-B");

  // C 這時候搶同一個 key，必須看到 inProgress，而不是又搶到一次。
  assert.deepEqual(await store.begin("k", { ...OPTIONS, owner: "owner-C" }), {
    state: "inProgress"
  });
});

test("a stale owner's markUnavailable() does not lock a lease it no longer holds", async () => {
  const { store, database } = createStore();

  await store.begin("k", { ...OPTIONS, owner: "owner-A" });
  database.state.dbNowSeconds += 10;
  await store.begin("k", { ...OPTIONS, owner: "owner-B" });

  const applied = await store.markUnavailable("k", { ttlMs: 60000, owner: "owner-A" });
  assert.equal(applied, false, "owner 對不上，不該套用");
  assert.equal(database.rows.get("k").state, "pending", "B 的租約不該被鎖成 unavailable");
});

// --- 租約與過期 --------------------------------------------------------------

test("an expired pending lease releases the key to the next caller", async () => {
  const { store, database } = createStore();

  await store.begin("k", OPTIONS);
  assert.deepEqual(await store.begin("k", OPTIONS), { state: "inProgress" });

  // 實例崩潰了：列不會隨程序消失，租約是它唯一的解鎖方式。沒有這一段，
  // 一次崩潰會讓這個 key 卡在 409 直到完整的 TTL 到期。
  database.state.dbNowSeconds += 10;

  assert.deepEqual(await store.begin("k", OPTIONS), { state: "started" });
});

test("an expired completed record is not replayed", async () => {
  const { store, database } = createStore();

  await store.begin("k", OPTIONS);
  await store.complete("k", { statusCode: 201, body: { id: 1 } }, { ttlMs: 60000, owner: OPTIONS.owner });

  database.state.dbNowSeconds += 61;

  // TTL 是「回放能持續多久」的承諾。過期後必須重新執行。
  assert.deepEqual(await store.begin("k", OPTIONS), { state: "started" });
});

test("the pending lease is used for begin, and the full ttl only after completion", async () => {
  const { store, database } = createStore();

  await store.begin("k", { fingerprint: "fp-1", ttlMs: 600000, pendingLeaseMs: 5000, owner: "o" });
  assert.equal(database.rows.get("k").expires_at, database.state.dbNowSeconds + 5);

  await store.complete("k", { statusCode: 200, body: {} }, { ttlMs: 600000, owner: "o" });
  assert.equal(database.rows.get("k").expires_at, database.state.dbNowSeconds + 600);
});

// --- 釋放 --------------------------------------------------------------------

test("failing a key releases it, but never deletes a completed record", async () => {
  const { store } = createStore();

  await store.begin("k", OPTIONS);
  await store.fail("k", OPTIONS.owner);
  assert.deepEqual(await store.begin("k", OPTIONS), { state: "started" });

  await store.complete("k", { statusCode: 200, body: { id: 1 } }, { ttlMs: 60000, owner: OPTIONS.owner });
  // 一次晚到的釋放不能把一個還能重播的回應刪掉。
  await store.fail("k", OPTIONS.owner);
  assert.deepEqual(await store.begin("k", OPTIONS), {
    state: "replay",
    response: { statusCode: 200, body: { id: 1 } }
  });
});

// --- 回應體積 ----------------------------------------------------------------

test("an oversized response is refused without touching the row", async () => {
  const { store, database } = createStore({ maxResponseBytes: 64 });

  await store.begin("k", OPTIONS);
  await assert.rejects(
    () =>
      store.complete(
        "k",
        { statusCode: 200, body: { blob: "x".repeat(500) } },
        { ttlMs: 60000, owner: OPTIONS.owner }
      ),
    /over the 64 byte limit/
  );

  // 先前這裡會 fail()——釋放 key，好讓重試拿得到一個回應，代價是已經成功的
  // 業務操作再執行一次。那不是罕見的競態：任何回應超過上限的 route 每一次都
  // 會走到這裡。收尾是呼叫端的決定，store 不做策略。
  assert.equal(database.rows.get("k").state, "pending");
});

test("marking a key unavailable stops a retry from executing it again", async () => {
  const { store, database } = createStore();

  await store.begin("k", OPTIONS);
  await store.markUnavailable("k", { ttlMs: 60000, owner: OPTIONS.owner });

  const row = database.rows.get("k");
  assert.equal(row.state, "unavailable");
  assert.equal(row.status_code, null);
  assert.equal(row.response, null);

  // 這一列存在的唯一理由：讓重試拿到 409 而不是 started。
  assert.deepEqual(await store.begin("k", OPTIONS), {
    state: "completedWithoutResponse"
  });
});

test("marking unavailable uses the full ttl, not the pending lease", async () => {
  const { store, database } = createStore();

  await store.begin("k", { ...OPTIONS, ttlMs: 3_600_000, pendingLeaseMs: 5000 });
  const leaseExpiry = database.rows.get("k").expires_at;
  await store.markUnavailable("k", { ttlMs: 3_600_000, owner: OPTIONS.owner });

  // 租約的作用是讓崩潰的實例解鎖；這裡已經確定執行完了，這一列要活到重播窗口
  // 結束為止。沿用租約的話，保護會在幾秒後就消失。
  assert.ok(
    database.rows.get("k").expires_at > leaseExpiry,
    "unavailable 的存活時間必須長於 pending 租約"
  );
});

test("marking unavailable never downgrades an already cached response", async () => {
  const { store, database } = createStore();

  await store.begin("k", OPTIONS);
  await store.complete("k", { statusCode: 201, body: { id: 7 } }, { ttlMs: 60000, owner: OPTIONS.owner });
  // 晚到的一次呼叫不能把一個還能重播的回應改成「回應不見了」。
  await store.markUnavailable("k", { ttlMs: 60000, owner: OPTIONS.owner });

  assert.equal(database.rows.get("k").state, "completed");
  assert.deepEqual(await store.begin("k", OPTIONS), {
    state: "replay",
    response: { statusCode: 201, body: { id: 7 } }
  });
});

// --- 清理 --------------------------------------------------------------------

test("purge deletes only expired rows and reports the count", async () => {
  const { store, database } = createStore();

  await store.begin("stale", OPTIONS);
  await store.complete("stale", { statusCode: 200, body: {} }, { ttlMs: 1000, owner: OPTIONS.owner });
  database.state.dbNowSeconds += 2000;
  await store.begin("fresh", OPTIONS);

  assert.deepEqual(await store.purge(), { removed: 1, exhausted: false });
  assert.deepEqual([...database.rows.keys()], ["fresh"]);
});

test("purge deletes in batches so one run cannot lock the table for long", async () => {
  const { store, database } = createStore();

  for (let index = 0; index < 5; index += 1) {
    await store.begin(`k${index}`, OPTIONS);
  }

  database.state.dbNowSeconds += 10;
  await store.purge();

  const deletes = database.state.statements.filter((sql) =>
    sql.startsWith("DELETE FROM fr_idempotency_keys WHERE expires_at")
  );
  assert.equal(deletes.length, 1);
  assert.match(deletes[0], /LIMIT \d+$/);
});

// --- 契約 --------------------------------------------------------------------

test("the store refuses to build without a database or a time service", () => {
  assert.throws(
    () => new MySqlIdempotencyStore({ time: createTestTime() }),
    /requires the mysqldatabase service/
  );
  assert.throws(
    () => new MySqlIdempotencyStore({ database: fakeDatabase() }),
    /requires a time service/
  );
});

test("a missing table says which SQL file creates it", async () => {
  const database = fakeDatabase();
  database.execute = async () => {
    throw Object.assign(new Error("MySQL database execute failed"), {
      cause: Object.assign(new Error("no such table"), { code: "ER_NO_SUCH_TABLE" })
    });
  };
  const store = new MySqlIdempotencyStore({ database, time: createTestTime() });

  await assert.rejects(
    () => store.begin("k", OPTIONS),
    /Table "fr_idempotency_keys" does not exist\. Run server\/database\/framework\/idempotency\.sql/
  );
});

// --- 搶輸的那條路 --------------------------------------------------------------

/**
 * 依腳本回答的資料庫：用來重現「刪掉過期列之後、重試 INSERT 之前，被對手插隊」
 * 這個只有幾微秒的窗口。真實併發測不出它，但它決定了那一刻回什麼。
 */
function scriptedDatabase({ inserts, selects }) {
  const remainingInserts = [...inserts];
  const remainingSelects = [...selects];

  const run = async (sql) => {
    const text = sql.replace(/\s+/g, " ").trim();

    if (text.startsWith("INSERT")) {
      if (remainingInserts.shift() === "duplicate") {
        throw duplicateKeyError();
      }

      return [{ affectedRows: 1 }];
    }

    if (text.startsWith("SELECT")) {
      const row = remainingSelects.shift();
      return [row ? [row] : []];
    }

    return [{ affectedRows: 1 }];
  };

  return { query: run, execute: run };
}

test("losing the race after clearing an expired row answers inProgress", async () => {
  const store = new MySqlIdempotencyStore({
    // 兩次 INSERT 都撞主鍵，兩次 SELECT 都讀不到有效列：對手在這幾微秒之間
    // 搶走了 key 並且已經結束。假設自己贏了會重複執行，所以保守回 inProgress。
    database: scriptedDatabase({
      inserts: ["duplicate", "duplicate"],
      selects: [null, null]
    }),
    time: createTestTime()
  });

  assert.deepEqual(await store.begin("k", OPTIONS), { state: "inProgress" });
});

test("losing the race to a visible winner classifies against that winner", async () => {
  const store = new MySqlIdempotencyStore({
    database: scriptedDatabase({
      inserts: ["duplicate", "duplicate"],
      selects: [
        null,
        { fingerprint: "fp-1", state: "completed", status_code: 200, response: '{"id":9}' }
      ]
    }),
    time: createTestTime()
  });

  assert.deepEqual(await store.begin("k", OPTIONS), {
    state: "replay",
    response: { statusCode: 200, body: { id: 9 } }
  });
});

test("a completed record with no body replays without one", async () => {
  const store = new MySqlIdempotencyStore({
    database: scriptedDatabase({
      inserts: ["duplicate"],
      selects: [{ fingerprint: "fp-1", state: "completed", status_code: 204, response: null }]
    }),
    time: createTestTime()
  });

  // 204 沒有 body；JSON.parse(null) 會炸，所以這條路必須分開處理。
  assert.deepEqual(await store.begin("k", OPTIONS), {
    state: "replay",
    response: { statusCode: 204, body: undefined }
  });
});

test("purge stops at the configured batch limit and says it is behind", async () => {
  // 每批 1000 列，上限 2 批：造 2500 列過期資料，一輪只清得掉 2000。
  const rows = new Map();
  const state = { dbNowSeconds: 1000 };

  for (let index = 0; index < 2500; index += 1) {
    rows.set(`k${index}`, { expires_at: 0 });
  }

  const database = {
    query: async () => [[]],
    execute: async (sql) => {
      const limit = Number(sql.match(/LIMIT (\d+)$/)[1]);
      let affected = 0;

      for (const [key, row] of rows) {
        if (affected >= limit) {
          break;
        }

        if (row.expires_at <= state.dbNowSeconds) {
          rows.delete(key);
          affected += 1;
        }
      }

      return [{ affectedRows: affected }];
    }
  };
  const store = new MySqlIdempotencyStore({
    database,
    time: createTestTime(),
    purgeMaxBatches: 2
  });

  const result = await store.purge();

  // exhausted 是「清理追不上」唯一的訊號：行為完全正常，只是表越來越大。
  assert.deepEqual(result, { removed: 2000, exhausted: true });
  assert.equal(rows.size, 500);

  // 下一輪把剩下的清完，這次就不再喊落後。
  assert.deepEqual(await store.purge(), { removed: 500, exhausted: false });
});

test("the batch limit is configurable, and honoured", async () => {
  const executed = [];
  const database = {
    query: async () => [[]],
    execute: async (sql) => {
      executed.push(sql);
      return [{ affectedRows: 1000 }];
    }
  };

  for (const purgeMaxBatches of [1, 3]) {
    executed.length = 0;
    const store = new MySqlIdempotencyStore({
      database,
      time: createTestTime(),
      purgeMaxBatches
    });

    const { exhausted } = await store.purge();

    assert.equal(executed.length, purgeMaxBatches);
    assert.equal(exhausted, true);
  }
});
