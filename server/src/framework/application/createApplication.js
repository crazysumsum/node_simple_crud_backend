import http from "node:http";
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
import { createServiceContainer } from "../services/createServiceContainer.js";
import { createRequestServiceScopeMiddleware } from "../services/requestServiceScope.js";
import { createApiDispatcher } from "../middleware/apiDispatcher.js";
import {
  bodyParsingComplete,
  createBodyReceiveTimeoutMiddleware
} from "../middleware/bodyReceiveTimeout.js";
import { createErrorHandler } from "../middleware/errorHandler.js";
import { sendError } from "../http/apiResponse.js";
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
 * 限流器與 idempotency 的 store 都已經是 service，由容器負責關閉，所以現在
 * 只剩 HTTP server 走這條路。骨架仍然留著：只結算一次、清掉計時器、成功回
 * true、失敗或逾時回 false，差異只在「怎麼關」與「逾時要不要額外動作」。
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

const BYTE_UNITS = Object.freeze({ b: 1, kb: 1024, mb: 1024 * 1024 });

/** "100kb" -> 102400。格式已由 normalizeSecurityConfig 驗證過。 */
function bytesFromLimit(limit) {
  const [, amount, unit] = /^(\d+)(b|kb|mb)$/.exec(String(limit)) ?? [];
  return amount ? Number(amount) * BYTE_UNITS[unit] : null;
}

/**
 * 把四個逾時換算成部署者真正關心的三件事：JSON 請求的最低速率要求、socket 層
 * 逾時的實際生效上界，以及一個請求最多能佔住限流槽位多久。
 */
function describeRequestBudget(application, jsonBodyLimit) {
  const jsonBodyLimitBytes = bytesFromLimit(jsonBodyLimit);
  const seconds = application.bodyReceiveTimeoutMs / 1000;

  return {
    jsonBodyLimit,
    bodyReceiveTimeoutMs: application.bodyReceiveTimeoutMs,
    // 低於這個速率的 JSON 請求會被看門狗切斷。
    minimumJsonBodyBytesPerSecond:
      jsonBodyLimitBytes === null ? null : Math.ceil(jsonBodyLimitBytes / seconds),
    // 設定值加上檢查間隔，才是連線真的會被切斷的最晚時間。
    effectiveHeadersTimeoutMs:
      application.headersReceiveTimeoutMs + application.connectionsCheckingIntervalMs,
    effectiveRequestReceiveTimeoutMs:
      application.requestReceiveTimeoutMs + application.connectionsCheckingIntervalMs,
    // 收取與處理是連續的兩段，一個請求佔住限流槽位的時間上界是兩段相加。
    maxSlotHoldMs:
      application.requestReceiveTimeoutMs +
      application.connectionsCheckingIntervalMs +
      application.requestTimeoutMs,
    // 這四個逾時全部守著「一條連線活多久」，沒有一個管「同時能有幾條」——
    // maxConnections 是唯一頂著這件事的設定，值得跟上面幾個放在同一份日誌裡。
    maxConnections: application.maxConnections
  };
}

/**
 * 監看目前的連線數，逼近 maxConnections 時記一筆警告。
 *
 * Node 對超過 server.maxConnections 的 socket 是直接 destroy，不會有任何事件
 * 或錯誤可以掛勾——這個計數是唯一能看見「快滿了」或「已經在拒絕新連線」的
 * 辦法。節流成每分鐘一則：滿載本身可能持續很久，重點是知道正在發生、以及
 * 這段期間見過的峰值，不是每一條新連線都留一筆。
 */
function watchConnectionCapacity(server, { maxConnections, logger, time }) {
  let activeConnections = 0;
  let peakSinceLastLog = 0;
  let lastLogAt = 0;

  server.on("connection", (socket) => {
    activeConnections += 1;
    peakSinceLastLog = Math.max(peakSinceLastLog, activeConnections);
    socket.once("close", () => {
      activeConnections = Math.max(0, activeConnections - 1);
    });

    if (activeConnections < maxConnections) {
      return;
    }

    const now = time.nowMs();

    if (now - lastLogAt < 60000) {
      return;
    }

    lastLogAt = now;
    const peak = peakSinceLastLog;
    peakSinceLastLog = activeConnections;

    void logger.warn(
      "http.connections_at_capacity",
      "HTTP connection count reached maxConnections; further connections are being dropped",
      { activeConnections, peakSinceLastLog: peak, maxConnections }
    );
  });
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
    idempotency,
    scheduler,
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
    this.idempotency = idempotency;
    this.scheduler = scheduler;
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

    // 自己建 server 而不是 app.listen()：這三個值只有在 createServer 的時候
    // 設得進去。實測 listen() 之後才指派 requestTimeout 完全無效——連線在跨過
    // 兩次檢查間隔、75 秒之後仍然活著。
    this.server = await new Promise((resolve, reject) => {
      const server = http.createServer(
        {
          requestTimeout: application.requestReceiveTimeoutMs,
          headersTimeout: application.headersReceiveTimeoutMs,
          connectionsCheckingInterval: application.connectionsCheckingIntervalMs
        },
        this.app
      );
      // 四個逾時管的是「一條連線能活多久」，這個管的是「同時能有幾條」——
      // 慢速攻擊在逾時到期前不斷開新連線頂替被切斷的那些，耗盡的是 fd，跟
      // 連線是否逾時無關。Node 在 accept() 之後、走到 requestTimeout 等任何
      // 邏輯之前就會直接關掉超過上限的 socket。
      server.maxConnections = application.maxConnections;
      watchConnectionCapacity(server, {
        maxConnections: application.maxConnections,
        logger: this.logger,
        time: this.time
      });
      server.listen(application.port, application.host, () => resolve(server));
      server.once("error", reject);
    });
    this.state = "started";
    // 背景工作在開始接受請求之後才排程，讓啟動失敗的路徑上不會有半跑的工作。
    await this.scheduler?.start();

    const address = this.server.address();
    const activePort = typeof address === "object" ? address.port : application.port;
    const url = `http://${application.host}:${activePort}`;

    await this.logger.info("application.started", "API application started", {
      startupTime,
      startedTime: this.time.timestamp(),
      url,
      // 這四個逾時的實際效果沒有人會自己算，而算錯的後果是安靜的：某一段沒有
      // 上限，或某個設定值從此是空話。所以啟動時把換算結果講出來。
      requestBudget: describeRequestBudget(
        application,
        this.configuration.security.jsonBodyLimit
      )
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

    // 限流器可以不存在。它不在的時候沒有佇列要拒絕，也沒有自己的在途計數——
    // closeHttpServer() 仍然會等在途連線結束，排空並沒有消失，只是換了機制。
    const rejectedQueuedRequests = this.requestLimiter?.stopAccepting() ?? 0;
    const activeRequestsDrainedPromise =
      this.requestLimiter?.waitForIdle(remainingTime()) ?? Promise.resolve(true);
    const httpServerClosedPromise = closeHttpServer(
      this.server,
      remainingTime()
    );
    // 排程器與 HTTP server 同屬「工作來源」，都必須在它們使用的 store 與
    // service 被拆掉之前停下來。放進 service 容器的反序關閉會太晚：排程器沒有
    // 宣告依賴，反而會是最後才關的那一個。
    const schedulerStoppedPromise = Promise.resolve(
      this.scheduler?.stop({ timeoutMs: remainingTime() }) ?? { drained: true }
    )
      .then(({ drained }) => drained)
      .catch(() => false);

    await shutdownLog;
    const [activeRequestsDrained, httpServerClosed, schedulerDrained] =
      await Promise.all([
        activeRequestsDrainedPromise,
        httpServerClosedPromise,
        schedulerStoppedPromise
      ]);
    // 限流器與 idempotency 的 store 都由容器關閉，失敗會出現在 serviceFailures
    // 裡。不再需要專屬的回報欄位。
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
        // 排空只等活著的請求。被放棄的 handler 依定義永遠不會回來，等它等於
        // 保證每次部署都燒滿 shutdownTimeoutMs 然後強制退出。這個數字是資訊，
        // 不是失敗——但它必須出現，否則沒有人知道這個實例漏了東西。
        abandonedRequests: this.requestLimiter?.abandonedRequests ?? 0,
        activeRequestsDrained,
        httpServerClosed,
        schedulerDrained,
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
      !schedulerDrained ||
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
      schedulerDrained,
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
  // 工作由各個 service 自己向排程器提交，所以這裡不碰 job，只負責生命週期的
  // 先後——與 HTTP server 同一類。用 get() 而非 require()：排程器被停用的部署
  // 不該因此無法啟動。
  const activeScheduler = services.get("scheduler") ?? null;
  // 限流器與排程器同一類：框架安排它的生命週期先後，但不要求它存在。用 get()
  // 而非 require()，停用限流器的部署不該因此無法啟動。eager 保證它已經建好。
  const activeRequestLimiter = services.get("requestLimiter") ?? null;
  // idempotency 同理。停用它本身不會擋住啟動，但任何仍宣告 idempotency 的
  // route 會在 validateApiConfig 讓啟動失敗。
  const activeIdempotency = services.get("idempotency") ?? null;
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

    if (!activeRequestLimiter) {
      // 沒有限流就沒有 429、沒有並行上限、沒有佇列。這是安全姿態的改變，不該
      // 只靠啟動日誌裡那份 disabledServices 清單被人翻到。
      void activeLogger.warn(
        "request.limit.disabled",
        "Request limiter service is disabled; no rate limiting is applied",
        { service: "requestLimiter" }
      );
    }

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

    // createApiDispatcher 自己會用同一批 routes/handlers/strategies 呼叫
    // validateApiConfig（見 apiDispatcher.js），不在這裡另外驗證一次——先前
    // 這裡的呼叫沒有帶 requestReceiveTimeoutMs，會退回模組載入時的靜態預設，
    // 跟下面實際餵給 dispatcher 的 configuration.application.requestReceiveTimeoutMs
    // 不一定是同一個值：兩者不同時，起手這一次可能用錯的（通常較低的）上限
    // 擋下一個其實合法的長逾時 route。
    const apiDispatcher = createApiDispatcher({
      routes: activeRoutes,
      handlers: activeHandlers,
      strategies: activeStrategies,
      authorizationPolicies: activeAuthorizationPolicies,
      versioning: configuration.api.versioning,
      idempotency: activeIdempotency,
      validator: activeValidator,
      responseValidator: activeResponseValidator,
      context,
      logger: activeLogger,
      time,
      fileTypes,
      apiUpload: configuration.api.upload,
      defaultRequestTimeoutMs: configuration.application.requestTimeoutMs,
      requestReceiveTimeoutMs: configuration.application.requestReceiveTimeoutMs
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

    if (activeRequestLimiter) {
      app.use(activeRequestLimiter.middleware());
    }

    app.use(
      createRequestServiceScopeMiddleware({
        services,
        context,
        logger: activeLogger,
        shutdownTimeoutMs: configuration.application.shutdownTimeoutMs
      })
    );
    // 排在 express.json() 之前：它守的正是「限流槽位已被佔住、body 還沒收完」
    // 那一段，而 express.json() 就是那一段唯一會阻塞的東西。
    app.use(
      createBodyReceiveTimeoutMiddleware({
        timeoutMs: configuration.application.bodyReceiveTimeoutMs,
        logger: activeLogger,
        time
      })
    );
    app.use(express.json({ limit: security.jsonBodyLimit }));
    // 解析階段結束，看門狗的任務完成。走到這裡 body 還在傳的只可能是 multipart，
    // 由 route 的 timeoutMs 接手——那個逾時是照著上傳大小訂的。
    app.use(bodyParsingComplete);
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
          ...(activeRequestLimiter ? ["requestLimiter"] : []),
          "requestServiceScope",
          "bodyReceiveTimeout",
          "jsonParser",
          "bodyParsingComplete",
          "apiDispatcher",
          "notFound",
          "errorHandler"
        ],
        serviceNames: services.names(),
        authTypes: activeStrategies.types(),
        authorizationPolicies: activeAuthorizationPolicies.names(),
        handlers: Object.keys(activeHandlers),
        loggers: activeLoggerRegistry.names(),
        idempotencyStoreAdapter: activeIdempotency?.config.storeAdapter ?? null
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
      idempotency: activeIdempotency,
      scheduler: activeScheduler,
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
