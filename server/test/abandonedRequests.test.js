import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  defaultConfigurationSource,
  validateApplicationConfiguration
} from "../src/framework/configuration/applicationConfiguration.js";
import { ConfigurationError } from "../src/framework/configuration/ConfigurationError.js";
import {
  markRequestProcessingCompleted,
  markRequestProcessingStarted,
  maybeMarkRequestAbandoned,
  onRequestAbandoned,
  onRequestProcessingComplete
} from "../src/framework/http/requestProcessingLifecycle.js";
import { createRequestServiceScopeMiddleware } from "../src/framework/services/requestServiceScope.js";
import { createRequestTimeoutMiddleware } from "../src/framework/middleware/requestTimeout.js";
import { normalizeRequestLimiterConfig } from "../src/services/requestLimiter/normalizeRequestLimiterConfig.js";
import { RequestLimiterService } from "../src/services/requestLimiter/RequestLimiterService.js";
import { createTestTime } from "../test-support/createTestTime.js";

// JS 的 Promise 不能取消。逾時只能發出 AbortSignal，一個沒有 race 它的 handler
// 會一直跑下去——而槽位與 request scope 都掛在「handler settle」上，所以四個
// 永不 resolve 的 handler 就能讓整個實例對後續請求回 429，關機也必然強制退出。
//
// 修不了的是取消。修得了的是「已經死掉的請求不該再佔著活著的請求需要的東西」。

const baseConfig = {
  apiPathPrefix: "/api",
  maxConcurrentRequests: 2,
  maxQueueSize: 2,
  queueTimeoutMs: 1000,
  maxRequestsPerIpPerWindow: 100,
  ipWindowMs: 1000,
  retryAfterSeconds: 1,
  abandonGraceMs: 50,
  maxAbandonedRequests: 3
};

class MockResponse extends EventEmitter {
  constructor() {
    super();
    this.headers = new Map();
    this.statusCode = 200;
    this.body = null;
    this.headersSent = false;
    this.writableEnded = false;
    this.writableFinished = false;
    this.destroyed = false;
  }

  setHeader(name, value) {
    this.headers.set(name.toLowerCase(), value);
  }

  status(statusCode) {
    this.statusCode = statusCode;
    return this;
  }

  json(body) {
    this.body = body;
    this.headersSent = true;
    this.writableEnded = true;
    this.writableFinished = true;
    this.emit("finish");
    return this;
  }

  /** 逾時回應送出：header 送了、body 送了、finish 觸發。 */
  finish(statusCode = 504) {
    this.statusCode = statusCode;
    this.headersSent = true;
    this.writableEnded = true;
    this.writableFinished = true;
    this.emit("finish");
  }

  destroy() {
    this.destroyed = true;
    this.emit("close");
  }
}

function request(id, ip = "127.0.0.1") {
  return {
    requestId: id,
    method: "GET",
    path: "/api/test",
    originalUrl: "/api/test",
    ip
  };
}

function memoryLogger() {
  const entries = [];
  const write = (level) => (event, message, context) => {
    entries.push({ level, event, message, context });
  };

  return {
    entries,
    debug: write("debug"),
    info: write("info"),
    warn: write("warn"),
    error: write("error")
  };
}

/** 逾時已觸發、504 已送出，但 handler 還在跑。 */
function abandon(req, res) {
  res.finish(504);
  return maybeMarkRequestAbandoned(req, res, { aborted: true });
}

// --- 判定式 ---------------------------------------------------------------------

test("a request that never reached a handler is not abandoned", () => {
  // 429／404／body 逾時走的是既有的 markRequestResponseEnded，不該進這條路。
  const req = request("never-started");
  const res = new MockResponse();
  res.finish(429);

  assert.equal(maybeMarkRequestAbandoned(req, res, { aborted: true }), false);
});

test("a handler that finished normally is not abandoned", () => {
  const req = request("normal");
  const res = new MockResponse();
  markRequestProcessingStarted(req);
  markRequestProcessingCompleted(req);
  res.finish(200);

  assert.equal(maybeMarkRequestAbandoned(req, res, { aborted: true }), false);
});

test("the response ending is not enough on its own", () => {
  // 這是最容易寫錯的一條。「回應結束了但 handler 還沒 settle」對每一筆請求都會
  // 短暫成立——回應送出到 dispatcher 的 finally 之間永遠有幾個 microtask。拿它
  // 當判定式等於對所有請求提早釋放槽位，系統性少算在飛的工作。
  const req = request("in-the-gap");
  const res = new MockResponse();
  markRequestProcessingStarted(req);
  res.finish(200);

  assert.equal(maybeMarkRequestAbandoned(req, res, { aborted: false }), false);
});

test("an abort is not enough on its own either", () => {
  // 逾時已經觸發，但回應還在送（檔案下載）。還有人在等它，不能算放棄。
  const req = request("still-writing");
  const res = new MockResponse();
  markRequestProcessingStarted(req);

  assert.equal(maybeMarkRequestAbandoned(req, res, { aborted: true }), false);
});

test("a timed-out handler that is still running is abandoned", () => {
  const req = request("stuck");
  const res = new MockResponse();
  markRequestProcessingStarted(req);

  assert.equal(abandon(req, res), true);
  // 冪等：finish 與 close 都會重跑判定式，兩者的先後順序不固定。
  assert.equal(maybeMarkRequestAbandoned(req, res, { aborted: true }), false);
});

test("a destroyed response counts as ended", () => {
  // 逾時打斷一個進行中的下載時，回應是被 destroy 的，不會有 finish。
  const req = request("destroyed");
  const res = new MockResponse();
  markRequestProcessingStarted(req);
  res.destroy();

  assert.equal(maybeMarkRequestAbandoned(req, res, { aborted: true }), true);
});

test("abandonment listeners fire once, and completion clears them", () => {
  const req = request("listeners");
  const res = new MockResponse();
  const fired = [];
  markRequestProcessingStarted(req);
  onRequestAbandoned(req, () => fired.push("a"));
  onRequestAbandoned(req, () => fired.push("b"));

  abandon(req, res);
  assert.deepEqual(fired, ["a", "b"]);

  // 已經完成的請求不可能再被放棄，而且監聽器不該一直握著 req／res。
  const late = request("late");
  markRequestProcessingStarted(late);
  onRequestAbandoned(late, () => fired.push("late"));
  markRequestProcessingCompleted(late);
  assert.deepEqual(fired, ["a", "b"]);
});

test("the unsubscribe handles come back from both subscriptions", () => {
  const req = request("unsubscribe");
  const res = new MockResponse();
  const fired = [];
  markRequestProcessingStarted(req);

  const dropAbandon = onRequestAbandoned(req, () => fired.push("abandon"));
  const dropComplete = onRequestProcessingComplete(req, () => fired.push("complete"));
  dropAbandon();
  dropComplete();

  abandon(req, res);
  markRequestProcessingCompleted(req);
  assert.deepEqual(fired, []);
});

test("both subscriptions refuse anything that is not a function", () => {
  const req = request("bad-listener");

  assert.throws(
    () => onRequestAbandoned(req, "nope"),
    /Request abandonment listener must be a function/
  );
  assert.throws(
    () => onRequestProcessingComplete(req, null),
    /Request processing completion listener must be a function/
  );
});

test("subscribing to a request that already completed fires immediately", () => {
  const req = request("already-done");
  markRequestProcessingStarted(req);
  markRequestProcessingCompleted(req);

  let fired = false;
  const drop = onRequestProcessingComplete(req, () => {
    fired = true;
  });

  assert.equal(fired, true);
  assert.doesNotThrow(drop);
});

test("subscribing after the fact still fires", () => {
  const req = request("after");
  const res = new MockResponse();
  markRequestProcessingStarted(req);
  abandon(req, res);

  let fired = false;
  const drop = onRequestAbandoned(req, () => {
    fired = true;
  });

  assert.equal(fired, true);
  // 已經觸發過的訂閱，退訂是個空操作，但仍然要能安全呼叫——呼叫端不會去分辨
  // 自己訂閱的時機。
  assert.doesNotThrow(drop);
});

// --- 槽位 -----------------------------------------------------------------------

async function createLimiter(overrides = {}) {
  const logger = memoryLogger();
  let now = 1000;
  const limiter = new RequestLimiterService({
    config: { ...baseConfig, ...overrides },
    logger,
    time: createTestTime({ clock: () => new Date(now) })
  });

  return {
    limiter,
    logger,
    advance(ms) {
      now += ms;
    }
  };
}

/** 寬限期在測試裡是 10ms，等久一點確保計時器真的跑過。 */
const tick = () => new Promise((resolve) => {
    setTimeout(resolve, 40);
  });

test("the slot comes back the moment the request is abandoned", async () => {
  const { limiter } = await createLimiter({ maxConcurrentRequests: 1, maxQueueSize: 1 });
  const started = [];
  const stuckRes = new MockResponse();
  const queuedRes = new MockResponse();
  const stuckReq = request("stuck");

  await limiter.handle(stuckReq, stuckRes, () => {
    markRequestProcessingStarted(stuckReq);
    started.push("stuck");
  });
  await limiter.handle(request("queued"), queuedRes, () => started.push("queued"));

  assert.deepEqual(started, ["stuck"]);
  assert.equal(limiter.activeRequests, 1);

  abandon(stuckReq, stuckRes);

  // 排隊的那一筆立刻拿到槽位——先前它要等一個永遠不會回來的 handler。
  assert.deepEqual(started, ["stuck", "queued"]);
  assert.equal(limiter.activeRequests, 1);
});

test("a handler that settles inside the grace window is not a leak", async () => {
  // 客戶端中途按取消是家常便飯：同樣會被判定為放棄，但 handler 幾毫秒後就正常
  // 返回。把它算成洩漏的話，真正的洩漏會埋在雜訊裡。
  const { limiter, logger } = await createLimiter({ abandonGraceMs: 10 });
  const res = new MockResponse();
  const req = request("cancelled");

  await limiter.handle(req, res, () => markRequestProcessingStarted(req));
  abandon(req, res);
  markRequestProcessingCompleted(req);

  // 等過寬限期。計時器沒有被取消的話，一個已經返回的 handler 會在這裡被誤報成
  // 洩漏，而且那一筆還會算進 503 的上限。
  await tick();

  assert.equal(limiter.abandonedRequests, 0);
  assert.equal(limiter.activeRequests, 0);
  assert.equal(
    logger.entries.some((entry) => entry.event === "request.handler_leaked"),
    false
  );
});

test("a handler still running after the grace window is reported as leaked", async () => {
  const { limiter, logger } = await createLimiter({ abandonGraceMs: 10 });
  const res = new MockResponse();
  const req = request("leaked");

  await limiter.handle(req, res, () => markRequestProcessingStarted(req));
  abandon(req, res);
  await tick();

  assert.equal(limiter.abandonedRequests, 1);
  const leaked = logger.entries.find((entry) => entry.event === "request.handler_leaked");
  // error 而不是 warn：先前這件事唯一的症狀是別人開始收到 429，沒有任何線索
  // 指回這條 route。
  assert.equal(leaked.level, "error");
  assert.equal(leaked.context.requestId, "leaked");
  assert.equal(leaked.context.url, "/api/test");
});

test("a leaked handler that eventually settles is counted back down", async () => {
  const { limiter, logger } = await createLimiter({ abandonGraceMs: 10 });
  const res = new MockResponse();
  const req = request("slow");

  await limiter.handle(req, res, () => markRequestProcessingStarted(req));
  abandon(req, res);
  await tick();
  assert.equal(limiter.abandonedRequests, 1);

  markRequestProcessingCompleted(req);

  // 單向累積的話，一個偶爾很慢的 route 會慢慢把實例推到 503 上限。
  assert.equal(limiter.abandonedRequests, 0);
  assert.equal(
    logger.entries.at(-1).event,
    "request.handler_recovered"
  );
});

test("the abandoned request is not charged twice when its handler settles", async () => {
  // 放棄時已經從 activeRequests 扣過了。settle 時扣錯邊就是同一筆扣兩次，而
  // Math.max(0, …) 會把它藏成「憑空多出來的槽位」——並行上限從此形同虛設。
  const { limiter } = await createLimiter({ maxConcurrentRequests: 2 });
  const stuckRes = new MockResponse();
  const stuckReq = request("stuck");
  const liveRes = new MockResponse();
  const liveReq = request("live");

  await limiter.handle(stuckReq, stuckRes, () => markRequestProcessingStarted(stuckReq));
  await limiter.handle(liveReq, liveRes, () => markRequestProcessingStarted(liveReq));
  assert.equal(limiter.activeRequests, 2);

  abandon(stuckReq, stuckRes);
  assert.equal(limiter.activeRequests, 1);

  markRequestProcessingCompleted(stuckReq);
  assert.equal(limiter.activeRequests, 1, "活著的那一筆還在跑");

  markRequestProcessingCompleted(liveReq);
  assert.equal(limiter.activeRequests, 0);
});

test("shutdown does not wait for handlers that will never return", async () => {
  // 等一個依定義永遠不會完成的東西，等於保證每次部署都燒滿 shutdownTimeoutMs
  // 然後強制退出。
  const { limiter } = await createLimiter({ abandonGraceMs: 10 });
  const res = new MockResponse();
  const req = request("stuck");

  await limiter.handle(req, res, () => markRequestProcessingStarted(req));
  abandon(req, res);
  await tick();

  assert.equal(limiter.abandonedRequests, 1);
  assert.equal(await limiter.waitForIdle(50), true);
});

test("enough leaked handlers takes the instance out of rotation", async () => {
  const { limiter, logger } = await createLimiter({
    abandonGraceMs: 10,
    maxAbandonedRequests: 2,
    maxConcurrentRequests: 10
  });

  for (const id of ["a", "b"]) {
    const res = new MockResponse();
    const req = request(id);
    await limiter.handle(req, res, () => markRequestProcessingStarted(req));
    abandon(req, res);
  }

  await tick();
  assert.equal(limiter.abandonedRequests, 2);

  const fresh = new MockResponse();
  await limiter.handle(request("fresh"), fresh, () => {
    throw new Error("must not reach the handler");
  });

  // 503 而不是 429：這不是「你太快了」，是這個實例壞了，該被換掉。
  assert.equal(fresh.statusCode, 503);
  assert.equal(
    logger.entries.some((entry) => entry.event === "request.limit.abandoned_ceiling"),
    true
  );
});

// --- request scope --------------------------------------------------------------

test("an abandoned request has its service scope torn down", async () => {
  // 這才是真正把 DB 連線收回來的動作。不拆的話，一個卡在交易中間的 handler 會
  // 一直吊著那些 row lock。
  let shutdownCalls = 0;
  const scope = {
    shutdown: async () => {
      shutdownCalls += 1;
      return { closed: true, failures: [] };
    }
  };
  const middleware = createRequestServiceScopeMiddleware({
    services: { createScope: () => scope, runInScope: (_scope, next) => next() },
    context: { update: () => {} },
    logger: memoryLogger(),
    shutdownTimeoutMs: 100
  });

  const req = request("scoped");
  const res = new MockResponse();
  middleware(req, res, () => markRequestProcessingStarted(req));

  abandon(req, res);
  await tick();
  assert.equal(shutdownCalls, 1);

  // handler 終於回來時不該再拆一次。
  markRequestProcessingCompleted(req);
  await tick();
  assert.equal(shutdownCalls, 1);
});

// --- 逾時中間件的接線 -------------------------------------------------------------

function timeoutHarness(timeoutMs = 20) {
  const req = request("timed");
  const res = new MockResponse();
  const logger = memoryLogger();
  const middleware = createRequestTimeoutMiddleware({
    timeoutMs,
    logger: { ...logger, warn: (...args) => logger.warn(...args) },
    context: { update: () => {} },
    time: createTestTime()
  });

  return { req, res, logger, middleware };
}

test("the timeout middleware marks the request abandoned once the 504 is out", async () => {
  const { req, res, middleware } = timeoutHarness(10);
  let abandoned = false;

  middleware(req, res, () => {
    markRequestProcessingStarted(req);
    onRequestAbandoned(req, () => {
      abandoned = true;
    });
  });

  await new Promise((resolve) => {
    setTimeout(resolve, 40);
  });
  assert.equal(abandoned, true);
});

test("a client that disconnects mid-flight abandons the request too", () => {
  const { req, res, middleware } = timeoutHarness(10_000);
  let abandoned = false;

  middleware(req, res, () => {
    markRequestProcessingStarted(req);
    onRequestAbandoned(req, () => {
      abandoned = true;
    });
  });

  // close 先觸發，abort 在 onClose 裡面——與逾時路徑的順序相反，所以兩邊都要
  // 重跑完整的判定式。
  res.destroy();
  assert.equal(abandoned, true);
});

test("a handler that hangs after sending its response is still caught", async () => {
  // 回應正常結束，所以 finish 那時 signal 還沒 aborted；計時器又看到 res 已經
  // 結束而提早 return。少了那裡的 abort，這種 handler 永遠不會被判定。
  const { req, res, middleware } = timeoutHarness(10);
  let abandoned = false;

  middleware(req, res, () => {
    markRequestProcessingStarted(req);
    onRequestAbandoned(req, () => {
      abandoned = true;
    });
    res.finish(200);
  });

  await new Promise((resolve) => {
    setTimeout(resolve, 40);
  });
  assert.equal(abandoned, true);
});

test("a request that completes normally is never abandoned", async () => {
  const { req, res, middleware } = timeoutHarness(10_000);
  let abandoned = false;

  middleware(req, res, () => {
    markRequestProcessingStarted(req);
    onRequestAbandoned(req, () => {
      abandoned = true;
    });
    res.finish(200);
    markRequestProcessingCompleted(req);
  });

  await new Promise((resolve) => {
    setTimeout(resolve, 20);
  });
  assert.equal(abandoned, false);
});

test("a settled handler releases the deadline, signal and all", async () => {
  // 期限現在活到 handler settle 為止，不是到回應結束為止。少了那一步，每一筆
  // 正常完成的請求都會把 req／res 吊到 timeoutMs 之後，然後在那時把一個早就
  // 結束的請求的 signal abort 掉。
  const { req, res, middleware } = timeoutHarness(10);

  middleware(req, res, () => {
    markRequestProcessingStarted(req);
    res.finish(200);
    markRequestProcessingCompleted(req);
  });

  await new Promise((resolve) => {
    setTimeout(resolve, 40);
  });
  assert.equal(req.requestTimeout.signal.aborted, false);
});

// --- 設定 ----------------------------------------------------------------------

test("the abandonment settings are validated", () => {
  for (const abandonGraceMs of [0, -1, 1.5, "soon"]) {
    assert.throws(
      () => normalizeRequestLimiterConfig({ abandonGraceMs }),
      /"abandonGraceMs" must be a positive integer/
    );
  }

  for (const maxAbandonedRequests of [0, -1, 1.5, "many"]) {
    assert.throws(
      () => normalizeRequestLimiterConfig({ maxAbandonedRequests }),
      /"maxAbandonedRequests" must be a positive integer/
    );
  }

  const defaults = normalizeRequestLimiterConfig({});
  assert.equal(defaults.abandonGraceMs, 1000);
  assert.equal(defaults.maxAbandonedRequests, 100);
});

test("a grace window longer than the request budget fails startup", () => {
  const source = defaultConfigurationSource();

  assert.throws(
    () =>
      validateApplicationConfiguration({
        ...source,
        requestLimiter: { ...source.requestLimiter, abandonGraceMs: 30000 }
      }),
    (error) =>
      error instanceof ConfigurationError &&
      /"abandonGraceMs" \(30000ms\) must be shorter than application\.requestTimeoutMs \(30000ms\)/.test(
        error.message
      )
  );

  // 短一毫秒就可以。
  assert.equal(
    validateApplicationConfiguration({
      ...source,
      requestLimiter: { ...source.requestLimiter, abandonGraceMs: 29999 }
    }).requestLimiter.abandonGraceMs,
    29999
  );
});
