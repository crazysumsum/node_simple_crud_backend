import assert from "node:assert/strict";
import test from "node:test";
import { BaseRequestHandler } from "../src/framework/api/BaseRequestHandler.js";
import { createApplication } from "../src/framework/application/createApplication.js";
import {
  defaultConfigurationSource,
  validateApplicationConfiguration
} from "../src/framework/configuration/applicationConfiguration.js";
import { fakeDatabaseOptions } from "../test-support/fakeMySqlPool.js";

// 限流器抽成 service 之後，框架就不該再依賴它。這裡釘住那條界線：框架用
// get() 取限流器，停用之後應用照常啟動；而宣告了依賴的 job 照常啟動失敗——
// 那是 job 的宣告在生效，不是框架在要求。

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

const requestLogger = (_req, _res, next) => next();
requestLogger.flush = async () => {};

class PingHandler extends BaseRequestHandler {
  static handlerName = "ping";

  static api = {
    method: "GET",
    path: "/api/v1/ping",
    description: "Minimal public route for limiter presence checks.",
    authType: "public",
    authorizationPolicies: [{ name: "allowAll", options: {} }],
    requestSchema: {
      query: { type: "object", additionalProperties: false, properties: {} }
    },
    responseSchema: {
      200: {
        type: "object",
        required: ["ok"],
        additionalProperties: false,
        properties: { ok: { type: "boolean" } }
      }
    }
  };

  async execute() {
    return { ok: true };
  }
}

/**
 * 把指定 service 的 static service.enabled 改成 false。
 *
 * 真實的停用是改原始碼裡的 static 欄位，測試不能那樣做，所以在 moduleLoader
 * 這一層攔截並換成一個 enabled: false 的子類別——discovery 看到的東西與真的
 * 被停用完全一樣。
 */
function disableServices(disabledClassNames) {
  return {
    moduleLoader: async (url) => {
      const module = await import(url);
      const patched = {};

      for (const [exportName, value] of Object.entries(module)) {
        if (
          typeof value === "function" &&
          Object.hasOwn(value, "service") &&
          disabledClassNames.includes(value.name)
        ) {
          patched[exportName] = class extends value {
            static service = Object.freeze({ ...value.service, enabled: false });
          };
          continue;
        }

        patched[exportName] = value;
      }

      return patched;
    }
  };
}

function configurationSource() {
  const source = defaultConfigurationSource();

  return {
    ...source,
    application: { ...source.application, port: 0, shutdownTimeoutMs: 1000 },
    // 一個窗口只准一次請求：限流器若還在，第二次必定 429。
    requestLimiter: {
      ...source.requestLimiter,
      maxRequestsPerIpPerWindow: 1,
      ipWindowMs: 60000
    }
  };
}

const mysqlOptions = {
  mysqldatabase: fakeDatabaseOptions()
};

test("the application starts and serves requests with the limiter disabled", async (t) => {
  const logger = memoryLogger();
  const application = await createApplication({
    configurationSource: configurationSource(),
    handlerRegistryOptions: {
      moduleUrls: ["virtual:ping"],
      moduleLoader: async () => ({ PingHandler })
    },
    logger,
    requestLogger,
    serviceDiscoveryOptions: disableServices([
      "RequestLimiterService",
      "RateLimitPurgeJob"
    ]),
    serviceOptions: mysqlOptions,
    forceExit: () => {
      throw new Error("This test must not force exit");
    }
  });
  t.after(() => application.shutdown("test_cleanup"));

  const { url } = await application.start();

  // 設定寫的是「一個窗口只准一次」，兩次都成功只可能代表中間件根本不在。
  for (const attempt of [1, 2]) {
    const response = await fetch(`${url}/api/v1/ping`);
    assert.equal(response.status, 200, `attempt ${attempt}`);
    assert.deepEqual((await response.json()).data, { ok: true });
  }

  assert.equal(application.requestLimiter, null);

  const factoryLog = logger.entries.find(
    ({ event }) => event === "application.factory.created"
  );
  assert.equal(factoryLog.context.middleware.includes("requestLimiter"), false);
  assert.equal(factoryLog.context.serviceNames.includes("requestLimiter"), false);

  // 沒有限流是安全姿態的改變，不能只躺在 disabledServices 那份清單裡。
  const warning = logger.entries.find(
    ({ event }) => event === "request.limit.disabled"
  );
  assert.equal(warning.level, "warn");

  const registration = logger.entries.find(
    ({ event }) => event === "service.registration.completed"
  );
  assert.deepEqual(
    registration.context.disabledServices.map(({ name }) => name).sort(),
    ["job.rateLimitPurge", "requestLimiter"]
  );
});

test("graceful shutdown stays clean when there is no limiter to drain", async () => {
  const application = await createApplication({
    configurationSource: configurationSource(),
    handlerRegistryOptions: {
      moduleUrls: ["virtual:ping"],
      moduleLoader: async () => ({ PingHandler })
    },
    logger: memoryLogger(),
    requestLogger,
    serviceDiscoveryOptions: disableServices([
      "RequestLimiterService",
      "RateLimitPurgeJob"
    ]),
    serviceOptions: mysqlOptions,
    forceExit: () => {
      throw new Error("This test must not force exit");
    }
  });
  await application.start();

  const result = await application.shutdown("test_complete");

  assert.equal(result.rejectedQueuedRequests, 0);
  // 限流器自己的排空不在了，但 closeHttpServer() 仍然等在途連線結束。
  assert.equal(result.activeRequestsDrained, true);
  assert.equal(result.httpServerClosed, true);
  assert.equal(result.servicesClosed, true);
  assert.equal(result.exitCode, 0);
});

test("a job that declares the limiter still fails startup when it is disabled", async () => {
  await assert.rejects(
    () =>
      createApplication({
        configurationSource: configurationSource(),
        handlerRegistryOptions: {
          moduleUrls: ["virtual:ping"],
          moduleLoader: async () => ({ PingHandler })
        },
        logger: memoryLogger(),
        requestLogger,
        // 只停用限流器，purge job 仍然啟用。
        serviceDiscoveryOptions: disableServices(["RequestLimiterService"]),
        serviceOptions: mysqlOptions
      }),
    (error) => {
      // 依賴宣告是 job 的，不是框架的——訊息要指名是誰在要求。
      assert.match(error.message, /^Service "job\.rateLimitPurge" requires "requestLimiter"/);
      assert.match(error.message, /disabled by its static service\.enabled flag/);
      return true;
    }
  );
});

test("a leftover enabled key in the limiter config is rejected", () => {
  const source = defaultConfigurationSource();

  assert.throws(
    () =>
      validateApplicationConfiguration({
        ...source,
        requestLimiter: { ...source.requestLimiter, enabled: false }
      }),
    (error) => {
      const [detail] = error.details;
      // 靜默接受的話，升級後忘了刪的部署會拿到全額限流——與作者的意圖相反。
      assert.equal(detail.section, "requestLimiter");
      assert.match(detail.message, /"enabled" was removed/);
      return true;
    }
  );
});
