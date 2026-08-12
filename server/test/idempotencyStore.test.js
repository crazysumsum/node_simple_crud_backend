import assert from "node:assert/strict";
import test from "node:test";
import {
  IdempotencyStore,
  MemoryIdempotencyStore
} from "../src/framework/idempotency/IdempotencyStore.js";

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

test("completing a key that expired mid-request does not throw", async () => {
  const { store, clock } = storeAtTime();

  await store.begin("slow", { fingerprint: "f", ttlMs: 1000 });
  // 請求比 TTL 還久，中間又有別的請求觸發了清理。
  clock.nowMs = 2000;
  await store.begin("other", { fingerprint: "f", ttlMs: 1000 });
  assert.equal(store.entries.has("slow"), false);

  // handler 已經成功了。這裡若拋出，一個成功的請求會變成 500。
  await store.complete("slow", { statusCode: 201, body: {} }, { ttlMs: 1000 });

  // 但也不該把一筆過期的紀錄復活成可重播的回應。
  assert.equal(store.entries.has("slow"), false);
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

test("expired entries are removed, including ones still pending", async () => {
  const { store, clock } = storeAtTime();

  await store.begin("done", { fingerprint: "f", ttlMs: 1000 });
  await store.complete("done", { statusCode: 200, body: {} }, { ttlMs: 1000 });
  // 這一筆永遠不會 complete，例如處理它的程序崩潰了。
  await store.begin("stranded", { fingerprint: "f", ttlMs: 1000 });
  assert.equal(store.entries.size, 2);

  // 邊界：expiresAt <= now 就算過期。
  clock.nowMs = 1000;
  await store.begin("trigger", { fingerprint: "f", ttlMs: 1000 });

  // 不清的話 store 會無限成長，而且崩潰留下的 key 永遠不能重試。
  assert.deepEqual([...store.entries.keys()], ["trigger"]);
  assert.deepEqual(await store.begin("stranded", { fingerprint: "f", ttlMs: 1000 }), {
    state: "started"
  });
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

  // 這兩個刻意是 no-op 而不是 throw：靠儲存層 TTL 過期的 adapter 沒有東西要
  // 釋放，無狀態的 adapter 也沒有東西要關。強迫它們實作只會逼出空方法。
  assert.equal(await store.fail("k"), undefined);
  assert.equal(await store.close(), undefined);
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
