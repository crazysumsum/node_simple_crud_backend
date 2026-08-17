import assert from "node:assert/strict";
import test from "node:test";
import { BaseRequestHandler } from "../src/framework/api/BaseRequestHandler.js";
import { AuthenticationError } from "../src/framework/auth/AuthenticationError.js";
import { BaseAuthStrategy } from "../src/framework/auth/BaseAuthStrategy.js";
import { createApplication } from "../src/framework/application/createApplication.js";
import { defaultConfigurationSource } from "../src/framework/configuration/applicationConfiguration.js";
import { ConfigurationError } from "../src/framework/configuration/ConfigurationError.js";
import {
  fakeDatabaseOptions,
  fakeMySqlPool
} from "../test-support/fakeMySqlPool.js";

function memoryLogger() {
  const entries = [];
  const write = (level) => async (event, message, context) => {
    entries.push({ level, event, message, context });
  };

  return {
    entries,
    debug: write("debug"),
    info: write("info"),
    warn: write("warn"),
    error: write("error"),
    flush: async () => {}
  };
}

function testRequestLogger() {
  const middleware = (req, res, next) => {
    req.requestId = "factory-request";
    res.setHeader("X-Request-Id", req.requestId);
    next();
  };
  middleware.flush = async () => {};
  return middleware;
}

test("application factory validates configuration before creating the MySQL database pool", async () => {
  const source = defaultConfigurationSource();
  let poolFactoryCalls = 0;

  await assert.rejects(
    () =>
      createApplication({
        configurationSource: {
          ...source,
          application: { ...source.application, requestTimeoutMs: 0 }
        },
        serviceOptions: {
          mysqldatabase: {
            poolFactory: () => {
              poolFactoryCalls += 1;
              return {};
            }
          }
        }
      }),
    ConfigurationError
  );
  assert.equal(poolFactoryCalls, 0);
});

test("application factory shuts down container services when setup fails", async () => {
  const source = defaultConfigurationSource();
  const logger = memoryLogger();
  let closeCalls = 0;
  let poolFactoryCalls = 0;
  let poolEndCalls = 0;
  class MissingApiHandler extends BaseRequestHandler {
    static handlerName = "missingApi";
  }
  const strategies = {
    has: () => true,
    types: () => ["public", "jwt"],
    authenticate: async (type) => ({ type }),
    close: async () => {
      closeCalls += 1;
    }
  };

  await assert.rejects(() =>
    createApplication({
      configurationSource: source,
      strategies,
      handlers: {
        missingApi: new MissingApiHandler({ logger })
      },
      logger,
      requestLogger: testRequestLogger(),
      serviceOptions: {
        mysqldatabase: {
          poolFactory: () => {
            poolFactoryCalls += 1;
            return {
              query: async () => [[{ ok: 1 }]],
              end: async () => {
                poolEndCalls += 1;
              }
            };
          }
        }
      }
    })
  );

  // 策略的生命週期由 service container 負責，注入進來的 registry 屬於呼叫方，
  // 框架不再代為關閉——這裡確認的是容器持有的資源確實被釋放。
  assert.equal(closeCalls, 0);
  assert.equal(poolFactoryCalls, 1);
  assert.equal(poolEndCalls, 1);
});

test("application factory builds a startable and stoppable API with injected resources", async (t) => {
  const source = defaultConfigurationSource();
  const logger = memoryLogger();
  const pool = fakeMySqlPool();
  const application = await createApplication({
    configurationSource: {
      ...source,
      application: {
        ...source.application,
        port: 0,
        requestTimeoutMs: 100,
        shutdownTimeoutMs: 1000
      },
      // route 逾時縮到 100ms，DB 的預算就得跟著縮——啟動時的交叉檢查要求
      // 資料庫先於 route 放棄。
      database: {
        ...source.database,
        acquireTimeoutMs: 40,
        queryTimeoutMs: 40,
        transactionTimeoutMs: 40
      },
      // 同理：洩漏 handler 的寬限期不能比整個請求的預算還長。
      requestLimiter: { ...source.requestLimiter, abandonGraceMs: 50 }
    },
    logger,
    requestLogger: testRequestLogger(),
    serviceOptions: { mysqldatabase: { pool } },
    forceExit: () => {
      throw new Error("Factory test must not force exit");
    }
  });
  t.after(() => application.shutdown("test_cleanup"));

  assert.equal(application.state, "created");
  // 啟動時剛好三次查詢：連線驗證，以及撤銷名單首次載入的那兩句——資料庫時鐘
  // （用來比對本機時鐘有沒有偏差）與名單本身。數字釘死是為了擋住「每個 service
  // 都在啟動時順手打一次資料庫」這種會慢慢長出來的問題。
  assert.equal(pool.calls.query, 3);
  const { url } = await application.start();
  // start() 只是開始監聽，不該再產生查詢。
  assert.equal(pool.calls.query, 3);
  const response = await fetch(`${url}/api/v1/health`);
  const body = await response.json();

  assert.equal(application.state, "started");
  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.data.database, "connected");
  assert.equal(body.meta.requestId, "factory-request");

  // 框架不認識的路徑仍必須使用統一 JSON 信封，而不是 Express 內建的 HTML 404。
  for (const path of ["/", "/does-not-exist", "/apidocs"]) {
    const missing = await fetch(`${url}${path}`);
    const missingBody = await missing.json();

    assert.equal(missing.status, 404, `unexpected status for ${path}`);
    assert.match(missing.headers.get("content-type"), /application\/json/);
    assert.equal(missingBody.success, false);
    assert.equal(missingBody.error.code, "NOT_FOUND");
    assert.ok(missingBody.meta.timestamp, `missing meta.timestamp for ${path}`);
  }

  // /api 之下的未註冊路徑仍由 dispatcher 回 401，不可洩露 API 是否存在。
  const unregisteredApi = await fetch(`${url}/api/v1/not-registered`);
  assert.equal(unregisteredApi.status, 401);
  assert.equal((await unregisteredApi.json()).error.code, "Unauthorized Access");

  const result = await application.shutdown("test_complete");
  assert.equal(application.state, "stopped");
  assert.equal(result.exitCode, 0);
  assert.equal(result.httpServerClosed, true);
  assert.equal(result.servicesClosed, true);
  assert.equal(pool.calls.end, 1);
  assert.ok(
    logger.entries.some((entry) => entry.event === "configuration.validated")
  );
  assert.ok(
    logger.entries.some((entry) => entry.event === "application.factory.created")
  );
  assert.ok(
    logger.entries.some(
      (entry) =>
        entry.event === "handler.registered" &&
        entry.context.handler === "healthCheck"
    )
  );
  assert.ok(
    logger.entries.some(
      (entry) =>
        entry.event === "auth.strategy.registered" &&
        entry.context.authType === "jwt"
    )
  );
});

test("responses that short-circuit the request still carry CORS headers", async (t) => {
  const source = defaultConfigurationSource();
  const allowedOrigin = "http://localhost:5173";
  const application = await createApplication({
    configurationSource: {
      ...source,
      application: { ...source.application, port: 0, shutdownTimeoutMs: 1000 },
      // 一個窗口只允許一次請求，第二次必定被限流。
      requestLimiter: {
        ...source.requestLimiter,
        maxRequestsPerIpPerWindow: 1,
        ipWindowMs: 60000
      }
    },
    logger: memoryLogger(),
    requestLogger: testRequestLogger(),
    serviceOptions: {
      mysqldatabase: fakeDatabaseOptions()
    },
    forceExit: () => {
      throw new Error("Factory test must not force exit");
    }
  });
  t.after(() => application.shutdown("test_cleanup"));

  const { url } = await application.start();
  const headers = { Origin: allowedOrigin };
  const allowed = await fetch(`${url}/api/v1/health`, { headers });
  const limited = await fetch(`${url}/api/v1/health`, { headers });

  assert.equal(allowed.status, 200);
  assert.equal(
    allowed.headers.get("access-control-allow-origin"),
    allowedOrigin
  );

  // 沒有這個標頭，瀏覽器只會給前端一個沒有細節的 network error，
  // 讀不到 429 也讀不到 Retry-After，無法實作退避。
  assert.equal(limited.status, 429);
  assert.equal(
    limited.headers.get("access-control-allow-origin"),
    allowedOrigin,
    "rate-limited responses must be readable by the browser"
  );
  assert.ok(limited.headers.get("retry-after"));
});

test("the application factory does not itself require the scheduler", async (t) => {
  const source = defaultConfigurationSource();
  const logger = memoryLogger();
  // 這裡驗的是 Factory 自己不硬性依賴排程器——它只負責生命週期的先後，不碰
  // 工作。停用排程器時整個應用能不能啟動是另一回事：宣告了它的 service（例如
  // job.logRetention）會照統一規則在啟動時失敗，那是刻意的。
  const application = await createApplication({
    configurationSource: {
      ...source,
      application: { ...source.application, port: 0, shutdownTimeoutMs: 1000 }
    },
    logger,
    requestLogger: testRequestLogger(),
    serviceDiscoveryOptions: {
      moduleUrls: [
        new URL("../src/services/logging/LoggingService.js", import.meta.url).href,
        new URL("../src/services/time/SystemTimeService.js", import.meta.url).href,
        new URL("../src/services/context/RequestContextService.js", import.meta.url).href,
        new URL("../src/services/filetype/FileTypeService.js", import.meta.url).href,
        new URL("../src/services/auth/JwtService.js", import.meta.url).href,
        new URL("../src/services/auth/jwtAuthStrategy.js", import.meta.url).href,
        new URL("../src/services/auth/publicAuthStrategy.js", import.meta.url).href,
        new URL("../src/services/mysqldatabase/MySqlDatabaseService.js", import.meta.url).href,
        // auth.jwt 現在宣告 tokenRevocation，所以這份清單也要帶上它。
        new URL("../src/services/tokenRevocation/TokenRevocationService.js", import.meta.url).href
      ]
    },
    serviceOptions: {
      mysqldatabase: fakeDatabaseOptions()
    }
  });
  t.after(() => application.shutdown("test_cleanup"));

  const { url } = await application.start();
  const response = await fetch(`${url}/api/v1/health`);

  assert.equal(response.status, 200);
  assert.equal(application.scheduler, null);

  const result = await application.shutdown("test_complete");
  assert.equal(result.exitCode, 0);
  assert.equal(result.schedulerDrained, true);
});

test("business handlers and auth strategies are auto-discovered from implementations", async (t) => {
  let strategyInstances = 0;
  let strategyCloseCalls = 0;
  let businessServiceInstances = 0;
  let businessServiceShutdowns = 0;
  let requestServiceInstances = 0;
  let requestServiceShutdowns = 0;

  class ExampleBusinessService {
    static service = {
      name: "example",
      lifecycle: "singleton",
      dependencies: ["mysqldatabase"]
    };

    constructor({ services }) {
      this.mysqlDatabase = services.require("mysqldatabase");
      this.value = "auto-discovered";
      businessServiceInstances += 1;
    }

    async shutdown() {
      businessServiceShutdowns += 1;
    }
  }

  class RequestBusinessService {
    static service = {
      name: "requestExample",
      lifecycle: "request",
      dependencies: []
    };

    constructor() {
      this.instanceNumber = ++requestServiceInstances;
    }

    async shutdown() {
      requestServiceShutdowns += 1;
    }
  }

  class EchoBusinessHandler extends BaseRequestHandler {
    static handlerName = "echoBusiness";

    static api = {
      method: "GET",
      path: "/api/v1/echo",
      description: "Exercise the zero-registry business API workflow.",
      authType: "apiKey",
      authorizationPolicies: [{ name: "allowAll", options: {} }],
      requestSchema: {
        query: {
          type: "object",
          required: ["message"],
          additionalProperties: false,
          properties: { message: { type: "string", minLength: 1 } }
        }
      },
      responseSchema: {
        200: {
          type: "object",
          required: [
            "message",
            "serviceValue",
            "databaseAvailable",
            "requestInstance"
          ],
          additionalProperties: false,
          properties: {
            message: { type: "string" },
            serviceValue: { type: "string" },
            databaseAvailable: { type: "boolean" },
            requestInstance: { type: "integer" }
          }
        }
      }
    };

    async execute(req) {
      const requestService = await this.services.resolve("requestExample");

      return {
        message: req.input.query.message,
        serviceValue: this.services.require("example").value,
        databaseAvailable: typeof this.mysqlDatabase.query === "function",
        requestInstance: requestService.instanceNumber
      };
    }
  }

  class ApiKeyAuthStrategy extends BaseAuthStrategy {
    static authType = "apiKey";
    // 策略就是 service：同一套 discovery、同一套依賴注入、同一套生命週期。
    static service = {
      name: "auth.apiKey",
      lifecycle: "singleton",
      // logging 是 BaseAuthStrategy 用的，自訂策略同樣要宣告。
      dependencies: ["logging", "acceptedApiKey"],
      eager: true
    };

    constructor(context) {
      super(context);
      strategyInstances += 1;
    }

    async authenticate(req) {
      if (
        req.get("x-api-key") !==
        this.services.require("acceptedApiKey")
      ) {
        throw new AuthenticationError("API_KEY_INVALID", "API key is invalid");
      }

      return { type: this.authType, clientId: "integration-test" };
    }

    async shutdown() {
      strategyCloseCalls += 1;
    }
  }

  const source = defaultConfigurationSource();
  const logger = memoryLogger();
  const pool = fakeMySqlPool();
  const application = await createApplication({
    configurationSource: {
      ...source,
      application: { ...source.application, port: 0, shutdownTimeoutMs: 1000 }
    },
    handlerRegistryOptions: {
      moduleUrls: ["virtual:echoBusinessHandler"],
      moduleLoader: async () => ({ EchoBusinessHandler })
    },
    serviceDiscoveryOptions: {
      additionalModuleUrls: [
        "virtual:exampleBusinessService",
        "virtual:requestBusinessService",
        "virtual:apiKeyAuthStrategy"
      ],
      moduleLoader: async (url) => {
        if (url === "virtual:exampleBusinessService") {
          return { ExampleBusinessService };
        }

        if (url === "virtual:requestBusinessService") {
          return { RequestBusinessService };
        }

        if (url === "virtual:apiKeyAuthStrategy") {
          return { ApiKeyAuthStrategy };
        }

        return import(url);
      }
    },
    serviceValues: { acceptedApiKey: "test-api-key" },
    logger,
    requestLogger: testRequestLogger(),
    serviceOptions: { mysqldatabase: { pool } },
    forceExit: () => {
      throw new Error("Business API test must not force exit");
    }
  });
  t.after(() => application.shutdown("test_cleanup"));

  const { url } = await application.start();
  assert.equal(strategyInstances, 1);
  assert.equal(businessServiceInstances, 1);
  assert.equal(
    application.services.require("example").mysqlDatabase,
    application.services.require("mysqldatabase")
  );
  const denied = await fetch(`${url}/api/v1/echo?message=hello`);
  assert.equal(denied.status, 401);

  const response = await fetch(`${url}/api/v1/echo?message=hello`, {
    headers: { "X-API-Key": "test-api-key" }
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.data, {
    message: "hello",
    serviceValue: "auto-discovered",
    databaseAvailable: true,
    requestInstance: 1
  });
  const secondResponse = await fetch(`${url}/api/v1/echo?message=again`, {
    headers: { "X-API-Key": "test-api-key" }
  });
  assert.equal(secondResponse.status, 200);
  assert.equal((await secondResponse.json()).data.requestInstance, 2);
  assert.ok(
    logger.entries.some(
      (entry) =>
        entry.event === "handler.registered" &&
        entry.context.handler === "echoBusiness"
    )
  );
  assert.ok(
    logger.entries.some(
      (entry) =>
        entry.event === "auth.strategy.registered" &&
        entry.context.authType === "apiKey"
    )
  );
  const shutdown = await application.shutdown("test_complete");
  // 策略隨容器一起關閉，因此計入 servicesClosed 而非獨立欄位。
  assert.equal(shutdown.servicesClosed, true);
  assert.equal(strategyCloseCalls, 1);
  assert.equal(businessServiceShutdowns, 1);
  assert.equal(requestServiceInstances, 2);
  assert.equal(requestServiceShutdowns, 2);
});

test("application creation fails and cleans up when an eager service cannot initialize", async () => {
  const source = defaultConfigurationSource();
  const logger = memoryLogger();
  let poolQueryCalls = 0;
  let poolEndCalls = 0;
  const connectionError = Object.assign(new Error("MySQL is unavailable"), {
    code: "ECONNREFUSED"
  });

  await assert.rejects(
    () =>
      createApplication({
        configurationSource: {
          ...source,
          application: { ...source.application, port: 0 }
        },
        logger,
        requestLogger: testRequestLogger(),
        serviceOptions: {
          mysqldatabase: {
            pool: {
              query: async () => {
                poolQueryCalls += 1;
                throw connectionError;
              },
              getConnection: async () => ({
                query: async () => {
                  poolQueryCalls += 1;
                  throw connectionError;
                },
                release: () => {},
                destroy: () => {}
              }),
              end: async () => {
                poolEndCalls += 1;
              }
            }
          }
        }
      }),
    (error) => {
      assert.equal(error.code, "DATABASE_OPERATION_FAILED");
      assert.equal(error.cause, connectionError);
      return true;
    }
  );

  assert.equal(poolQueryCalls, 1);
  assert.equal(poolEndCalls, 1);
  assert.ok(
    logger.entries.some(
      (entry) => entry.event === "database.connection.failed"
    )
  );
  assert.equal(
    logger.entries.some((entry) => entry.event === "application.factory.created"),
    false
  );
});
