import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { BaseRequestHandler } from "../src/framework/api/BaseRequestHandler.js";
import { createApplication } from "../src/framework/application/createApplication.js";
import { createBodyReceiveTimeoutMiddleware } from "../src/framework/middleware/bodyReceiveTimeout.js";
import { defaultConfigurationSource } from "../src/framework/configuration/applicationConfiguration.js";
import { normalizeApplicationConfig } from "../src/framework/configuration/normalizeApplicationConfig.js";
import { validateApiConfig } from "../src/framework/middleware/apiDispatcher.js";
import { fakeDatabaseOptions } from "../test-support/fakeMySqlPool.js";

// 限流槽位在請求進來的第一時間就被佔住，但 route 的 timeoutMs 要等 body 解析完
// 才開始計時。中間那一段沒有上限的話，幾個位元組就能佔住一個槽位——而且 handler
// 從未執行，所以沒有任何逾時會觸發，日誌上也看不出異常。

const VALID = Object.freeze({
  host: "127.0.0.1",
  port: 3000,
  timeZone: "Asia/Hong_Kong",
  requestTimeoutMs: 30000,
  requestReceiveTimeoutMs: 120000,
  headersReceiveTimeoutMs: 10000,
  bodyReceiveTimeoutMs: 10000,
  connectionsCheckingIntervalMs: 2000,
  shutdownTimeoutMs: 30000
});

// --- 設定的關係鏈 --------------------------------------------------------------

test("the receive timeout may not be shorter than the handler timeout", () => {
  // 上傳的 body 在 route timeout 開始之後才被讀取，兩段重疊。收取上限比較短的
  // 話 Node 會先斷線，route 的 timeoutMs 對任何會讀 body 的 route 都變成空話，
  // 症狀是「大檔案上傳偶爾失敗」，不會指回設定檔。
  assert.throws(
    () =>
      normalizeApplicationConfig({
        ...VALID,
        requestTimeoutMs: 30000,
        requestReceiveTimeoutMs: 20000
      }),
    /"requestReceiveTimeoutMs" \(20000ms\) must be at least "requestTimeoutMs" \(30000ms\)/
  );

  // 相等是允許的：收取剛好用完額度時 handler 還有完整的時間。
  assert.equal(
    normalizeApplicationConfig({
      ...VALID,
      requestTimeoutMs: 30000,
      requestReceiveTimeoutMs: 30000
    }).requestReceiveTimeoutMs,
    30000
  );
});

test("a timeout that can never fire is rejected instead of ignored", () => {
  // header 是整個請求的一部分。
  assert.throws(
    () =>
      normalizeApplicationConfig({
        ...VALID,
        headersReceiveTimeoutMs: 130000,
        requestReceiveTimeoutMs: 120000
      }),
    /"headersReceiveTimeoutMs" \(130000ms\) must not exceed "requestReceiveTimeoutMs"/
  );

  // 看門狗守的是 socket 層逾時之內的一小段，比它長就是死碼。
  assert.throws(
    () =>
      normalizeApplicationConfig({
        ...VALID,
        bodyReceiveTimeoutMs: 130000,
        requestReceiveTimeoutMs: 120000
      }),
    /"bodyReceiveTimeoutMs" \(130000ms\) must not exceed "requestReceiveTimeoutMs"/
  );
});

test("the checking interval may not swallow the timeout it enforces", () => {
  // Node 預設的 30000 正是這個陷阱：實測一個設成 1500ms 的逾時會在 30004ms
  // 才真的切斷連線。設定的數字與實際行為差 20 倍，而且沒有任何症狀。
  assert.throws(
    () =>
      normalizeApplicationConfig({
        ...VALID,
        connectionsCheckingIntervalMs: 30000,
        headersReceiveTimeoutMs: 10000
      }),
    /"connectionsCheckingIntervalMs" \(30000ms\) must not exceed "headersReceiveTimeoutMs" \(10000ms\)/
  );

  assert.equal(
    normalizeApplicationConfig({
      ...VALID,
      connectionsCheckingIntervalMs: 10000,
      headersReceiveTimeoutMs: 10000
    }).connectionsCheckingIntervalMs,
    10000
  );
});

test("the shipped defaults satisfy their own chain", async () => {
  const { default: applicationConfig } = await import("../config/application.js");
  const config = normalizeApplicationConfig(applicationConfig);

  assert.ok(config.requestReceiveTimeoutMs >= config.requestTimeoutMs);
  assert.ok(config.headersReceiveTimeoutMs <= config.requestReceiveTimeoutMs);
  assert.ok(config.bodyReceiveTimeoutMs <= config.requestReceiveTimeoutMs);
  assert.ok(config.connectionsCheckingIntervalMs <= config.headersReceiveTimeoutMs);
});

// --- 每條 route 的覆寫 ---------------------------------------------------------

class EchoHandler extends BaseRequestHandler {
  static handlerName = "echo";
  static api = {
    method: "POST",
    path: "/api/v1/echo",
    description: "Echoes its body.",
    authType: "public",
    authorizationPolicies: [{ name: "allowAll", options: {} }],
    requestSchema: { body: { type: "object", additionalProperties: true } },
    responseSchema: { 200: { type: "object", additionalProperties: true } }
  };

  async execute(req) {
    return this.response({ echoed: req.input.body });
  }
}

test("a route timeout longer than the receive timeout fails startup", () => {
  // 全域檢查看不到 per-route 覆寫，所以這一道必須在 route 註冊時再做一次。
  const route = {
    ...EchoHandler.api,
    version: "v1",
    deprecation: { deprecated: false, deprecatedAt: null, sunsetAt: null, replacement: null },
    idempotency: { enabled: false },
    logging: { bodyCapture: "none" },
    handler: "echo",
    timeoutMs: 200000
  };

  assert.throws(
    () =>
      validateApiConfig(
        [route],
        { echo: new EchoHandler("echo", { logger: null }) },
        { has: () => true, types: () => ["public"] },
        30000,
        undefined,
        undefined,
        undefined,
        120000
      ),
    /has timeoutMs 200000, which exceeds application\.requestReceiveTimeoutMs \(120000\)/
  );
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- 看門狗本身 ----------------------------------------------------------------

function collectingLogger() {
  const entries = [];
  const write = (level) => async (event, message, context) =>
    entries.push({ level, event, context });
  return { entries, debug: write("debug"), info: write("info"), warn: write("warn"), error: write("error") };
}

test("the watchdog refuses to be built without a usable timeout", () => {
  const logger = collectingLogger();
  const time = { nowMs: () => 0 };

  for (const timeoutMs of [0, -1, 1.5, "soon", undefined]) {
    assert.throws(
      () => createBodyReceiveTimeoutMiddleware({ timeoutMs, logger, time }),
      /Body receive timeout must be a positive integer/
    );
  }

  assert.throws(
    () => createBodyReceiveTimeoutMiddleware({ timeoutMs: 100, time }),
    /requires a system logger/
  );
  assert.throws(
    () => createBodyReceiveTimeoutMiddleware({ timeoutMs: 100, logger }),
    /requires a time service/
  );
});

test("a request whose body already arrived is passed straight through", () => {
  // GET 這類沒有 body 的請求在這裡就已經 complete，不該掛任何計時器。
  const middleware = createBodyReceiveTimeoutMiddleware({
    timeoutMs: 50,
    logger: collectingLogger(),
    time: { nowMs: () => 0 }
  });
  const listeners = [];
  const req = { complete: true, on: (...args) => listeners.push(args), once: (...args) => listeners.push(args) };
  let nexted = false;

  middleware(req, {}, () => {
    nexted = true;
  });

  assert.equal(nexted, true);
  assert.deepEqual(listeners, []);
});

test("a timer that fires after the response ended stays quiet", async () => {
  // cleanup 會在 finish/close 時清掉計時器，所以要走到這裡得是一場競賽：回應
  // 剛好在計時器 callback 排進佇列之後結束。這裡直接構造那個狀態。sendError
  // 對一個已結束的回應會拋 ERR_HTTP_HEADERS_SENT，而計時器裡的例外沒有任何
  // try 接得住，會變成 uncaughtException 讓整個程序結束。
  const logger = collectingLogger();
  const handlers = new Map();
  const req = {
    complete: false,
    headers: {},
    on: () => {},
    once: (event, listener) => handlers.set(`req:${event}`, listener),
    removeListener: () => {}
  };
  let destroyed = false;
  const res = {
    writableEnded: true,
    destroyed: false,
    once: (event, listener) => handlers.set(`res:${event}`, listener),
    removeListener: () => {},
    destroy: () => {
      destroyed = true;
    }
  };

  createBodyReceiveTimeoutMiddleware({
    timeoutMs: 1,
    logger,
    time: { nowMs: () => 0 }
  })(req, res, () => {});

  await wait(30);

  assert.deepEqual(logger.entries, []);
  assert.equal(destroyed, false);
});

// --- 端對端 --------------------------------------------------------------------

async function startApplication(t, overrides = {}) {
  const source = defaultConfigurationSource();
  const application = await createApplication({
    configurationSource: {
      ...source,
      application: {
        ...source.application,
        port: 0,
        shutdownTimeoutMs: 1000,
        ...overrides.application
      },
      requestLimiter: {
        ...source.requestLimiter,
        maxConcurrentRequests: 2,
        maxQueueSize: 2,
        queueTimeoutMs: 30000,
        ...overrides.requestLimiter
      },
      idempotency: { ...source.idempotency, storeAdapter: "memory" }
    },
    handlerRegistryOptions: {
      moduleUrls: ["virtual:slowRequestTimeouts"],
      moduleLoader: async () => ({ EchoHandler })
    },
    logger: {
      debug: async () => {}, info: async () => {}, warn: async () => {},
      error: async () => {}, flush: async () => {}
    },
    requestLogger: (_req, _res, next) => next(),
    serviceOptions: { mysqldatabase: fakeDatabaseOptions() },
    forceExit: () => {
      throw new Error("Slow request tests must not force exit");
    }
  });
  t.after(() => application.shutdown("test_cleanup"));

  const { url } = await application.start();
  return { application, url, port: Number(new URL(url).port) };
}

/** 宣告一個大 body，然後幾乎不送。 */
function slowBody(port) {
  const socket = net.connect(port, "127.0.0.1");
  socket.on("error", () => {});
  socket.on("data", () => {});
  socket.on("connect", () => {
    socket.write(
      "POST /api/v1/echo HTTP/1.1\r\nHost: 127.0.0.1\r\n" +
        "Content-Type: application/json\r\nContent-Length: 100000\r\n\r\n" +
        '{"a":"'
    );
  });
  return socket;
}

test("a few bytes can no longer hold a concurrency slot", async (t) => {
  const { application, url, port } = await startApplication(t, {
    application: { bodyReceiveTimeoutMs: 1000 }
  });
  const limiter = application.requestLimiter;
  const attackers = [slowBody(port), slowBody(port)];
  t.after(() => attackers.forEach((socket) => socket.destroy()));

  await wait(300);
  // 12 個位元組佔滿一個 maxConcurrentRequests 為 2 的實例。
  assert.equal(limiter.activeRequests, 2);

  await wait(1500);

  // 看門狗到期，兩個槽位都回來了。
  assert.equal(limiter.activeRequests, 0);

  const response = await fetch(`${url}/api/v1/echo`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hello: "world" })
  });
  assert.equal(response.status, 200);
});

test("the slow client is told why, and the log says how little it sent", async (t) => {
  const { port } = await startApplication(t, {
    application: { bodyReceiveTimeoutMs: 500 }
  });

  const socket = net.connect(port, "127.0.0.1");
  t.after(() => socket.destroy());
  let received = "";
  socket.on("error", () => {});
  socket.on("data", (chunk) => {
    received += chunk.toString();
  });
  await new Promise((resolve) => socket.once("connect", resolve));
  socket.write(
    "POST /api/v1/echo HTTP/1.1\r\nHost: 127.0.0.1\r\n" +
      "Content-Type: application/json\r\nContent-Length: 100000\r\n\r\n" +
      '{"a":"'
  );

  await wait(1200);

  // 408 而不是靜默斷線：慢速的合法客戶端要知道發生了什麼事。
  assert.match(received, /^HTTP\/1\.1 408/);
  assert.match(received, /REQUEST_BODY_TIMEOUT/);
  // 而且連線要斷——body 還在來，只送回應的話對方可以繼續送。
  assert.equal(socket.destroyed || socket.readyState === "closed", true);
});

test("the server carries the configured socket timeouts", async (t) => {
  // 這三個值只有在 createServer 的時候設得進去。實測 listen() 之後才指派
  // requestTimeout 完全無效——連線跨過兩次檢查間隔仍然活著。
  const { application } = await startApplication(t, {
    application: {
      requestReceiveTimeoutMs: 90000,
      headersReceiveTimeoutMs: 8000,
      connectionsCheckingIntervalMs: 1500
    }
  });

  assert.equal(application.server.requestTimeout, 90000);
  assert.equal(application.server.headersTimeout, 8000);
  assert.equal(application.server.connectionsCheckingInterval, 1500);
});

test("a normal request is untouched by the watchdog", async (t) => {
  const { url } = await startApplication(t, {
    application: { bodyReceiveTimeoutMs: 1000 }
  });

  // 送得完的請求不該被計時器影響，連續送也不該累積。
  for (let i = 0; i < 3; i += 1) {
    const response = await fetch(`${url}/api/v1/echo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ round: i })
    });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).data.echoed, { round: i });
  }
});
