import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { MemoryRateLimitStore } from "../src/framework/limiting/RateLimitStore.js";
import {
  markRequestProcessingCompleted,
  markRequestProcessingStarted
} from "../src/framework/http/requestProcessingLifecycle.js";
import { RequestLimiter } from "../src/framework/middleware/requestLimiter.js";
import { createTestTime } from "../test-support/createTestTime.js";

const baseConfig = {
  enabled: true,
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

test("request limiter processes queued requests in FIFO order and rejects a full queue", async () => {
  let now = 1000;
  const logger = memoryLogger();
  const time = createTestTime({ clock: () => new Date(now) });
  const limiter = new RequestLimiter({ config: baseConfig, logger, time });
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

test("request limiter rejects an IP that exceeds the sliding window", async () => {
  let now = 0;
  const logger = memoryLogger();
  const time = createTestTime({ clock: () => new Date(now) });
  const limiter = new RequestLimiter({
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
  const limiter = new RequestLimiter({
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
  const limiter = new RequestLimiter({ config: baseConfig, logger, time: createTestTime() });
  const activeResponse = new MockResponse();
  const queuedResponse = new MockResponse();

  await limiter.handle(request("active"), activeResponse, () => {});
  await limiter.handle(request("queued"), queuedResponse, () => {
    throw new Error("Queued request must not start during shutdown");
  });

  const idle = limiter.waitForIdle(1000);
  const rejectedQueuedRequests = limiter.shutdown();
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

test("request limiter instances share IP quotas through an injected store", async () => {
  let now = 5000;
  const time = createTestTime({ clock: () => new Date(now) });
  const store = new MemoryRateLimitStore({ now: () => time.nowMs() });
  const config = {
    ...baseConfig,
    maxConcurrentRequests: 10,
    maxRequestsPerIpPerWindow: 2
  };
  const firstInstance = new RequestLimiter({
    config,
    logger: memoryLogger(),
    time,
    store
  });
  const secondInstance = new RequestLimiter({
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
  const limiter = new RequestLimiter({
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
