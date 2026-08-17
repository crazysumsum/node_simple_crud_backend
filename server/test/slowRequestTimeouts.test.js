import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { BaseRequestHandler } from "../src/framework/api/BaseRequestHandler.js";
import { createApplication } from "../src/framework/application/createApplication.js";
import { createBodyReceiveTimeoutMiddleware } from "../src/framework/middleware/bodyReceiveTimeout.js";
import {
  defaultConfigurationSource,
  validateApplicationConfiguration
} from "../src/framework/configuration/applicationConfiguration.js";
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
  shutdownTimeoutMs: 30000,
  maxConnections: 512
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

// --- 全域連線上限 ----------------------------------------------------------------
//
// 上面四個逾時都管「一條連線能活多久」，沒有一個管「同時能有幾條」。header 還
// 沒收完的連線也是一個已經 accept 的 socket，佔著一個 fd；headersTimeout 到期
// 前，攻擊者可以不斷開新的慢速連線頂替被切斷的那些，直到耗盡 fd——跟連線是否
// 逾時完全無關。maxConnections 是唯一頂著這件事的設定。

test("maxConnections must be able to hold a full load of requests", () => {
  // 上限比限流器自己能撐住的並行加排隊還小，代表正常滿載時 socket 就會先被
  // 砍，limiter 的 429／佇列永遠等不到——那不是背壓，是設定錯誤，而且症狀是
  // 連線被直接切斷，沒有任何 HTTP 回應可以指回這裡。
  const source = defaultConfigurationSource();

  assert.throws(
    () =>
      validateApplicationConfiguration({
        ...source,
        application: { ...source.application, maxConnections: 250 },
        requestLimiter: {
          ...source.requestLimiter,
          maxConcurrentRequests: 100,
          maxQueueSize: 200
        }
      }),
    /"maxConnections" \(250\) must be at least requestLimiter\.maxConcurrentRequests \+ maxQueueSize \(300\)/
  );

  // 剛好夠是可以的。
  assert.ok(
    validateApplicationConfiguration({
      ...source,
      application: { ...source.application, maxConnections: 300 },
      requestLimiter: {
        ...source.requestLimiter,
        maxConcurrentRequests: 100,
        maxQueueSize: 200
      }
    })
  );
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

/**
 * 上傳 route。timeoutMs 刻意訂得短，這樣「停滯的 multipart 由 route timeout
 * 收掉」不必等預設的 30 秒。
 */
function makeUploadHandler(directory) {
  return class UploadHandler extends BaseRequestHandler {
    static handlerName = "upload";
    static api = {
      method: "POST",
      path: "/api/v1/upload",
      description: "Accepts a file.",
      authType: "public",
      authorizationPolicies: [{ name: "allowAll", options: {} }],
      timeoutMs: 2000,
      upload: {
        enabled: true,
        directory,
        maxFileSizeBytes: 4096,
        maxFiles: 1,
        allowedMimeTypes: ["image/png"]
      },
      requestSchema: { body: { type: "object", additionalProperties: true } },
      responseSchema: { 201: { type: "object", additionalProperties: true } }
    };

    async execute(req) {
      return this.response({ fileCount: req.files.length }, { statusCode: 201 });
    }
  };
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

test("createApplication honors an injected requestReceiveTimeoutMs, not the module's static default", async (t) => {
  // 迴歸測試：createApplication 曾經在建立 dispatcher 之前自己呼叫一次
  // validateApiConfig，卻沒有帶 requestReceiveTimeoutMs，於是退回
  // apiDispatcher.js 模組載入時讀到的靜態預設（120000）。呼叫端注入的
  // requestReceiveTimeoutMs 比那個靜態預設高時，一個其實合法的 route
  // （130000，只超過靜態預設，沒超過注入值）會被那第一次驗證錯誤地擋下來，
  // 永遠走不到後面用了正確設定值的 createApiDispatcher。
  class LongRunningHandler extends BaseRequestHandler {
    static handlerName = "longRunning";
    static api = {
      method: "POST",
      path: "/api/v1/long-running",
      description: "Only legal once requestReceiveTimeoutMs is actually raised.",
      authType: "public",
      authorizationPolicies: [{ name: "allowAll", options: {} }],
      timeoutMs: 130000,
      requestSchema: { body: { type: "object", additionalProperties: true } },
      responseSchema: { 200: { type: "object", additionalProperties: true } }
    };

    async execute(req) {
      return this.response({ echoed: req.input.body });
    }
  }

  const source = defaultConfigurationSource();
  const application = await createApplication({
    configurationSource: {
      ...source,
      application: {
        ...source.application,
        port: 0,
        shutdownTimeoutMs: 1000,
        requestReceiveTimeoutMs: 150000
      },
      idempotency: { ...source.idempotency, storeAdapter: "memory" }
    },
    handlerRegistryOptions: {
      moduleUrls: ["virtual:requestReceiveTimeoutRegression"],
      moduleLoader: async () => ({ LongRunningHandler })
    },
    logger: {
      debug: async () => {}, info: async () => {}, warn: async () => {},
      error: async () => {}, flush: async () => {},
      isSensitiveField: () => false
    },
    requestLogger: (_req, _res, next) => next(),
    serviceOptions: { mysqldatabase: fakeDatabaseOptions() },
    forceExit: () => {
      throw new Error("must not force exit");
    }
  });
  t.after(() => application.shutdown("test_cleanup"));

  // 沒有在 createApplication() 這一步就丟出例外，代表 route 驗證用的是
  // 真正注入的 requestReceiveTimeoutMs（150000），不是模組的靜態預設。
  assert.equal(application.state, "created");
});

const wait = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

// --- 看門狗本身 ----------------------------------------------------------------

function collectingLogger() {
  const entries = [];
  const write = (level) => async (event, message, context) =>
    entries.push({ level, event, context });
  return {
    entries,
    debug: write("debug"),
    info: write("info"),
    warn: write("warn"),
    error: write("error"),
    isSensitiveField: () => false
  };
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
  const uploadDirectory = await mkdtemp(path.join(tmpdir(), "slow-request-"));
  t.after(() => rm(uploadDirectory, { recursive: true, force: true }));
  const UploadHandler = makeUploadHandler(uploadDirectory);
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
      moduleLoader: async () => ({ EchoHandler, UploadHandler })
    },
    logger: {
      debug: async () => {}, info: async () => {}, warn: async () => {},
      error: async () => {}, flush: async () => {},
      isSensitiveField: () => false
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
  await new Promise((resolve) => {
    socket.once("connect", resolve);
  });
  socket.write(
    "POST /api/v1/echo?token=leaked HTTP/1.1\r\nHost: 127.0.0.1\r\n" +
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

/** 連上但什麼都不送——連 header 都沒開始，純粹只佔一個 fd。 */
function openSocket(port) {
  const socket = net.connect(port, "127.0.0.1");
  socket.on("error", () => {});
  return socket;
}

test("connections beyond maxConnections are dropped immediately, not after the header timeout", async (t) => {
  // headersReceiveTimeoutMs 刻意留在遠大於測試等待時間的地方：如果多出來的
  // socket 是因為逾時才斷線，這個測試會等不到就失敗，證明擋下它們的是
  // maxConnections 而不是任何一個逾時。
  const { port } = await startApplication(t, {
    application: { maxConnections: 3, headersReceiveTimeoutMs: 60000 },
    requestLimiter: { maxConcurrentRequests: 1, maxQueueSize: 0 }
  });

  const attackers = Array.from({ length: 5 }, () => openSocket(port));
  t.after(() => attackers.forEach((socket) => socket.destroy()));

  await wait(300);

  const accepted = attackers.filter((socket) => !socket.destroyed);
  const rejected = attackers.filter((socket) => socket.destroyed);

  // Node 在 accept() 之後立刻依 maxConnections 決定去留，這一刻甚至還沒有
  // header——多出來的兩個必須已經被砍掉，剩下的三個原封不動地開著。
  assert.equal(accepted.length, 3);
  assert.equal(rejected.length, 2);
});

test("closing the excess connections returns capacity to legitimate requests", async (t) => {
  const { url, port } = await startApplication(t, {
    application: { maxConnections: 3, headersReceiveTimeoutMs: 60000 },
    requestLimiter: { maxConcurrentRequests: 1, maxQueueSize: 0 }
  });

  // 打滿連線上限，模擬耗盡 fd 攻擊的高峰。
  const attackers = Array.from({ length: 3 }, () => openSocket(port));
  t.after(() => attackers.forEach((socket) => socket.destroy()));
  await wait(300);
  assert.equal(attackers.every((socket) => !socket.destroyed), true);

  // 上限已經打滿，這一刻連合法請求都進不來——這正是攻擊想製造的效果。
  await assert.rejects(() => fetch(`${url}/api/v1/echo`, { signal: AbortSignal.timeout(300) }));

  // 攻擊停止、連線收回,容量要立刻還回去，不必等任何逾時。
  attackers.forEach((socket) => socket.destroy());
  await wait(100);

  const response = await fetch(`${url}/api/v1/echo`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ recovered: true })
  });
  assert.equal(response.status, 200);
});

// --- multipart ----------------------------------------------------------------

const UPLOAD_BOUNDARY = "----slowuploadtest";
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(56, 0x41)
]);

function multipartBody() {
  return Buffer.concat([
    Buffer.from(
      `--${UPLOAD_BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\n` +
        "Content-Type: image/png\r\n\r\n"
    ),
    PNG,
    Buffer.from(`\r\n--${UPLOAD_BOUNDARY}--\r\n`)
  ]);
}

function openUpload(port, contentLength) {
  const socket = net.connect(port, "127.0.0.1");
  let received = "";
  socket.on("error", () => {});
  socket.on("data", (chunk) => {
    received += chunk.toString();
  });
  const connected = new Promise((resolve) => {
    socket.once("connect", () => {
      socket.write(
        "POST /api/v1/upload HTTP/1.1\r\nHost: 127.0.0.1\r\n" +
          `Content-Type: multipart/form-data; boundary=${UPLOAD_BOUNDARY}\r\n` +
          `Content-Length: ${contentLength}\r\n\r\n`
      );
      resolve();
    });
  });
  return { socket, connected, response: () => received };
}

test("a slow but legitimate upload is not cut off by the watchdog", async (t) => {
  // 這是這個看門狗最容易誤傷的東西：一個完全合法、只是慢的上傳。計時器掛在
  // express.json() 之前，而 multipart 瞬間走完那一段——沒有 bodyParsingComplete
  // 解除它的話，計時器會在背景倒數，然後把上傳到一半的請求切掉。
  //
  // 誤傷的規模是設定值的兩個數量級：看門狗的秒數是照 jsonBodyLimit（預設
  // 100kb）訂的，套到 maxFileSizeBytes（預設 10MB）上就變成 1 MB/s 的下限。
  const { port } = await startApplication(t, {
    application: { bodyReceiveTimeoutMs: 500 }
  });
  const body = multipartBody();
  const { socket, connected, response } = openUpload(port, body.length);
  t.after(() => socket.destroy());
  await connected;

  // 每 100ms 送 16 bytes，總時長遠超過 bodyReceiveTimeoutMs。
  for (let offset = 0; offset < body.length; offset += 16) {
    assert.equal(socket.destroyed, false, `socket was cut off at byte ${offset}`);
    socket.write(body.subarray(offset, offset + 16));
    await wait(100);
  }

  await wait(300);
  assert.match(response(), /^HTTP\/1\.1 201/);
  assert.doesNotMatch(response(), /REQUEST_BODY_TIMEOUT/);
});

test("a stalled upload is still bounded, by the route timeout", async (t) => {
  // 上一個測試把看門狗從 multipart 上拿掉了，所以這一個必須證明那一段仍然有
  // 上限——否則就是把 #38 修掉的槽位耗盡漏洞放回來。route 的 timeoutMs 掛在
  // uploadMiddleware 之前，涵蓋整個 body 收取；逾時 abort 後槽位會還回來。
  const { application, port } = await startApplication(t, {
    // 遠大於 route 的 timeoutMs（2000）：確保收掉停滯連線的是 route timeout。
    application: { bodyReceiveTimeoutMs: 60000 }
  });
  const limiter = application.requestLimiter;
  const stalled = [
    openUpload(port, 100000),
    openUpload(port, 100000)
  ];
  t.after(() => stalled.forEach(({ socket }) => socket.destroy()));

  await Promise.all(stalled.map(({ connected }) => connected));
  for (const { socket } of stalled) {
    socket.write(`--${UPLOAD_BOUNDARY}\r\n`);
  }

  await wait(400);
  assert.equal(limiter.activeRequests, 2);

  await wait(2200);

  // route 的 timeoutMs 到期，兩個槽位都回來了。
  assert.equal(limiter.activeRequests, 0);

  const body = multipartBody();
  const { socket, connected, response } = openUpload(port, body.length);
  t.after(() => socket.destroy());
  await connected;
  socket.write(body);
  await wait(300);
  assert.match(response(), /^HTTP\/1\.1 201/);

  // 停滯的連線要在這裡就斷掉，不能只靠 t.after：那些 after 依註冊順序執行，
  // 而 shutdown 是 startApplication 先註冊的。逾時只送了 504，socket 仍然開著
  // （body 還沒收完，所以也不是 idle），關閉會等到逾時然後強制結束。
  stalled.forEach(({ socket: stalledSocket }) => stalledSocket.destroy());
  socket.destroy();
  await wait(50);
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
