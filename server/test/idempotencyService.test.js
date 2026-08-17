import assert from "node:assert/strict";
import test from "node:test";
import {
  IdempotencyError,
  IdempotencyService
} from "../src/services/idempotency/IdempotencyService.js";
import { normalizeIdempotencyConfig } from "../src/services/idempotency/normalizeIdempotencyConfig.js";

// 這裡測兩件事：key 對應到誰（錯了就是跨使用者外洩），以及 store 降級時客戶端
// 收到什麼（每一種都是實際會回到線上的回應）。

const baseConfig = {
  headerName: "Idempotency-Key",
  maxKeyLength: 128,
  defaultTtlMs: 60000,
  cacheableStatusCodes: [200, 201],
  storeAdapter: "memory",
  storeKeyPrefix: "test",
  memoryMaxEntries: 10
};

function collectingLogger() {
  const entries = [];
  const record = (level) => async (event, message, context) => {
    entries.push({ level, event, message, context });
  };
  return { entries, info: record("info"), warn: record("warn"), error: record("error") };
}

/** 記錄每一次 begin 的 key 與 fingerprint，測試靠它觀察 scope 的推導結果。 */
function recordingStore(behaviour = {}) {
  const seen = [];
  return {
    seen,
    begin: async (key, options) => {
      seen.push({ key, ...options });
      return behaviour.begin ? behaviour.begin(key, options) : { state: "started" };
    },
    complete: behaviour.complete || (async () => {}),
    markUnavailable: behaviour.markUnavailable || (async () => {}),
    fail: behaviour.fail || (async () => {}),
    close: async () => {}
  };
}

function createManager(store, { config: overrides, logger = collectingLogger() } = {}) {
  return {
    logger,
    manager: new IdempotencyService({
      config: normalizeIdempotencyConfig({ ...baseConfig, ...overrides }),
      store,
      logger,
      context: { get: () => ({}) }
    })
  };
}

function createRequest({ auth = null, key = "key-1", ip = "10.0.0.1", input = {} } = {}) {
  return {
    requestId: "req-1",
    method: "POST",
    ip,
    auth,
    input,
    apiRoute: { method: "POST", path: "/api/v1/orders" },
    get: () => key
  };
}

function createResponse() {
  const headers = {};
  return {
    headers,
    statusCode: 200,
    setHeader: (name, value) => {
      headers[name.toLowerCase()] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
}

const routeOptions = { enabled: true, ttlMs: 60000 };

// --- 第一層：key 對應到誰 -----------------------------------------------------

test("the identity scope falls back from sub to jti to a claims hash", async () => {
  const store = recordingStore();
  const { manager } = createManager(store);
  const run = (claims) =>
    manager.execute(
      createRequest({ auth: { type: "jwt", claims } }),
      createResponse(),
      routeOptions,
      () => "ok"
    );

  await run({ sub: "user-1", jti: "token-a" });
  await run({ jti: "token-a" });
  await run({ role: "admin" });

  const [bySub, byJti, byHash] = store.seen.map(({ key }) => key);

  // 三條 fallback 各自產生不同的 scope。全都相同就代表 fallback 根本沒生效。
  assert.equal(new Set([bySub, byJti, byHash]).size, 3);
});

test("different users never share an idempotency scope", async () => {
  const store = recordingStore();
  const { manager } = createManager(store);
  const run = (claims) =>
    manager.execute(
      createRequest({ auth: { type: "jwt", claims } }),
      createResponse(),
      routeOptions,
      () => "ok"
    );

  // 同一個 idempotency key，不同使用者。scope 若碰撞，第二個人會拿到第一個人
  // 的快取回應——跨使用者資料外洩。
  await run({ sub: "user-1" });
  await run({ sub: "user-2" });
  // sub 相同的同一個人則必須落在同一個 scope，否則 idempotency 形同虛設。
  await run({ sub: "user-1", role: "admin" });

  const [first, second, again] = store.seen.map(({ key }) => key);
  assert.notEqual(first, second, "不同使用者不得共用 scope");
  assert.equal(first, again, "同一個 sub 必須落在同一個 scope");
});

test("claims that differ only in an unrelated field still hash apart", async () => {
  const store = recordingStore();
  const { manager } = createManager(store);
  const run = (claims) =>
    manager.execute(
      createRequest({ auth: { type: "jwt", claims } }),
      createResponse(),
      routeOptions,
      () => "ok"
    );

  // 沒有 sub 也沒有 jti 時只剩 claims 雜湊可用，它必須真的區分得開。
  await run({ role: "admin", tenant: "a" });
  await run({ role: "admin", tenant: "b" });
  // 欄位順序不同但內容相同的 claims 必須得到同一個 scope。
  await run({ tenant: "a", role: "admin" });

  const [a, b, aAgain] = store.seen.map(({ key }) => key);
  assert.notEqual(a, b);
  assert.equal(a, aAgain, "canonical 化後欄位順序不應影響 scope");
});

test("public requests are scoped by client address", async () => {
  const store = recordingStore();
  const { manager } = createManager(store);
  const run = (ip) =>
    manager.execute(
      createRequest({ auth: { type: "public" }, ip }),
      createResponse(),
      routeOptions,
      () => "ok"
    );

  await run("10.0.0.1");
  await run("10.0.0.2");

  const [first, second] = store.seen.map(({ key }) => key);
  assert.notEqual(first, second);
});

// --- 第二層：store 降級時客戶端收到什麼 ---------------------------------------

const degraded = [
  {
    name: "another request with the same key is still running",
    state: { state: "inProgress" },
    code: "IDEMPOTENCY_IN_PROGRESS",
    statusCode: 409,
    retryAfter: "1"
  },
  {
    name: "the store is at capacity",
    state: { state: "capacityExceeded" },
    code: "IDEMPOTENCY_CAPACITY_EXCEEDED",
    statusCode: 503,
    retryAfter: "1"
  },
  {
    name: "the store returns a state the framework does not know",
    state: { state: "something-unexpected" },
    code: "IDEMPOTENCY_STORE_FAILED",
    statusCode: 503,
    retryAfter: undefined
  }
];

for (const scenario of degraded) {
  test(`${scenario.name} produces ${scenario.statusCode} ${scenario.code}`, async () => {
    const store = recordingStore({ begin: () => scenario.state });
    const { manager } = createManager(store);
    const res = createResponse();
    let workRan = false;

    await assert.rejects(
      () =>
        manager.execute(createRequest(), res, routeOptions, () => {
          workRan = true;
        }),
      (error) => {
        assert.ok(error instanceof IdempotencyError);
        assert.equal(error.code, scenario.code);
        assert.equal(error.statusCode, scenario.statusCode);
        return true;
      }
    );

    assert.equal(workRan, false, "降級狀態下不得執行 handler");
    // 客戶端會依 Retry-After 決定何時重試，有沒有這個 header 是行為差異。
    assert.equal(res.headers["retry-after"], scenario.retryAfter);
  });
}

test("a store that throws on begin becomes a 503, not a 500", async () => {
  const store = recordingStore({
    begin: () => {
      throw new Error("redis is unreachable");
    }
  });
  const { manager, logger } = createManager(store);

  await assert.rejects(
    () => manager.execute(createRequest(), createResponse(), routeOptions, () => "ok"),
    (error) => {
      // store 掛掉是暫時性的基礎設施問題，回 503 才會讓客戶端重試。
      assert.equal(error.code, "IDEMPOTENCY_STORE_FAILED");
      assert.equal(error.statusCode, 503);
      // 內部原因不得外洩給客戶端……
      assert.doesNotMatch(error.publicMessage, /redis/i);
      // ……但根因不能整個被吞掉，否則資料庫故障時 system log 只剩一句泛化
      // 訊息，排查只能靠猜。
      assert.equal(error.cause?.message, "redis is unreachable");
      return true;
    }
  );

  const logged = logger.entries.find((entry) => entry.event === "idempotency.store.begin_failed");
  assert.ok(logged, "begin() 失敗時應該留下日誌，而不是只把錯誤往上拋");
  assert.equal(logged.level, "error");
  assert.equal(logged.context.error.message, "redis is unreachable");
});

test("an over-long idempotency key is rejected before the store is touched", async () => {
  const store = recordingStore();
  const { manager } = createManager(store);
  const req = createRequest({ key: "x".repeat(129) });

  await assert.rejects(
    () => manager.execute(req, createResponse(), routeOptions, () => "ok"),
    (error) => {
      assert.equal(error.code, "IDEMPOTENCY_KEY_INVALID");
      assert.equal(error.statusCode, 400);
      return true;
    }
  );
  // 惡意的長 key 不該有機會撐大共用 store。
  assert.deepEqual(store.seen, []);
});

test("a missing idempotency key is rejected", async () => {
  const store = recordingStore();
  const { manager } = createManager(store);
  const req = { ...createRequest(), get: () => "   " };

  await assert.rejects(
    () => manager.execute(req, createResponse(), routeOptions, () => "ok"),
    (error) => {
      assert.equal(error.code, "IDEMPOTENCY_KEY_REQUIRED");
      assert.equal(error.statusCode, 400);
      return true;
    }
  );
  assert.deepEqual(store.seen, []);
});

// --- 完成與釋放：決定之後的重試是重播還是重跑 ---------------------------------

test("a failure to save the response is logged and does not fail the request", async () => {
  const store = recordingStore({
    complete: async () => {
      throw new Error("store write rejected");
    }
  });
  const { manager, logger } = createManager(store);
  const res = createResponse();

  const result = await manager.execute(createRequest(), res, routeOptions, () => {
    res.status(201).json({ id: 1 });
    return "handler-result";
  });

  // handler 已經成功、回應已經送出，儲存快取失敗不該把它變成錯誤。
  assert.equal(result, "handler-result");
  const entry = logger.entries.find(
    (candidate) => candidate.event === "idempotency.store.complete_failed"
  );
  assert.ok(entry, "儲存失敗必須留下記錄");
  assert.equal(entry.level, "error");
});

test("a non-cacheable status releases the key instead of caching it", async () => {
  const released = [];
  const store = recordingStore({
    complete: async () => {
      throw new Error("complete must not be called");
    },
    fail: async (key) => released.push(key)
  });
  const { manager } = createManager(store);
  const res = createResponse();

  await manager.execute(createRequest(), res, routeOptions, () => {
    // 422 不在 cacheableStatusCodes 內：這個結果不該被重播，而 key 必須釋放，
    // 否則客戶端修正輸入後重試會一路撞到 409。
    res.status(422).json({ error: "invalid" });
  });

  assert.equal(released.length, 1);
});

// --- 成功了但回應存不下來 --------------------------------------------------------
//
// 三條路徑（沒有 body、complete() 失敗、回應過大）先前都走 fail()，也就是把 key
// 釋放掉。那讓客戶端可以重試並拿到一個回應——代價是已經成功的業務操作再執行
// 一次，而客戶端兩次都看到成功。

test("a success with no captured body is closed, not released", async () => {
  const released = [];
  const closed = [];
  const store = recordingStore({
    fail: async (key) => released.push(key),
    markUnavailable: async (key, options) => closed.push({ key, ...options })
  });
  const { manager } = createManager(store);

  // 檔案下載走 res.end()，不經 res.json()，所以沒有 body 可以快取。但業務操作
  // 確實做完了——釋放 key 等於允許它再做一次。
  await manager.execute(createRequest(), createResponse(), routeOptions, () => "no body");

  assert.deepEqual(released, []);
  assert.deepEqual(closed, [
    { key: closed[0]?.key, ttlMs: routeOptions.ttlMs, owner: closed[0]?.owner }
  ]);
  // owner 是隨機憑證：不要求特定值，但一定要有，否則 markUnavailable() 收不到
  // fencing 需要的東西，寫入請求會全部被誤判成租約已經易主。
  assert.equal(typeof closed[0]?.owner, "string");
  assert.ok(closed[0].owner.length > 0);
});

test("a response that cannot be stored is closed, not released", async () => {
  const released = [];
  const closed = [];
  const store = recordingStore({
    complete: async () => {
      throw new Error("connect ECONNREFUSED");
    },
    fail: async (key) => released.push(key),
    markUnavailable: async (key) => closed.push(key)
  });
  const { manager, logger } = createManager(store);
  const res = createResponse();

  const result = await manager.execute(createRequest(), res, routeOptions, () => {
    res.status(201).json({ id: 1 });
    return "done";
  });

  // 業務操作成功了，客戶端照常收到 201——把它改成錯誤只會保證客戶端重試。
  assert.equal(result, "done");
  assert.deepEqual(released, []);
  assert.equal(closed.length, 1);
  assert.ok(
    logger.entries.some((entry) => entry.event === "idempotency.store.complete_failed")
  );
});

test("a non-cacheable status is still released, because it did not succeed", async () => {
  const released = [];
  const closed = [];
  const store = recordingStore({
    fail: async (key) => released.push(key),
    markUnavailable: async (key) => closed.push(key)
  });
  const { manager } = createManager(store);
  const res = createResponse();

  await manager.execute(createRequest(), res, routeOptions, () => {
    res.status(422).json({ error: "invalid" });
  });

  // 這是 fail() 唯一還該出現在成功路徑上的地方：客戶端修正輸入後重試，必須
  // 能重新執行。先前這一條與「成功但存不下來」共用同一個 else 分支。
  assert.equal(released.length, 1);
  assert.deepEqual(closed, []);
});

test("a retry of a key whose response was lost is refused, not re-executed", async () => {
  const store = recordingStore({
    begin: async () => ({ state: "completedWithoutResponse" })
  });
  const { manager, logger } = createManager(store);
  let ran = false;

  await assert.rejects(
    () =>
      manager.execute(createRequest(), createResponse(), routeOptions, () => {
        ran = true;
      }),
    (error) => {
      assert.equal(error.code, "IDEMPOTENCY_RESULT_UNAVAILABLE");
      assert.equal(error.statusCode, 409);
      assert.match(error.message, /Do not retry/);
      return true;
    }
  );

  // 整個狀態存在的理由就是這一行。
  assert.equal(ran, false, "已經成功過的業務操作絕不能再跑一次");
  assert.ok(
    logger.entries.some((entry) => entry.event === "idempotency.response.unavailable")
  );
});

test("a store that cannot even close the key says so at error level", async () => {
  const store = recordingStore({
    complete: async () => {
      throw new Error("connect ECONNREFUSED");
    },
    markUnavailable: async () => {
      throw new Error("still down");
    }
  });
  const { manager, logger } = createManager(store);
  const res = createResponse();

  // 這是唯一無法再往下收斂的殘餘情況：列留在 pending，重試在租約到期後仍會
  // 重新執行。救它需要業務操作與 idempotency 寫入在同一個交易裡，而框架管不到
  // handler 的交易邊界。所以它必須看得見。
  const result = await manager.execute(createRequest(), res, routeOptions, () => {
    res.status(201).json({ id: 1 });
    return "done";
  });

  assert.equal(result, "done");
  const entry = logger.entries.find(
    (candidate) => candidate.event === "idempotency.store.mark_unavailable_failed"
  );
  assert.equal(entry.level, "error");
  assert.equal(entry.context.reason, "store_failed");
});

// --- 租約易主：owner 對不上時的可見性 -----------------------------------------
//
// begin() 帶的 owner 沒對上，不代表出了例外——它代表這個請求活得比自己的
// idempotency 租約還久，另一個呼叫者已經接手了同一個 key。store 用回傳 false
// 表達這件事（而不是 throw），這裡要確認 manager 真的把它變成一筆看得見的
// error 記錄，而不是靜默吞掉。

test("a lease lost during complete() is logged, not silently dropped", async () => {
  const store = recordingStore({ complete: async () => false });
  const { manager, logger } = createManager(store);
  const res = createResponse();

  // 業務操作照常成功；owner 對不上只影響「這個 key 之後能不能被重播」，
  // 不影響這個請求本身收到的回應。
  const result = await manager.execute(createRequest(), res, routeOptions, () => {
    res.status(201).json({ id: 1 });
    return "done";
  });

  assert.equal(result, "done");
  const entry = logger.entries.find((candidate) => candidate.event === "idempotency.lease_lost");
  assert.ok(entry, "租約遺失必須留下記錄");
  assert.equal(entry.level, "error");
  assert.equal(entry.context.reason, "complete");
});

test("a lease lost during the release after an uncacheable status is logged", async () => {
  const store = recordingStore({ fail: async () => false });
  const { manager, logger } = createManager(store);
  const res = createResponse();

  await manager.execute(createRequest(), res, routeOptions, () => {
    res.status(422).json({ error: "invalid" });
  });

  const entry = logger.entries.find((candidate) => candidate.event === "idempotency.lease_lost");
  assert.ok(entry, "租約遺失必須留下記錄");
  assert.equal(entry.level, "error");
  assert.equal(entry.context.reason, "fail_after_uncacheable_status");
});

test("a lease lost during markUnavailable() is logged", async () => {
  const store = recordingStore({ markUnavailable: async () => false });
  const { manager, logger } = createManager(store);

  await manager.execute(createRequest(), createResponse(), routeOptions, () => "no body");

  const entry = logger.entries.find((candidate) => candidate.event === "idempotency.lease_lost");
  assert.ok(entry, "租約遺失必須留下記錄");
  assert.equal(entry.level, "error");
  assert.equal(entry.context.reason, "no_response_body");
});

test("a store with no fencing support (returns undefined) is not treated as lease loss", async () => {
  // 最小介面的替身（例如「an adapter may leave fail and close unimplemented」
  // 測的那種）沒有 fencing 能力，回傳 undefined。那是「沒有訊號」，不是「租約
  // 遺失」——誤判的話每一個接到這種 store 的請求都會多一筆假警報。
  const store = recordingStore();
  const { manager, logger } = createManager(store);
  const res = createResponse();

  await manager.execute(createRequest(), res, routeOptions, () => {
    res.status(201).json({ id: 1 });
    return "done";
  });

  assert.equal(
    logger.entries.some((entry) => entry.event === "idempotency.lease_lost"),
    false
  );
});

test("res.json is restored after execute, cached or not", async () => {
  const store = recordingStore();
  const { manager } = createManager(store);
  const res = createResponse();
  const originalJson = res.json;

  await manager.execute(createRequest(), res, routeOptions, () => {
    res.status(201).json({ id: 1 });
  });

  // 攔截 res.json 是為了抓回應內容；沒還原的話同一個 response 上的後續呼叫
  // 會一直穿過已經結束的 idempotency 流程。
  assert.equal(res.json, originalJson);
});

test("a disabled route skips the store completely", async () => {
  const store = recordingStore();
  const { manager } = createManager(store);

  const result = await manager.execute(
    createRequest(),
    createResponse(),
    { enabled: false, ttlMs: 60000 },
    () => "ran"
  );

  assert.equal(result, "ran");
  assert.deepEqual(store.seen, []);
});

// --- 設定與建構守衛 -----------------------------------------------------------

test("route options reject a non-positive ttl", () => {
  const { manager } = createManager(recordingStore());

  for (const ttlMs of [0, -1, 1.5, "soon"]) {
    assert.throws(
      () => manager.routeOptions({ enabled: true, ttlMs }, "post /api/v1/orders"),
      /ttlMs must be a positive integer/
    );
  }

  // 全域開關已經移到 static service.enabled，設定檔裡殘留的 enabled 會被擋下，
  // 不會被當成「關掉了」而靜默生效。
  assert.throws(
    () => normalizeIdempotencyConfig({ ...baseConfig, enabled: false }),
    /"enabled" was removed/
  );
});

test("the manager requires a request context and a usable store", () => {
  const config = normalizeIdempotencyConfig(baseConfig);

  assert.throws(
    () => new IdempotencyService({ config, store: recordingStore(), logger: collectingLogger() }),
    /requires a request context service/
  );
  assert.throws(
    () =>
      new IdempotencyService({
        config,
        store: { begin: async () => ({ state: "started" }) },
        logger: collectingLogger(),
        context: { get: () => ({}) }
      }),
    /must implement begin\(\), complete\(\) and fail\(\)/
  );
});

test("the container's shutdown closes the store", async () => {
  let closed = 0;
  const store = recordingStore();
  store.close = async () => {
    closed += 1;
  };
  const { manager } = createManager(store);

  // 容器只呼叫 shutdown||close 其中一個。這個 service 現在由容器持有，所以
  // 名字必須是容器認得的那個，否則 store 永遠關不掉。
  assert.equal(typeof manager.shutdown, "function");
  await (manager.shutdown || manager.close).call(manager);
  assert.equal(closed, 1);
});
