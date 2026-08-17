import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { MemoryRateLimitStore } from "../src/services/requestLimiter/RateLimitStore.js";
import {
  markRequestProcessingCompleted,
  markRequestProcessingStarted
} from "../src/framework/http/requestProcessingLifecycle.js";
import { RequestLimiterService } from "../src/services/requestLimiter/RequestLimiterService.js";
import { createTestTime } from "../test-support/createTestTime.js";

const baseConfig = {
  apiPathPrefix: "/api",
  maxConcurrentRequests: 1,
  maxQueueSize: 1,
  queueTimeoutMs: 1000,
  maxRequestsPerIpPerWindow: 100,
  ipWindowMs: 1000,
  retryAfterSeconds: 1
};

class MockResponse extends EventEmitter {
  constructor() {
    super();
    this.headers = new Map();
    this.statusCode = 200;
    this.body = null;
    this.headersSent = false;
    this.writableEnded = false;
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
    this.emit("finish");
    return this;
  }

  finish(statusCode = 200) {
    this.statusCode = statusCode;
    this.headersSent = true;
    this.writableEnded = true;
    this.emit("finish");
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

test("startup says out loud that the IP quota is counted per instance", async () => {
  const logger = memoryLogger();
  const limiter = new RequestLimiterService({
    config: { ...baseConfig, maxRequestsPerIpPerWindow: 20 },
    logger,
    time: createTestTime()
  });

  await limiter.initialize();

  // 框架只有記憶體 store，所以四個實例等於四倍速率。看到設定寫 20 的人會相信
  // 全域就是 20/s，而這個誤解沒有任何徵兆——除非啟動時就講出來。
  const started = logger.entries.find(
    (entry) => entry.event === "request.limit.started"
  );
  assert.equal(started.level, "info");
  assert.equal(started.context.quotaScope, "instance");
  assert.equal(started.context.maxRequestsPerIpPerWindow, 20);
  assert.match(started.context.note, /per instance/);
});

test("request limiter processes queued requests in FIFO order and rejects a full queue", async () => {
  let now = 1000;
  const logger = memoryLogger();
  const time = createTestTime({ clock: () => new Date(now) });
  const limiter = new RequestLimiterService({ config: baseConfig, logger, time });
  const started = [];
  const firstResponse = new MockResponse();
  const secondResponse = new MockResponse();
  const rejectedResponse = new MockResponse();

  await limiter.handle(request("first"), firstResponse, () => started.push("first"));
  now += 10;
  await limiter.handle(request("second"), secondResponse, () => started.push("second"));
  now += 10;
  await limiter.handle(request("third"), rejectedResponse, () => started.push("third"));

  assert.deepEqual(started, ["first"]);
  assert.equal(limiter.activeRequests, 1);
  assert.equal(limiter.queue.length, 1);
  assert.equal(rejectedResponse.statusCode, 429);
  assert.deepEqual(rejectedResponse.body.error, {
    code: "Too Many Requests",
    message: "Too Many Requests"
  });

  now += 10;
  firstResponse.finish();
  assert.deepEqual(started, ["first", "second"]);
  assert.equal(limiter.activeRequests, 1);
  assert.equal(limiter.queue.length, 0);

  secondResponse.finish();
  assert.equal(limiter.activeRequests, 0);
  assert.ok(logger.entries.some((entry) => entry.event === "request.limit.queued"));
  assert.ok(logger.entries.some((entry) => entry.event === "request.limit.queue_full"));
  assert.ok(logger.entries.some((entry) => entry.event === "request.limit.dequeued"));
});

test("request limiter rejects an IP whose token bucket is empty", async () => {
  let now = 0;
  const logger = memoryLogger();
  const time = createTestTime({ clock: () => new Date(now) });
  const limiter = new RequestLimiterService({
    config: {
      ...baseConfig,
      maxConcurrentRequests: 10,
      maxRequestsPerIpPerWindow: 2
    },
    logger,
    time
  });

  for (const id of ["one", "two"]) {
    const response = new MockResponse();
    await limiter.handle(request(id, "10.0.0.8"), response, () => response.finish());
    now += 100;
  }

  const rejectedResponse = new MockResponse();
  await limiter.handle(request("three", "10.0.0.8"), rejectedResponse, () => {
    throw new Error("Rate-limited request must not start");
  });

  assert.equal(rejectedResponse.statusCode, 429);
  assert.equal(rejectedResponse.headers.get("retry-after"), "1");
  assert.ok(
    logger.entries.some((entry) => entry.event === "request.limit.ip_exceeded")
  );

  now = 1101;
  const acceptedResponse = new MockResponse();
  let accepted = false;
  await limiter.handle(request("four", "10.0.0.8"), acceptedResponse, () => {
    accepted = true;
    acceptedResponse.finish();
  });
  assert.equal(accepted, true);
});

test("request limiter rejects a queued request after its wait timeout", async () => {
  const logger = memoryLogger();
  const time = createTestTime();
  const limiter = new RequestLimiterService({
    config: { ...baseConfig, queueTimeoutMs: 10 },
    logger,
    time
  });
  const activeResponse = new MockResponse();
  const queuedResponse = new MockResponse();

  await limiter.handle(request("active"), activeResponse, () => {});
  await limiter.handle(request("queued"), queuedResponse, () => {
    throw new Error("Timed-out request must not start");
  });

  await new Promise((resolve) => { setTimeout(resolve, 30); });

  assert.equal(queuedResponse.statusCode, 429);
  assert.equal(limiter.queue.length, 0);
  assert.ok(
    logger.entries.some((entry) => entry.event === "request.limit.queue_timeout")
  );

  activeResponse.finish();
});

test("request limiter rejects queued and new requests during graceful shutdown", async () => {
  const logger = memoryLogger();
  const limiter = new RequestLimiterService({ config: baseConfig, logger, time: createTestTime() });
  const activeResponse = new MockResponse();
  const queuedResponse = new MockResponse();

  await limiter.handle(request("active"), activeResponse, () => {});
  await limiter.handle(request("queued"), queuedResponse, () => {
    throw new Error("Queued request must not start during shutdown");
  });

  const idle = limiter.waitForIdle(1000);
  const rejectedQueuedRequests = limiter.stopAccepting();
  assert.equal(rejectedQueuedRequests, 1);
  assert.equal(queuedResponse.statusCode, 503);
  assert.equal(queuedResponse.body.error.code, "SERVICE_UNAVAILABLE");

  const newResponse = new MockResponse();
  await limiter.handle(request("new"), newResponse, () => {
    throw new Error("New request must not start during shutdown");
  });
  assert.equal(newResponse.statusCode, 503);

  activeResponse.finish();
  assert.equal(await idle, true);
});

// 框架只提供記憶體 store，所以配額是每個實例各自算的。這個測試證明的是那道
// 接縫本身：兩個限流器共用同一個注入的 store 時，配額就是共用的——誰要跨實例
// 的精確配額，實作 RateLimitStore 並注入即可，不必改框架程式碼。
test("two limiters sharing one injected store share the quota", async () => {
  let now = 5000;
  const time = createTestTime({ clock: () => new Date(now) });
  const store = new MemoryRateLimitStore({ now: () => time.nowMs() });
  const config = {
    ...baseConfig,
    maxConcurrentRequests: 10,
    maxRequestsPerIpPerWindow: 2
  };
  const firstInstance = new RequestLimiterService({
    config,
    logger: memoryLogger(),
    time,
    store
  });
  const secondInstance = new RequestLimiterService({
    config,
    logger: memoryLogger(),
    time,
    store
  });

  for (const [limiter, id] of [
    [firstInstance, "instance-a"],
    [secondInstance, "instance-b"]
  ]) {
    const response = new MockResponse();
    await limiter.handle(request(id, "10.0.0.9"), response, () => response.finish());
    now += 10;
  }

  const rejected = new MockResponse();
  await firstInstance.handle(request("instance-a-2", "10.0.0.9"), rejected, () => {
    throw new Error("The shared quota must reject this request");
  });

  assert.equal(rejected.statusCode, 429);
  assert.equal(rejected.headers.get("retry-after"), "1");
});

test("request limiter keeps a slot until timed-out processing actually completes", async () => {
  const limiter = new RequestLimiterService({
    config: baseConfig,
    logger: memoryLogger(),
    time: createTestTime()
  });
  const firstRequest = request("long-running");
  const firstResponse = new MockResponse();
  const secondResponse = new MockResponse();
  const started = [];

  await limiter.handle(firstRequest, firstResponse, () => {
    started.push("first");
    markRequestProcessingStarted(firstRequest);
  });
  await limiter.handle(request("queued"), secondResponse, () => {
    started.push("second");
    secondResponse.finish();
  });

  firstResponse.finish(504);

  assert.equal(limiter.activeRequests, 1);
  assert.deepEqual(started, ["first"]);

  markRequestProcessingCompleted(firstRequest);

  assert.deepEqual(started, ["first", "second"]);
  assert.equal(limiter.activeRequests, 0);
});

// --- store 逾時 ---------------------------------------------------------------

// consume() 前後沒有任何逾時：注入的共享 adapter（例如 Redis）在連線池耗盡或
// 網路分區時可能永遠不 resolve。這段 await 比 bodyReceiveTimeout 和 route 的
// timeoutMs 都還要早，兩者都要等它 next() 之後才會啟動，activeRequests/queue
// 也要等 consume() resolve 才更動——所以少了這道逾時，整段完全不受保護。
test("a hanging store is bounded by storeOperationTimeoutMs and fails closed by default", async () => {
  const logger = memoryLogger();
  const hangingStore = { consume: () => new Promise(() => {}) };
  const limiter = new RequestLimiterService({
    config: { ...baseConfig, storeOperationTimeoutMs: 20, storeFailureMode: "closed" },
    logger,
    time: createTestTime(),
    store: hangingStore
  });
  const response = new MockResponse();

  await limiter.handle(request("stuck"), response, () => {
    throw new Error("request must not reach the handler while the store is hanging");
  });

  assert.equal(response.statusCode, 503);
  assert.equal(response.body.error.code, "SERVICE_UNAVAILABLE");
  assert.equal(limiter.activeRequests, 0);

  const timeoutEntry = logger.entries.find(
    (entry) => entry.event === "request.limit.store_timeout"
  );
  assert.ok(timeoutEntry);
  assert.equal(timeoutEntry.level, "error");
  assert.equal(timeoutEntry.context.failureMode, "closed");
});

test("storeFailureMode \"open\" lets a request through when the store hangs, but concurrency and the queue still apply", async () => {
  const logger = memoryLogger();
  const hangingStore = { consume: () => new Promise(() => {}) };
  const limiter = new RequestLimiterService({
    config: {
      ...baseConfig,
      storeOperationTimeoutMs: 20,
      storeFailureMode: "open",
      maxConcurrentRequests: 1
    },
    logger,
    time: createTestTime(),
    store: hangingStore
  });
  const firstResponse = new MockResponse();
  let started = false;

  await limiter.handle(request("first"), firstResponse, () => {
    started = true;
  });

  assert.equal(started, true);
  assert.equal(limiter.activeRequests, 1);

  const timeoutEntry = logger.entries.find(
    (entry) => entry.event === "request.limit.store_timeout"
  );
  assert.ok(timeoutEntry);
  assert.equal(timeoutEntry.context.failureMode, "open");

  // 並行上限與 store 無關，不該連帶跟著失效——第二個請求必須排隊，不能直接啟動。
  const secondResponse = new MockResponse();
  let secondStarted = false;

  await limiter.handle(request("second"), secondResponse, () => {
    secondStarted = true;
    secondResponse.finish();
  });
  assert.equal(secondStarted, false);
  assert.equal(limiter.queue.length, 1);

  firstResponse.finish();
  assert.equal(secondStarted, true);
  assert.equal(limiter.queue.length, 0);
});

// --- service 生命週期 --------------------------------------------------------

test("stopAccepting and shutdown are separate, so the store is actually closed", async () => {
  const limiter = new RequestLimiterService({
    config: baseConfig,
    logger: memoryLogger(),
    time: createTestTime()
  });
  let storeClosed = 0;
  limiter.store.close = async () => {
    storeClosed += 1;
  };

  // 容器只呼叫 shutdown||close 其中一個。兩者同名的話，Factory 先呼叫的那個會
  // 勝出，store 就永遠關不掉——memory 無感，共享 adapter 是洩一條連線。
  assert.equal(typeof limiter.shutdown, "function");
  const containerLifecycleMethod = limiter.shutdown || limiter.close;
  assert.equal(containerLifecycleMethod, limiter.shutdown);

  limiter.stopAccepting();
  assert.equal(storeClosed, 0, "停收不等於關閉");

  await containerLifecycleMethod.call(limiter);
  assert.equal(storeClosed, 1);
});

test("shutdown covers stopAccepting and stays idempotent", async () => {
  const logger = memoryLogger();
  const limiter = new RequestLimiterService({
    config: baseConfig,
    logger,
    time: createTestTime()
  });
  let storeClosed = 0;
  limiter.store.close = async () => {
    storeClosed += 1;
  };

  const activeResponse = new MockResponse();
  const queuedResponse = new MockResponse();
  await limiter.handle(request("active"), activeResponse, () => {});
  await limiter.handle(request("queued"), queuedResponse, () => {
    throw new Error("Queued request must not start during shutdown");
  });

  // 不經 Factory 直接用容器時，最壞只是排隊拒得晚，而不是 store 洩漏。
  await limiter.shutdown();
  assert.equal(queuedResponse.statusCode, 503);
  assert.equal(storeClosed, 1);

  // Factory 已經呼叫過 stopAccepting()，容器之後還會呼叫一次 shutdown()。
  await limiter.shutdown();
  assert.equal(storeClosed, 1);
  assert.equal(
    logger.entries.filter(({ event }) => event === "request.limit.shutdown").length,
    1,
    "重複關閉不該重複記錄"
  );

  activeResponse.finish();
});

test("the managed constructor reads its own configuration section", () => {
  const logger = memoryLogger();
  const time = createTestTime();
  const services = {
    require: (name) => ({ logging: { logger }, time })[name]
  };
  const limiter = new RequestLimiterService({
    config: { requestLimiter: { ...baseConfig, maxConcurrentRequests: 7 } },
    services
  });

  // 設定自己一個區塊、自己一個檔案；service 不再從 request.limits 底下撈。
  assert.equal(limiter.config.maxConcurrentRequests, 7);
  assert.equal(limiter.logger, logger);
  assert.equal(limiter.time, time);
});

test("a non-memory adapter without an injected store fails to construct", () => {
  const services = {
    require: (name) => ({ logging: { logger: memoryLogger() }, time: createTestTime() })[name]
  };

  // 不擋的話設定會靜默退回 memory，多實例部署各自算各自的配額——一個看不出來
  // 的限流失效。
  assert.throws(
    () =>
      new RequestLimiterService({
        config: { requestLimiter: { ...baseConfig, storeAdapter: "redis" } },
        services
      }),
    /RateLimitStore adapter must be injected for redis/
  );

  const store = new MemoryRateLimitStore();
  const limiter = new RequestLimiterService({
    config: { requestLimiter: { ...baseConfig, storeAdapter: "redis" } },
    services,
    options: { store }
  });
  assert.equal(limiter.store, store);
});
