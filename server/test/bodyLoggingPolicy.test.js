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

async function startApplication(t) {
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
      moduleLoader: async () => ({ QuietHandler, VerboseHandler })
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
    requestLogger: await createCollectingRequestLogger(entries),
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

async function createCollectingRequestLogger(entries) {
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
      bodyCaptureErrorStatus: 400
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

test("validation failures record the body even on a default route", async (t) => {
  const { url, entries } = await startApplication(t);

  // name 缺失會在 dispatcher 內被擋下，回 400。
  assert.equal(await post(`${url}/api/v1/quiet`, { idNumber: "A123456789" }), 400);

  const context = entries.at(-1).context;
  assert.deepEqual(context.input.body, { idNumber: "A123456789" });
  assert.equal(context.output.body.error.code, "REQUEST_VALIDATION_FAILED");
});
