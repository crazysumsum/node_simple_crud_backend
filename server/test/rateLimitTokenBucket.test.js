import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryRateLimitStore,
  RateLimitStore
} from "../src/services/requestLimiter/RateLimitStore.js";

// IP 限流從滑動窗口日誌換成 token bucket：狀態從每個 key 一個時間戳陣列
// （O(limit)，而且每個請求都 filter() 出一個新陣列）變成兩個數字。
//
// 這個檔案測的是演算法本身。它的錯誤形態都很安靜——桶永遠解不開、清理免費送
// 配額、時鐘回撥倒扣 token——沒有一個會拋錯，全部只是「限流的行為跟想的不一樣」。

function createStore(startAt = 10_000) {
  let now = startAt;
  const store = new MemoryRateLimitStore({ now: () => now });
  return {
    store,
    get now() {
      return now;
    },
    advance(ms) {
      now += ms;
    },
    consume: (key = "ip:1.1.1.1", options = { limit: 4, windowMs: 1000 }) =>
      store.consume(key, options)
  };
}

test("a fresh key starts with a full bucket and no entry is allocated for it", async () => {
  const { store, consume } = createStore();

  const first = await consume();

  assert.equal(first.allowed, true);
  assert.equal(first.remaining, 3);
  // 沒有桶就是滿桶——第一次請求不必先建立一個滿桶再從裡面扣。
  assert.equal(store.buckets.size, 1);
  assert.equal(store.buckets.get("ip:1.1.1.1").tokens, 3);
});

test("the bucket empties at the configured capacity, then refuses", async () => {
  const { consume } = createStore();

  for (let i = 0; i < 4; i += 1) {
    assert.equal((await consume()).allowed, true, `第 ${i + 1} 次應該放行`);
  }

  const denied = await consume();
  assert.equal(denied.allowed, false);
  assert.equal(denied.remaining, 0);
});

test("tokens come back continuously, not all at once when the window ends", async () => {
  const { consume, advance } = createStore();

  for (let i = 0; i < 4; i += 1) {
    await consume();
  }

  // 容量 4 / 1000ms，所以每 250ms 補回一個。
  advance(249);
  assert.equal((await consume()).allowed, false);

  advance(1);
  assert.equal((await consume()).allowed, true, "250ms 後應該剛好補回一個");

  // 補回來的那個又被用掉了，所以還要再等一個回填週期。
  assert.equal((await consume()).allowed, false);
  advance(250);
  assert.equal((await consume()).allowed, true);
});

test("refilling stops at capacity, so idling does not bank extra requests", async () => {
  const { consume, advance } = createStore();

  await consume();
  // 閒置一小時。桶最多就是滿的，不會攢出 14400 個 token。
  advance(3_600_000);

  for (let i = 0; i < 4; i += 1) {
    assert.equal((await consume()).allowed, true);
  }

  assert.equal((await consume()).allowed, false);
});

test("a refused request does not touch the bucket, so a blocked IP recovers", async () => {
  const { store, consume, advance } = createStore();

  for (let i = 0; i < 4; i += 1) {
    await consume();
  }

  const before = { ...store.buckets.get("ip:1.1.1.1") };

  // 一個被擋住的客戶端通常會一直重試。如果每次拒絕都推進 refilledAt，累積的
  // 回填就一直被抹掉，於是它永遠湊不滿一個 token——症狀是「被擋住的 IP 再也
  // 解不開」，而且看起來只像限流很嚴格。
  for (let i = 0; i < 20; i += 1) {
    advance(10);
    assert.equal((await consume()).allowed, false);
  }

  assert.deepEqual({ ...store.buckets.get("ip:1.1.1.1") }, before);

  // 重試了 200ms，加上再等 50ms 就滿一個回填週期。
  advance(50);
  assert.equal((await consume()).allowed, true);
});

test("retryAfterMs is the wait for exactly one token", async () => {
  const { consume, advance } = createStore();

  for (let i = 0; i < 4; i += 1) {
    await consume();
  }

  assert.equal((await consume()).retryAfterMs, 250);

  advance(100);
  // 已經回填了 0.4 個 token，還差 0.6 個 = 150ms。
  assert.equal((await consume()).retryAfterMs, 150);
});

test("a clock that jumps backwards does not take tokens away", async () => {
  const { store, consume, advance } = createStore();

  await consume();
  await consume();
  const afterTwo = store.buckets.get("ip:1.1.1.1").tokens;

  // NTP 往回調。少了 Math.max(0, ...) 的話 elapsed 是負的，回填會變成倒扣。
  advance(-5000);
  const third = await consume();

  assert.equal(third.allowed, true);
  assert.equal(store.buckets.get("ip:1.1.1.1").tokens, afterTwo - 1);
});

test("keys do not share a bucket", async () => {
  const { consume } = createStore();

  for (let i = 0; i < 4; i += 1) {
    await consume("ip:1.1.1.1");
  }

  assert.equal((await consume("ip:1.1.1.1")).allowed, false);
  assert.equal((await consume("ip:2.2.2.2")).allowed, true);
});

test("state per key is two numbers regardless of how large the limit is", async () => {
  const { store, consume } = createStore();

  for (let i = 0; i < 50; i += 1) {
    await consume("ip:1.1.1.1", { limit: 1000, windowMs: 1000 });
  }

  // 滑動窗口日誌在這裡會存 50 個時間戳，而且上限隨 limit 成長到 1000 個。
  assert.deepEqual(Object.keys(store.buckets.get("ip:1.1.1.1")).sort(), [
    "refilledAt",
    "tokens"
  ]);
});

test("purging a bucket cannot hand out quota it had not yet earned", async () => {
  const { store, consume, advance } = createStore();

  for (let i = 0; i < 4; i += 1) {
    await consume();
  }

  // 桶是空的。清理若把它刪掉，下一個請求會看到「沒有桶 = 滿桶」，等於白送 4 個。
  advance(500);
  assert.equal(await store.purge({ before: store.now() - 1000 }), 0);
  assert.equal((await consume()).allowed, true, "只回填了兩個，這一個算數");
  assert.equal((await consume()).allowed, true);
  assert.equal((await consume()).allowed, false, "第三個還沒回填出來");

  // 完全回滿之後刪掉才是安全的：重建時本來就是滿桶，沒有資訊損失。
  advance(1000);
  assert.equal(await store.purge({ before: store.now() - 1000 }), 1);
  assert.equal(store.buckets.size, 0);
});

test("the throttled sweep uses the same refilled cutoff that purge does", async () => {
  // 窗口拉到超過清理節流的 60 秒，這樣「該掃了」與「桶已回滿」才會分開——用預設
  // 的 1 秒窗口時兩者永遠同時成立，掃描用錯 cutoff 也看不出來。
  const options = { limit: 4, windowMs: 120_000 };
  const { store, consume, advance } = createStore();

  advance(10_000);
  await consume("ip:1.1.1.1", options);

  // 距離上次清理已經超過門檻，所以這一次會真的掃；但 1.1.1.1 只閒置了 110 秒，
  // 還沒回滿。掃描若用 now 當 cutoff 就會把它一起刪掉，等於免費送回它的配額。
  advance(110_000);
  await consume("ip:2.2.2.2", options);

  assert.deepEqual([...store.buckets.keys()], ["ip:1.1.1.1", "ip:2.2.2.2"]);
  assert.equal(store.buckets.get("ip:1.1.1.1").tokens, 3);
});

test("a consume whose own bucket the sweep just deleted still records the spend", async () => {
  const { store, consume, advance } = createStore();

  await consume();
  // 閒置到超過清理節流的門檻，於是下一個請求的 cleanup() 會刪掉這個 key 自己
  // 的桶。就地修改一個已經被移出 Map 的物件等於這一次扣減沒有發生，桶會回到
  // 滿的——症狀是「閒置一段時間後配額變成無限」。
  advance(120_000);

  await consume();

  assert.equal(store.buckets.size, 1);
  assert.equal(store.buckets.get("ip:1.1.1.1").tokens, 3);
});

test("purge without an argument falls back to the current time", async () => {
  const { store, consume, advance } = createStore();

  await consume();
  advance(5000);

  assert.equal(await store.purge(), 1);
});

test("closing the store drops every bucket", async () => {
  const { store, consume } = createStore();

  await consume("ip:1.1.1.1");
  await consume("ip:2.2.2.2");
  await store.close();

  assert.equal(store.buckets.size, 0);
});

test("the base class refuses to be used as a store", async () => {
  class Incomplete extends RateLimitStore {}

  // 介面是留給自行實作共享 adapter 的人的，所以沒實作 consume() 必須立刻炸，
  // 而不是靜默地放行每一個請求。
  await assert.rejects(
    () => new Incomplete().consume("k", { limit: 1, windowMs: 1 }),
    /Incomplete must implement consume\(\)/
  );
  await new Incomplete().close();
});
