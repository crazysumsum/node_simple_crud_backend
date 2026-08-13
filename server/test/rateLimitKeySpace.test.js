import assert from "node:assert/strict";
import test from "node:test";
import { clientQuotaKey } from "../src/services/requestLimiter/clientKey.js";
import {
  EVICTION_SAMPLE_SIZE,
  MemoryRateLimitStore
} from "../src/services/requestLimiter/RateLimitStore.js";
import { normalizeRequestLimiterConfig } from "../src/services/requestLimiter/normalizeRequestLimiterConfig.js";

// 限流器為每個沒見過的來源分配狀態，而「沒見過」由對方決定——偽造的來源永遠是
// 新桶，新桶永遠是滿的，一個都擋不下來。所以限流器自己就是這個攻擊的放大器，
// 而症狀只是記憶體慢慢漲，沒有任何一筆日誌會說「限流正在被繞過」。

const OPTIONS = Object.freeze({ limit: 20, windowMs: 1000 });

function createStore({ maxTrackedKeys = 1000, startAt = 1_000_000 } = {}) {
  const exhausted = [];
  let now = startAt;
  const store = new MemoryRateLimitStore({
    now: () => now,
    maxTrackedKeys,
    onKeysExhausted: (details) => exhausted.push(details)
  });

  return {
    store,
    exhausted,
    advance(ms) {
      now += ms;
    }
  };
}

// --- key 數量上限 ---------------------------------------------------------------

test("the key space has a hard ceiling, whatever the flood", async () => {
  // 時間不前進，所以沒有一個桶回滿，清理刪不掉任何東西——只剩淘汰擋得住。
  const { store } = createStore({ maxTrackedKeys: 1000 });

  for (let i = 0; i < 20_000; i += 1) {
    await store.consume(`flood-${i}`, OPTIONS);
  }

  assert.equal(store.buckets.size, 1000);
  assert.equal(store.evictedKeys, 19_000);
});

test("eviction keeps the source that is actually being limited", async () => {
  // 淘汰「token 最多」的，因為 token 越多代表欠得越少，送出去的免費配額最少。
  // 洪水製造的桶各只用過一次（幾乎全滿），真正在被限流的人是低 token，所以
  // 這個排序在攻擊下正好會先淘汰攻擊者。
  const { store } = createStore({ maxTrackedKeys: 1000 });

  for (let i = 0; i < OPTIONS.limit; i += 1) {
    await store.consume("heavy", OPTIONS);
  }
  assert.equal((await store.consume("heavy", OPTIONS)).allowed, false);

  for (let i = 0; i < 20_000; i += 1) {
    await store.consume(`flood-${i}`, OPTIONS);
  }

  assert.equal(store.buckets.has("heavy"), true);
  // 真正的重點：淘汰沒有把他的配額洗掉。反過來的話，攻擊流量等於幫每一個
  // 被限流的人免費解鎖。
  assert.equal((await store.consume("heavy", OPTIONS)).allowed, false);
});

test("hitting the ceiling is reported, because the guarantee no longer holds", async () => {
  const { store, exhausted } = createStore({ maxTrackedKeys: 10 });

  for (let i = 0; i < 15; i += 1) {
    await store.consume(`flood-${i}`, OPTIONS);
  }

  assert.equal(exhausted.length, 5);
  assert.deepEqual(
    { trackedKeys: exhausted.at(-1).trackedKeys, max: exhausted.at(-1).maxTrackedKeys },
    { trackedKeys: 9, max: 10 }
  );
  assert.equal(exhausted.at(-1).evictedKeys, 5);
});

test("an ordinary load never evicts anything", async () => {
  const { store, exhausted } = createStore({ maxTrackedKeys: 1000 });

  for (let round = 0; round < 5; round += 1) {
    for (let i = 0; i < 100; i += 1) {
      await store.consume(`client-${i}`, OPTIONS);
    }
  }

  assert.equal(store.buckets.size, 100);
  assert.deepEqual(exhausted, []);
  assert.equal(store.evictedKeys, 0);
});

test("the sample never looks past the end of the map", async () => {
  // 取樣的起點是隨機的，桶數少於樣本數時迭代器會提前 done。
  const { store } = createStore({ maxTrackedKeys: 2 });

  for (let i = 0; i < EVICTION_SAMPLE_SIZE * 4; i += 1) {
    await store.consume(`flood-${i}`, OPTIONS);
  }

  assert.equal(store.buckets.size, 2);
});

// --- 自適應清理 -----------------------------------------------------------------

test("a growing key space sweeps without waiting out the throttle", async () => {
  // 節流是為了避免每個請求都掃一次 Map。但如果它是唯一條件，那 60 秒就是
  // 攻擊者的自由累積窗口——實測真實應用下那是 90 萬個 key、107MB。
  const { store, advance } = createStore({ maxTrackedKeys: 1000 });
  assert.equal(store.sweepThreshold, 500);

  for (let i = 0; i < 400; i += 1) {
    await store.consume(`early-${i}`, OPTIONS);
  }

  // 這些桶現在全部回滿了，但節流還沒到期。
  advance(2000);
  assert.equal(store.buckets.size, 400);

  // 越過門檻的那一刻就掃，不管節流。留下的是剛才這一批新的。
  for (let i = 0; i < 200; i += 1) {
    await store.consume(`late-${i}`, OPTIONS);
  }

  assert.ok(store.buckets.size <= 200, `剩下 ${store.buckets.size} 個`);
  assert.equal(store.buckets.has("early-0"), false);
  assert.equal(store.buckets.has("late-199"), true);
});

test("the throttle still holds below the threshold", async () => {
  // 門檻以下不該每個請求都掃 Map，那正是節流存在的理由。
  const { store, advance } = createStore({ maxTrackedKeys: 100000 });

  await store.consume("a", OPTIONS);
  advance(2000);
  await store.consume("b", OPTIONS);

  // a 早就回滿了，但沒到門檻也沒到節流時間，所以還在。
  assert.equal(store.buckets.has("a"), true);
});

test("stats say how close the ceiling is", async () => {
  const { store } = createStore({ maxTrackedKeys: 10 });

  for (let i = 0; i < 12; i += 1) {
    await store.consume(`flood-${i}`, OPTIONS);
  }

  assert.deepEqual(store.stats(), {
    trackedKeys: 10,
    maxTrackedKeys: 10,
    evictedKeys: 2
  });
});

// --- IPv6 聚合 -----------------------------------------------------------------

test("one IPv6 prefix is one client, not 18 quintillion", () => {
  // 一台有 /64 路由的主機不必偽造任何東西就有 1.8×10^19 個真實來源位址。逐個
  // 位址計算配額等於完全沒有配額，而且每繞一次就多一個桶。
  const a = clientQuotaKey("2001:db8:1234:5678::1", 64);
  const b = clientQuotaKey("2001:db8:1234:5678:ffff:ffff:ffff:ffff", 64);
  const other = clientQuotaKey("2001:db8:1234:9999::1", 64);

  assert.equal(a, b);
  assert.notEqual(a, other);
});

test("an IPv4 mapped address is an IPv4 client, not the whole zero prefix", () => {
  // ::ffff:203.0.113.7 是 IPv4 客戶端經由雙堆疊 socket 進來的常態形式，前 80
  // 個 bit 固定。當成 IPv6 聚合到 /64 會讓每一個 IPv4 客戶端共用同一個桶——
  // 一個人就能用光所有人的配額，比原本的問題更糟。
  assert.equal(clientQuotaKey("::ffff:203.0.113.7", 64), "203.0.113.7");
  assert.notEqual(
    clientQuotaKey("::ffff:203.0.113.7", 64),
    clientQuotaKey("::ffff:198.51.100.9", 64)
  );
  assert.equal(
    clientQuotaKey("::ffff:203.0.113.7", 64),
    clientQuotaKey("203.0.113.7", 64)
  );
});

test("IPv4 and unparseable sources pass through untouched", () => {
  assert.equal(clientQuotaKey("203.0.113.7", 64), "203.0.113.7");
  assert.equal(clientQuotaKey("unknown", 64), "unknown");
  assert.equal(clientQuotaKey("/var/run/app.sock", 64), "/var/run/app.sock");
  assert.equal(clientQuotaKey(undefined, 64), "");
});

test("prefix lengths that are not whole bytes still mask correctly", () => {
  // /48 與 /56 都是 8 的倍數，遮罩落在 byte 邊界上。/60 不是——它要把一個
  // byte 切一半，而那正是最容易寫錯的地方。
  assert.equal(
    clientQuotaKey("2001:db8:1234:5678::1", 48),
    clientQuotaKey("2001:db8:1234:9999::1", 48)
  );
  assert.notEqual(
    clientQuotaKey("2001:db8:1234:5678::1", 56),
    clientQuotaKey("2001:db8:1299:5678::1", 56)
  );

  // /60：前 60 個 bit 相同（5670 與 567f 的高 4 個 bit 一樣）。
  assert.equal(
    clientQuotaKey("2001:db8:1234:5670::1", 60),
    clientQuotaKey("2001:db8:1234:567f::1", 60)
  );
  // 第 60 個 bit 之內不同就要分開。
  assert.notEqual(
    clientQuotaKey("2001:db8:1234:5670::1", 60),
    clientQuotaKey("2001:db8:1234:5680::1", 60)
  );

  // 前綴長度是 key 的一部分，否則不同長度的設定會互相碰撞。
  assert.notEqual(
    clientQuotaKey("2001:db8:1234::", 48),
    clientQuotaKey("2001:db8:1234::", 64)
  );
});

test("a zone id belongs to the interface, not the address", () => {
  assert.equal(
    clientQuotaKey("fe80::1%eth0", 64),
    clientQuotaKey("fe80::2%eth1", 64)
  );
});

test("the full address is still available for anyone who wants it", () => {
  assert.notEqual(
    clientQuotaKey("2001:db8::1", 128),
    clientQuotaKey("2001:db8::2", 128)
  );
});

// --- 設定 ----------------------------------------------------------------------

test("the key ceiling and the prefix length are validated", () => {
  for (const maxTrackedKeys of [0, -1, 1.5, "many"]) {
    assert.throws(
      () => normalizeRequestLimiterConfig({ maxTrackedKeys }),
      /"maxTrackedKeys" must be a positive integer/
    );
  }

  // /0 會把整個 IPv6 網際網路算成一個客戶端——一個人用光所有人的配額。
  for (const ipv6PrefixLength of [0, -1, 129, 1.5, "half"]) {
    assert.throws(
      () => normalizeRequestLimiterConfig({ ipv6PrefixLength }),
      /"ipv6PrefixLength" must be an integer between 1 and 128/
    );
  }

  // 數字字串照收，跟框架其他數值設定一致——環境變數本來就是字串。
  assert.equal(normalizeRequestLimiterConfig({ ipv6PrefixLength: "56" }).ipv6PrefixLength, 56);

  const defaults = normalizeRequestLimiterConfig({});
  assert.equal(defaults.maxTrackedKeys, 100000);
  assert.equal(defaults.ipv6PrefixLength, 64);
});

test("the shipped defaults keep the key space to a bounded footprint", async () => {
  const { default: config } = await import("../config/requestLimiter.js");
  const limiter = normalizeRequestLimiterConfig(config);

  // 一個桶實測約 125 bytes，所以上限乘以它就是最壞情況的佔用。留在測試裡是
  // 因為改大這個值的人應該同時看到它換算成多少記憶體。
  const worstCaseBytes = limiter.maxTrackedKeys * 125;
  assert.ok(
    worstCaseBytes < 32 * 1024 * 1024,
    `最壞情況 ${(worstCaseBytes / 1024 / 1024).toFixed(0)}MB 太高`
  );
});
