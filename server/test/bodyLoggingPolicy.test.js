import assert from "node:assert/strict";
import test from "node:test";
import { BaseRequestHandler } from "../src/framework/api/BaseRequestHandler.js";
import { createApplication } from "../src/framework/application/createApplication.js";
import { defaultConfigurationSource } from "../src/framework/configuration/applicationConfiguration.js";
import { fakeDatabaseOptions } from "../test-support/fakeMySqlPool.js";

// 端對端驗證 body 記錄政策：從 Handler 的 static api.logging 一路到寫出的日誌 entry。
const employee = Object.freeze({
  name: "陳大文",
  idNumber: "A123456789",
  monthlySalary: 68000
});

const requestSchema = {
  body: {
    type: "object",
    required: ["name"],
    additionalProperties: true,
    properties: { name: { type: "string" } }
  }
};
const responseSchema = {
  200: { type: "object", additionalProperties: true },
  201: { type: "object", additionalProperties: true }
};

class QuietHandler extends BaseRequestHandler {
  static handlerName = "quiet";
  static api = {
    method: "POST",
    path: "/api/v1/quiet",
    description: "Uses the default body logging policy.",
    authType: "public",
    authorizationPolicies: [{ name: "allowAll", options: {} }],
    requestSchema,
    responseSchema
  };

  async execute(req) {
    if (req.input.body.fail) {
      return this.response({ echoed: req.input.body }, { statusCode: 201 });
    }

    return this.response({ echoed: req.input.body });
  }
}

class VerboseHandler extends BaseRequestHandler {
  static handlerName = "verbose";
  static api = {
    ...QuietHandler.api,
    path: "/api/v1/verbose",
    description: "Opts in to full body logging.",
    logging: { bodyCapture: "full" }
  };

  async execute(req) {
    return this.response({ echoed: req.input.body });
  }
}

class BoomHandler extends BaseRequestHandler {
  static handlerName = "boom";
  static api = {
    ...QuietHandler.api,
    path: "/api/v1/boom",
    description: "Fails, so the 5xx branch is exercised end to end."
  };

  async execute() {
    throw new Error("handler exploded");
  }
}

async function startApplication(t, { errorStatus } = {}) {
  const source = defaultConfigurationSource();
  const entries = [];
  const application = await createApplication({
    configurationSource: {
      ...source,
      application: { ...source.application, port: 0, shutdownTimeoutMs: 1000 }
    },
    // 走註冊流程而非直接傳 handlers，讓容器把 time 等服務注入進去。
    handlerRegistryOptions: {
      moduleUrls: ["virtual:bodyLoggingHandlers"],
      moduleLoader: async () => ({ QuietHandler, VerboseHandler, BoomHandler })
    },
    logger: {
      entries: [],
      debug: async () => {},
      info: async () => {},
      warn: async () => {},
      error: async () => {},
      flush: async () => {}
    },
    // 取代 request logger，直接收集 entry 而不落盤。
    requestLogger: await createCollectingRequestLogger(entries, errorStatus),
    serviceOptions: {
      mysqldatabase: fakeDatabaseOptions()
    },
    forceExit: () => {
      throw new Error("Body logging test must not force exit");
    }
  });
  t.after(() => application.shutdown("test_cleanup"));

  const { url } = await application.start();
  return { url, entries };
}

async function createCollectingRequestLogger(entries, errorStatus) {
  // 預設取用實際出貨的設定值，而不是在測試裡另外寫一個數字——否則這些端對端
  // 斷言驗的是測試自己編出來的政策，改壞 config/logging.js 不會有人出聲。
  const { default: loggingConfig } = await import("../config/logging.js");
  const [{ createRequestLogger }, { Logger }, { createTestTime }] = await Promise.all([
    import("../src/framework/middleware/requestLogger.js"),
    import("../src/services/logging/Logger.js"),
    import("../test-support/createTestTime.js")
  ]);
  const time = createTestTime();
  const logger = new Logger({
    name: "request",
    config: {
      enabled: true,
      directory: "",
      filePrefix: "requests",
      redactedFields: ["password"],
      bodyCapture: "none",
      bodyCaptureErrorStatus:
        errorStatus === undefined
          ? loggingConfig.loggers.request.bodyCaptureErrorStatus
          : errorStatus
    },
    time,
    writer: {
      async write(entry) {
        entries.push(entry);
      }
    }
  });
  const middleware = createRequestLogger({ logger, time });
  middleware.flush = async () => {};
  return middleware;
}

async function post(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  await response.text();
  return response.status;
}

test("default routes keep successful bodies out of the request log", async (t) => {
  const { url, entries } = await startApplication(t);

  assert.equal(await post(`${url}/api/v1/quiet`, employee), 200);

  const context = entries.at(-1).context;
  assert.equal(context.input.body, "[NOT_LOGGED]");
  assert.equal(context.output.body, "[NOT_LOGGED]");
  assert.equal(context.bodyCapture, "none");
  // 中介資料仍然完整，除錯時仍能定位請求。
  assert.equal(context.output.statusCode, 200);
  assert.equal(context.method, "POST");
  assert.match(context.url, /\/api\/v1\/quiet$/);
});

test("a route that opts in records full bodies end to end", async (t) => {
  const { url, entries } = await startApplication(t);

  assert.equal(await post(`${url}/api/v1/verbose`, employee), 200);

  const context = entries.at(-1).context;
  assert.equal(context.bodyCapture, "full");
  assert.deepEqual(context.input.body, employee);
  assert.deepEqual(context.output.body.data.echoed, employee);
});

test("a validation failure does not spill the submitted body into the log", async (t) => {
  const { url, entries } = await startApplication(t);

  // name 缺失會在 dispatcher 內被擋下，回 400。
  assert.equal(await post(`${url}/api/v1/quiet`, { idNumber: "A123456789" }), 400);

  // 4xx 是「客戶端送錯了」，錯在哪錯誤訊息本身就說了。而 4xx 正是使用者填了
  // 東西然後被拒的路徑，把 body 落盤等於讓每一次驗證失敗都留下 30 天的個資。
  const context = entries.at(-1).context;
  assert.equal(context.input.body, "[NOT_LOGGED]");
  // 定位問題要的東西仍然齊全。
  assert.equal(context.output.statusCode, 400);
  assert.match(context.url, /\/api\/v1\/quiet$/);

  // 同一個門檻同時管 request 與 response body，所以錯誤回應的內容也一起不落盤。
  // 那裡面有 error.code——不是個資，是定位問題的第一個線索。它沒有消失，只是
  // 搬到 system log 的 http.request_failed，靠 requestId 對得回來。
  assert.equal(context.output.body, "[NOT_LOGGED]");
  assert.equal(typeof context.requestId, "string");
});

test("a server error records the body, because that is what cannot be reproduced", async (t) => {
  const { url, entries } = await startApplication(t);

  assert.equal(await post(`${url}/api/v1/boom`, employee), 500);

  // 5xx 是伺服器壞了。沒有觸發它的那份 body，這種問題往往重現不了——
  // 這是 bodyCaptureErrorStatus 存在的理由，門檻調到 500 也還在。
  const context = entries.at(-1).context;
  assert.deepEqual(context.input.body, employee);
  assert.equal(context.output.statusCode, 500);
});

test("lowering the threshold to 400 is available to anyone who needs it", async (t) => {
  // 查一個只在生產環境重現的 4xx 時，這是一個明確的、暫時的決定。機制沒有
  // 因為預設值變嚴而消失。
  const { url, entries } = await startApplication(t, { errorStatus: 400 });

  assert.equal(await post(`${url}/api/v1/quiet`, { idNumber: "A123456789" }), 400);

  assert.deepEqual(entries.at(-1).context.input.body, { idNumber: "A123456789" });
});

test("the shipped default keeps 4xx bodies out of the log", async () => {
  // 這個值沒有其他測試綁著，改掉不會有任何東西壞——正好是它需要一道明確
  // 斷言的理由。
  const { default: loggingConfig } = await import("../config/logging.js");

  assert.equal(loggingConfig.loggers.request.bodyCaptureErrorStatus, 500);
});
