import cors from "cors";
import express from "express";
import helmet from "helmet";
import { resolveApiDefinitions } from "../api/apiDefinitionResolver.js";
import { createHandlerRegistry } from "../api/handlerRegistry.js";
import { createAuthStrategyRegistry } from "../auth/authStrategyRegistry.js";
import { createAuthorizationPolicyRegistry } from "../authorization/authorizationPolicyRegistry.js";
import { reportInternalFailure } from "../diagnostics/reportInternalFailure.js";
import {
  defaultConfigurationSource,
  validateApplicationConfiguration
} from "../configuration/applicationConfiguration.js";
import { IdempotencyManager } from "../idempotency/IdempotencyManager.js";
import { MemoryIdempotencyStore } from "../idempotency/IdempotencyStore.js";
import { createServiceContainer } from "../services/createServiceContainer.js";
import { createRequestServiceScopeMiddleware } from "../services/requestServiceScope.js";
import {
  createApiDispatcher,
  validateApiConfig
} from "../middleware/apiDispatcher.js";
import { createErrorHandler } from "../middleware/errorHandler.js";
import { sendError } from "../http/apiResponse.js";
import { RequestLimiter } from "../middleware/requestLimiter.js";
import {
  createCorsOptions,
  createHttpsEnforcementMiddleware,
  createProxyHeaderCheckMiddleware
} from "../security/securityMiddleware.js";
import { RequestValidator } from "../validation/requestValidator.js";
import { ResponseValidator } from "../validation/responseValidator.js";

/**
 * 執行一個關閉動作，並在逾時後放棄等待。
 *
 * 關閉流程的三種資源（HTTP server、限流器、idempotency store）先前各自複製了
 * 同一段 promise 骨架：只結算一次、清掉計時器、成功回 true、失敗或逾時回 false。
 * 差異只在「怎麼關」與「逾時要不要額外動作」，所以那兩點交給呼叫端。
 *
 * close 收到 finish(closedGracefully)，可同步或非同步呼叫；重複呼叫會被忽略。
 */
function closeWithTimeout(close, timeoutMs, { onTimeout } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (closedGracefully) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      resolve(closedGracefully);
    };
    const timeout = setTimeout(() => {
      onTimeout?.();
      finish(false);
    }, timeoutMs);

    close(finish);
  });
}

/**
 * HTTP server 用 callback 式關閉，且要主動排空閒置連線；逾時則強制切斷所有
 * 剩餘連線，否則 keep-alive 會讓 close() 永遠等不到。
 */
function closeHttpServer(server, timeoutMs) {
  if (!server) {
    return Promise.resolve(true);
  }

  return closeWithTimeout(
    (finish) => {
      server.close((error) => finish(!error));
      server.closeIdleConnections?.();
    },
    timeoutMs,
    { onTimeout: () => server.closeAllConnections?.() }
  );
}

/** 任何提供 close() 的資源，例如限流 store 與 idempotency store。 */
function closeResource(resource, timeoutMs) {
  if (!resource?.close) {
    return Promise.resolve(true);
  }

  return closeWithTimeout(
    (finish) =>
      Promise.resolve(resource.close()).then(
        () => finish(true),
        () => finish(false)
      ),
    timeoutMs
  );
}

class Application {
  constructor({
    app,
    configuration,
    services,
    logger,
    loggerRegistry,
    requestLogger,
    requestLimiter,
    authStrategies,
    idempotencyManager,
    time,
    forceExit
  }) {
    this.app = app;
    this.configuration = configuration;
    this.services = services;
    this.logger = logger;
    this.loggers = loggerRegistry;
    this.requestLogger = requestLogger;
    this.requestLimiter = requestLimiter;
    this.authStrategies = authStrategies;
    this.idempotencyManager = idempotencyManager;
    this.time = time;
    this.forceExit = forceExit;
    this.server = null;
    this.state = "created";
    this.shutdownPromise = null;
  }

  async start() {
    if (this.state !== "created") {
      throw new Error(`Application cannot start while state is ${this.state}`);
    }

    this.state = "starting";
    const startupTime = this.time.timestamp();
    const { application } = this.configuration;

    await this.logger.info("application.starting", "API application is starting", {
      startupTime,
      nodeVersion: process.version,
      environment: process.env.NODE_ENV || "development"
    });

    if (this.state !== "starting") {
      throw new Error("Application startup was cancelled");
    }

    this.server = await new Promise((resolve, reject) => {
      const server = this.app.listen(application.port, application.host, () => {
        resolve(server);
      });
      server.once("error", reject);
    });
    this.state = "started";

    const address = this.server.address();
    const activePort = typeof address === "object" ? address.port : application.port;
    const url = `http://${application.host}:${activePort}`;

    await this.logger.info("application.started", "API application started", {
      startupTime,
      startedTime: this.time.timestamp(),
      url
    });

    return Object.freeze({ server: this.server, url });
  }

  shutdown(reason, requestedExitCode = 0) {
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }

    this.shutdownPromise = this.performShutdown(reason, requestedExitCode);
    return this.shutdownPromise;
  }

  async performShutdown(reason, requestedExitCode) {
    this.state = "shutting_down";
    const timeoutMs = this.configuration.application.shutdownTimeoutMs;
    const shutdownStartedAt = this.time.timestamp();
    const deadline = this.time.nowMs() + timeoutMs;
    const remainingTime = () => Math.max(1, deadline - this.time.nowMs());
    const forcedExit = setTimeout(() => {
      // 強制結束時 logger 可能已經在關閉流程中，非同步寫入不保證落得了盤，
      // 所以走同步的 stderr——這是關機逾時唯一保證留得下的記錄。
      reportInternalFailure("application.shutdown.forced", null, {
        reason,
        timeoutMs
      });
      this.forceExit(1);
    }, timeoutMs);

    const shutdownLog = this.logger.info(
      "application.shutdown.initiated",
      "Graceful shutdown initiated",
      { reason, shutdownStartedAt, timeoutMs }
    );

    const rejectedQueuedRequests = this.requestLimiter.shutdown();
    const activeRequestsDrainedPromise = this.requestLimiter.waitForIdle(
      remainingTime()
    );
    const httpServerClosedPromise = closeHttpServer(
      this.server,
      remainingTime()
    );

    await shutdownLog;
    const [activeRequestsDrained, httpServerClosed] = await Promise.all([
      activeRequestsDrainedPromise,
      httpServerClosedPromise
    ]);
    const rateLimitStoreClosed = await closeResource(
      this.requestLimiter,
      remainingTime()
    );
    const idempotencyStoreClosed = await closeResource(
      this.idempotencyManager,
      remainingTime()
    );
    const serviceShutdown = await this.services.shutdown({
      exclude: ["logging"],
      timeoutMs: remainingTime()
    });

    await this.logger.info(
      "application.shutdown.completed",
      "Graceful shutdown completed",
      {
        reason,
        shutdownStartedAt,
        shutdownCompletedAt: this.time.timestamp(),
        rejectedQueuedRequests,
        activeRequestsDrained,
        httpServerClosed,
        rateLimitStoreClosed,
        idempotencyStoreClosed,
        servicesClosed: serviceShutdown.closed,
        serviceFailures: serviceShutdown.failures.map(({ name }) => name)
      }
    );
    const loggingShutdown = await this.services.shutdown({
      timeoutMs: remainingTime()
    });
    clearTimeout(forcedExit);

    this.server = null;
    this.state = "stopped";
    const exitCode =
      requestedExitCode ||
      !activeRequestsDrained ||
      !httpServerClosed ||
      !rateLimitStoreClosed ||
      !idempotencyStoreClosed ||
      !serviceShutdown.closed ||
      !loggingShutdown.closed
        ? 1
        : 0;

    return Object.freeze({
      reason,
      exitCode,
      rejectedQueuedRequests,
      activeRequestsDrained,
      httpServerClosed,
      rateLimitStoreClosed,
      idempotencyStoreClosed,
      servicesClosed: serviceShutdown.closed && loggingShutdown.closed
    });
  }
}

function mergeServiceValues(...sources) {
  const values = {};

  for (const source of sources) {
    if (source === undefined) {
      continue;
    }

    if (!source || typeof source !== "object" || Array.isArray(source)) {
      throw new TypeError("Injected service values must be an object");
    }

    for (const [name, value] of Object.entries(source)) {
      if (Object.hasOwn(values, name)) {
        throw new Error(`Duplicate injected service value: ${name}`);
      }

      values[name] = value;
    }
  }

  return values;
}

export async function createApplication({
  configurationSource = defaultConfigurationSource(),
  environment = process.env.NODE_ENV || "development",
  routes,
  handlers,
  handlerServices,
  handlerRegistryOptions,
  strategies,
  authorizationPolicies,
  validator,
  responseValidator,
  logger,
  loggerRegistry,
  requestLogger,
  requestLimiter,
  rateLimitStore,
  idempotencyManager,
  idempotencyStore,
  serviceDiscoveryOptions,
  serviceOverrides,
  serviceFactories,
  serviceOptions,
  serviceValues,
  forceExit = (code) => process.exit(code)
} = {}) {
  const configuration = validateApplicationConfiguration(configurationSource, {
    environment
  });
  const customValues = mergeServiceValues(
    handlerServices,
      serviceValues
  );
  const values = { ...customValues };
  const overrides = { ...(serviceOverrides || {}) };
  const factories = { ...(serviceFactories || {}) };

  const services = await createServiceContainer({
    config: configuration,
    overrides,
    factories,
    values,
    options: {
      ...(serviceOptions || {}),
      logging: {
        ...(serviceOptions?.logging || {}),
        logger,
        loggerRegistry,
        requestLogger
      }
    },
    discoveryOptions: serviceDiscoveryOptions
  });
  const logging = services.require("logging");
  const activeLogger = logging.logger;
  const activeLoggerRegistry = logging.loggers;
  const activeRequestLogger = logging.requestMiddleware;
  const context = services.require("context");
  const time = services.require("time");
  const fileTypes = services.require("filetypes");
  let activeStrategies = strategies;

  try {
    await activeLogger.info(
      "service.registration.completed",
      "Service discovery and initialization completed",
      {
        serviceCount: services.describe().length,
        services: services.describe(),
        // 被停用的 service 不會出現在上面那份清單裡。不把它們列出來，
        // 「這個 service 為什麼不見了」就只能靠翻原始碼。
        disabledServices: services.describeDisabled()
      }
    );

    const activeValidator =
      validator ||
      new RequestValidator({ config: configuration.request.validation.input });
    const activeResponseValidator =
      responseValidator ||
      new ResponseValidator({
        config: configuration.request.validation.output,
        environment
      });

    if (
      !requestLimiter &&
      !rateLimitStore &&
      configuration.request.limits.storeAdapter !== "memory"
    ) {
      throw new Error(
        `RateLimitStore adapter must be injected for ${configuration.request.limits.storeAdapter}`
      );
    }

    const activeRequestLimiter =
      requestLimiter ||
      new RequestLimiter({
        config: configuration.request.limits,
        logger: activeLogger,
        time,
        store: rateLimitStore
      });

    if (
      !idempotencyManager &&
      !idempotencyStore &&
      configuration.api.idempotency.storeAdapter !== "memory"
    ) {
      throw new Error(
        `IdempotencyStore adapter must be injected for ${configuration.api.idempotency.storeAdapter}`
      );
    }

    const activeIdempotencyManager =
      idempotencyManager ||
      new IdempotencyManager({
        config: configuration.api.idempotency,
        store:
          idempotencyStore ||
          new MemoryIdempotencyStore({
            maxEntries: configuration.api.idempotency.memoryMaxEntries
        }),
        logger: activeLogger,
        context
      });
    // 策略是一般的 service，已經由 container 建立完成；這裡只是依 authType
    // 建立索引，不再掃描目錄，也不接管它們的生命週期。
    activeStrategies =
      activeStrategies ||
      createAuthStrategyRegistry({ services, logger: activeLogger });
    const activeAuthorizationPolicies =
      authorizationPolicies || createAuthorizationPolicyRegistry();
    const activeHandlers =
      handlers ||
      (await createHandlerRegistry({
        ...handlerRegistryOptions,
        services
      }));
    const activeRoutes =
      routes === undefined
        ? resolveApiDefinitions(activeHandlers, configuration.api.defaults)
        : routes;

    validateApiConfig(
      activeRoutes,
      activeHandlers,
      activeStrategies,
      configuration.application.requestTimeoutMs,
      activeAuthorizationPolicies,
      configuration.api.versioning,
      activeIdempotencyManager
    );

    const apiDispatcher = createApiDispatcher({
      routes: activeRoutes,
      handlers: activeHandlers,
      strategies: activeStrategies,
      authorizationPolicies: activeAuthorizationPolicies,
      versioning: configuration.api.versioning,
      idempotencyManager: activeIdempotencyManager,
      validator: activeValidator,
      responseValidator: activeResponseValidator,
      context,
      logger: activeLogger,
      time,
      fileTypes,
      defaultRequestTimeoutMs: configuration.application.requestTimeoutMs
    });
    const app = express();
    const { security } = configuration;

    app.set("trust proxy", security.reverseProxy.trustProxy);
    // Express 5 預設改用 Node 內建的 querystring，不再解析 filter[status]=open
    // 這類巢狀語法。明確指定 extended，讓 query 結構不隨 Express 版本而改變。
    app.set("query parser", "extended");

    if (security.hidePoweredBy) {
      app.disable("x-powered-by");
    }

    app.use(activeRequestLogger);
    app.use(context.createMiddleware());

    if (security.helmetEnabled) {
      app.use(helmet());
    }

    // CORS 必須排在會提前終止請求的中間件之前。放在後面時，429 與 426 這類
    // 回應不會帶 Access-Control-Allow-Origin，瀏覽器只會看到沒有細節的
    // network error，前端無法讀取狀態碼或 Retry-After 做退避處理。
    app.use(cors(createCorsOptions(security)));
    // 排在限流之前：限流本身就是這個設定錯誤的主要受害者，被擋下的請求也該
    // 有機會觸發這個警告。
    app.use(createProxyHeaderCheckMiddleware(security, activeLogger));
    app.use(createHttpsEnforcementMiddleware(security));
    app.use(activeRequestLimiter.middleware());
    app.use(
      createRequestServiceScopeMiddleware({
        services,
        context,
        logger: activeLogger,
        shutdownTimeoutMs: configuration.application.shutdownTimeoutMs
      })
    );
    app.use(express.json({ limit: security.jsonBodyLimit }));
    app.use(apiDispatcher);
    // apiDispatcher 已處理 /api 下的所有請求，走到這裡的都是框架不認識的路徑。
    // 若交給 Express 內建的 404，客戶端會收到 HTML，破壞統一 JSON 信封的契約。
    app.use((_req, res) => {
      sendError(res, {
        statusCode: 404,
        code: "NOT_FOUND",
        message: "Not found",
        time
      });
    });
    app.use(createErrorHandler({ logger: activeLogger, time }));

    void activeLogger.info(
      "configuration.validated",
      "All application configuration sections validated",
      {
        sections: Object.keys(configuration),
        host: configuration.application.host,
        port: configuration.application.port,
        requestTimeoutMs: configuration.application.requestTimeoutMs,
        shutdownTimeoutMs: configuration.application.shutdownTimeoutMs,
        responseValidationEnabled:
          configuration.request.validation.output.runtimeEnabled
      }
    );
    void activeLogger.info(
      "application.factory.created",
      "Application factory completed",
      {
        middleware: [
          "requestLogger",
          "requestContext",
          ...(security.helmetEnabled ? ["helmet"] : []),
          "cors",
          "proxyHeaderCheck",
          "httpsEnforcement",
          "requestLimiter",
          "requestServiceScope",
          "jsonParser",
          "apiDispatcher",
          "notFound",
          "errorHandler"
        ],
        serviceNames: services.names(),
        authTypes: activeStrategies.types(),
        authorizationPolicies: activeAuthorizationPolicies.names(),
        handlers: Object.keys(activeHandlers),
        loggers: activeLoggerRegistry.names(),
        idempotencyStoreAdapter: configuration.api.idempotency.storeAdapter
      }
    );

    return new Application({
      app,
      configuration,
      services,
      logger: activeLogger,
      loggerRegistry: activeLoggerRegistry,
      requestLogger: activeRequestLogger,
      requestLimiter: activeRequestLimiter,
      authStrategies: activeStrategies,
      idempotencyManager: activeIdempotencyManager,
      time,
      forceExit
    });
  } catch (error) {
    await services.shutdown({
      timeoutMs: configuration.application.shutdownTimeoutMs
    });
    throw error;
  }
}
