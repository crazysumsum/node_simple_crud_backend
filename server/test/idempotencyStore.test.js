import assert from "node:assert/strict";
import test from "node:test";
import {
  IdempotencyStore,
  MemoryIdempotencyStore
} from "../src/services/idempotency/IdempotencyStore.js";

const options = { fingerprint: "same-input", ttlMs: 60000 };

/** 可控時鐘，讓 TTL 過期不必真的等。 */
function storeAtTime(overrides = {}) {
  const clock = { nowMs: 0 };
  const store = new MemoryIdempotencyStore({
    now: () => clock.nowMs,
    ...overrides
  });

  return { store, clock };
}

test("memory idempotency capacity never evicts pending work", async () => {
  const store = new MemoryIdempotencyStore({ maxEntries: 1 });

  assert.deepEqual(await store.begin("first", options), { state: "started" });
  assert.deepEqual(await store.begin("second", options), {
    state: "capacityExceeded"
  });
  assert.deepEqual(await store.begin("first", options), { state: "inProgress" });
});

test("memory idempotency capacity may evict a completed entry", async () => {
  const store = new MemoryIdempotencyStore({ maxEntries: 1 });

  await store.begin("completed", options);
  await store.complete(
    "completed",
    { statusCode: 201, body: { success: true } },
    { ttlMs: 60000 }
  );

  assert.deepEqual(await store.begin("new", options), { state: "started" });
  assert.deepEqual(await store.begin("completed", options), {
    state: "capacityExceeded"
  });
});

// --- 釋放 --------------------------------------------------------------------

test("failing a key releases it so the client can retry", async () => {
  const { store } = storeAtTime();

  assert.deepEqual(await store.begin("order-1", options), { state: "started" });
  // 同一個 key 在處理途中再來一次，必須是 inProgress。
  assert.deepEqual(await store.begin("order-1", options), { state: "inProgress" });

  await store.fail("order-1");

  // 這是整個 fail() 存在的理由。不刪的話 key 會卡在 inProgress 直到 TTL 到期，
  // 客戶端拿同一個 key 重試會一路收到 409——而請求其實從來沒有成功過。
  assert.deepEqual(await store.begin("order-1", options), { state: "started" });
});

test("failing a key that was never started is harmless", async () => {
  const { store } = storeAtTime();

  // 釋放路徑會在 catch 區塊裡跑，那時的狀態不保證。多釋放一次不能再拋一個
  // 錯誤蓋掉原本的失敗原因。
  await store.fail("never-seen");
  assert.equal(store.entries.size, 0);
});

// --- 完成 --------------------------------------------------------------------

test("completing a key that expired mid-request does not throw or resurrect it", async () => {
  const { store, clock } = storeAtTime();

  await store.begin("slow", { fingerprint: "f", ttlMs: 1000 });
  // 請求跑得比自己的 TTL 還久。
  clock.nowMs = 2000;

  // handler 已經成功了。這裡若拋出，一個成功的請求會變成 500。
  await store.complete("slow", { statusCode: 201, body: {} }, { ttlMs: 1000 });

  // 也不該把一筆過期的紀錄復活成可重播的回應：TTL 就是「回放能持續多久」的
  // 承諾，過了就是過了。
  assert.equal(store.entries.has("slow"), false);
  assert.deepEqual(await store.begin("slow", { fingerprint: "f", ttlMs: 1000 }), {
    state: "started"
  });
});

test("a completed entry replays the stored response", async () => {
  const { store } = storeAtTime();
  const response = { statusCode: 201, body: { id: 7 } };

  await store.begin("order-2", options);
  await store.complete("order-2", response, { ttlMs: 60000 });

  assert.deepEqual(await store.begin("order-2", options), {
    state: "replay",
    response
  });
});

// --- 過期清理 ----------------------------------------------------------------

test("the sweep removes expired entries, including ones still pending", async () => {
  const { store, clock } = storeAtTime();

  await store.begin("done", { fingerprint: "f", ttlMs: 1000 });
  await store.complete("done", { statusCode: 200, body: {} }, { ttlMs: 1000 });
  // 這一筆永遠不會 complete，例如處理它的程序崩潰了。
  await store.begin("stranded", { fingerprint: "f", ttlMs: 1000 });
  assert.equal(store.entries.size, 2);

  // 掃描有最小間隔，所以要跨過它才會真的回收。
  clock.nowMs = 60000;
  await store.begin("trigger", { fingerprint: "f", ttlMs: 1000 });

  // 不回收的話 store 會無限成長。
  assert.deepEqual([...store.entries.keys()], ["trigger"]);
});

test("an expired key is reusable before the sweep gets round to it", async () => {
  const { store, clock } = storeAtTime();

  await store.begin("stranded", { fingerprint: "f", ttlMs: 1000 });

  // 剛好過期，但離下一次掃描還很遠。
  clock.nowMs = 1000;

  // 節流的是回收，不是過期判斷。這裡若回 inProgress，一個崩潰留下的 key 會把
  // 客戶端擋在 409 直到掃描輪到它——那正是把效能優化做成正確性問題。
  assert.deepEqual(await store.begin("stranded", { fingerprint: "f", ttlMs: 1000 }), {
    state: "started"
  });
});

test("an expired completed entry is not replayed before the sweep", async () => {
  const { store, clock } = storeAtTime();

  await store.begin("order", { fingerprint: "f", ttlMs: 1000 });
  await store.complete("order", { statusCode: 201, body: { id: 1 } }, { ttlMs: 1000 });

  clock.nowMs = 1000;

  // TTL 是「回放能持續多久」的承諾。過期後還回放，等於這個承諾取決於剛好有
  // 沒有別的請求觸發掃描。
  assert.deepEqual(await store.begin("order", { fingerprint: "f", ttlMs: 1000 }), {
    state: "started"
  });
});

test("the sweep is throttled instead of running on every begin", async () => {
  const { store, clock } = storeAtTime();

  await store.begin("first", { fingerprint: "f", ttlMs: 1000 });
  const sweptAt = store.lastCleanupAt;

  clock.nowMs = 59999;
  await store.begin("second", { fingerprint: "f", ttlMs: 1000 });

  // 掃描是 O(n)，maxEntries 預設 10000——掛在每個請求上就是每個 idempotent
  // 請求都走一遍上萬筆。
  assert.equal(store.lastCleanupAt, sweptAt, "還沒到間隔就不該重掃");

  clock.nowMs = 60000;
  await store.begin("third", { fingerprint: "f", ttlMs: 1000 });
  assert.equal(store.lastCleanupAt, 60000);
});

test("the capacity boundary forces a sweep before refusing a request", async () => {
  const { store, clock } = storeAtTime({ maxEntries: 2 });

  await store.begin("a", { fingerprint: "f", ttlMs: 1000 });
  await store.begin("b", { fingerprint: "f", ttlMs: 1000 });

  // 兩筆都過期了，但離下一次排定的掃描還很遠。
  clock.nowMs = 1000;

  // 照著一個塞滿過期項目的 size 回 capacityExceeded，等於拒絕一個其實有空位
  // 的請求——而且是在最不該省那次掃描的地方省。
  assert.deepEqual(await store.begin("c", { fingerprint: "f", ttlMs: 1000 }), {
    state: "started"
  });
  assert.deepEqual([...store.entries.keys()], ["c"]);
});

test("an entry that has not expired survives cleanup", async () => {
  const { store, clock } = storeAtTime();

  await store.begin("fresh", { fingerprint: "f", ttlMs: 1000 });
  clock.nowMs = 999;
  await store.begin("trigger", { fingerprint: "f", ttlMs: 1000 });

  // 清早了會讓一個還在有效期內的 key 被重複執行。
  assert.deepEqual(await store.begin("fresh", { fingerprint: "f", ttlMs: 1000 }), {
    state: "inProgress"
  });
});

// --- 設定與關閉 --------------------------------------------------------------

test("a non-positive maxEntries is rejected at construction", () => {
  // 靜默接受 0 會讓每個請求都 capacityExceeded；接受非整數會讓容量檢查
  // 永遠不成立，也就是一個無上限的 store。兩者都只在生產環境才看得出來。
  for (const maxEntries of [0, -1, 1.5, "100", null]) {
    assert.throws(
      () => new MemoryIdempotencyStore({ maxEntries }),
      /maxEntries must be a positive integer/,
      `maxEntries=${String(maxEntries)} 應該被拒絕`
    );
  }

  assert.equal(new MemoryIdempotencyStore({ maxEntries: 1 }).maxEntries, 1);
});

test("closing the store drops every entry", async () => {
  const { store } = storeAtTime();

  await store.begin("order-3", options);
  await store.close();

  assert.equal(store.entries.size, 0);
});

// --- adapter 契約 ------------------------------------------------------------

test("an adapter that skips begin or complete fails loudly and says so", async () => {
  class HalfBuiltStore extends IdempotencyStore {}
  const store = new HalfBuiltStore();

  // 這兩個方法沒有合理的預設行為。基底類別若回傳 undefined，manager 會在
  // 讀 result.state 時炸在一個與根因無關的地方，訊息也不會提到 adapter。
  await assert.rejects(
    () => store.begin("k", options),
    /HalfBuiltStore must implement begin\(\)/
  );
  await assert.rejects(
    () => store.complete("k", {}, options),
    /HalfBuiltStore must implement complete\(\)/
  );
});

test("an adapter may leave fail and close unimplemented", async () => {
  class MinimalStore extends IdempotencyStore {
    async begin() {
      return { state: "started" };
    }

    async complete() {}
  }
  const store = new MinimalStore();

  // 這三個刻意是 no-op 而不是 throw：靠儲存層 TTL 過期的 adapter 沒有東西要
  // 釋放，無狀態的 adapter 也沒有東西要關。強迫它們實作只會逼出空方法。
  assert.equal(await store.fail("k"), undefined);
  assert.equal(await store.markUnavailable("k", { ttlMs: 1000 }), undefined);
  assert.equal(await store.close(), undefined);
});

test("a memory key marked unavailable refuses a retry instead of re-running it", async () => {
  const { store, clock } = storeAtTime();

  assert.deepEqual(await store.begin("k", options), { state: "started" });
  await store.markUnavailable("k", { ttlMs: 60_000 });

  // 記憶體與 MySQL 兩個 adapter 的語意必須一致，否則單機開發看到的行為與
  // 多實例部署不同——而這裡的差別是「業務操作會不會跑第二次」。
  assert.deepEqual(await store.begin("k", options), {
    state: "completedWithoutResponse"
  });

  clock.nowMs += 60_001;
  // TTL 到期之後保護才解除，這是刻意的：不能永遠擋住一個 key。
  assert.deepEqual(await store.begin("k", options), { state: "started" });
});

test("marking unavailable leaves a pending lease behind and uses the full ttl", async () => {
  const { store, clock } = storeAtTime();

  await store.begin("k", { ...options, ttlMs: 60_000, pendingLeaseMs: 5000 });
  await store.markUnavailable("k", { ttlMs: 60_000 });

  // 沿用租約的話保護會在五秒後消失，而重試通常就在那之後。
  clock.nowMs += 5001;
  assert.deepEqual(await store.begin("k", options), {
    state: "completedWithoutResponse"
  });
});

test("marking unavailable never downgrades a cached response", async () => {
  const { store } = storeAtTime();

  await store.begin("k", options);
  await store.complete("k", { statusCode: 200, body: { id: 1 } }, { ttlMs: 60_000 });
  await store.markUnavailable("k", { ttlMs: 60_000 });

  assert.deepEqual(await store.begin("k", options), {
    state: "replay",
    response: { statusCode: 200, body: { id: 1 } }
  });
});

test("capacity pressure never evicts the guarantee that work ran once", async () => {
  const { store } = storeAtTime({ maxEntries: 1 });

  await store.begin("done", options);
  await store.markUnavailable("done", { ttlMs: 60_000 });

  // 淘汰一筆 completed 只是讓重播失效；淘汰一筆 unavailable 是把「不重複執行」
  // 的保證丟掉。滿了就回 capacityExceeded——503 是安全的方向。
  assert.deepEqual(await store.begin("new", options), { state: "capacityExceeded" });
  assert.deepEqual(await store.begin("done", options), {
    state: "completedWithoutResponse"
  });
});

test("marking an unknown key unavailable is a no-op, not a resurrection", async () => {
  const { store } = storeAtTime();

  // 一筆已經過期並被回收的 key 不該因為晚到的收尾又被寫回去。
  await store.markUnavailable("never-seen", { ttlMs: 60_000 });

  assert.equal(store.entries.size, 0);
});

test("eviction drops the completed entry that expires soonest", async () => {
  const { store, clock } = storeAtTime({ maxEntries: 2 });

  await store.begin("expires-first", { fingerprint: "f", ttlMs: 1 });
  await store.complete("expires-first", { statusCode: 200, body: { n: 1 } }, { ttlMs: 1000 });
  await store.begin("expires-later", { fingerprint: "f", ttlMs: 1 });
  await store.complete("expires-later", { statusCode: 200, body: { n: 2 } }, { ttlMs: 2000 });

  // 容量滿了，必須挑一筆完成的騰位子。挑錯方向的話會扔掉最新、最可能還會被
  // 重播的那一筆，而留下再過一下就自然過期的舊資料。
  assert.deepEqual(await store.begin("newcomer", { fingerprint: "f", ttlMs: 1000 }), {
    state: "started"
  });

  assert.equal(store.entries.has("expires-first"), false);
  assert.deepEqual(await store.begin("expires-later", { fingerprint: "f", ttlMs: 1 }), {
    state: "replay",
    response: { statusCode: 200, body: { n: 2 } }
  });
  // 時鐘沒有前進，所以這一輪不是清理造成的，確實是淘汰挑的。
  assert.equal(clock.nowMs, 0);
});
