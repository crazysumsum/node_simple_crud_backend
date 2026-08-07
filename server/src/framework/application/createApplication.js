import cors from "cors";
import express from "express";
import helmet from "helmet";
import { resolveApiDefinitions } from "../api/apiDefinitionResolver.js";
import { createHandlerRegistry } from "../api/handlerRegistry.js";
import { createAuthStrategyRegistry } from "../auth/authStrategyRegistry.js";
import { verifyAccessToken } from "../auth/jwtService.js";
import { createAuthorizationPolicyRegistry } from "../authorization/authorizationPolicyRegistry.js";
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
import { RequestLimiter } from "../middleware/requestLimiter.js";
import {
  createCorsOptions,
  createHttpsEnforcementMiddleware
} from "../security/securityMiddleware.js";
import { RequestValidator } from "../validation/requestValidator.js";
import { ResponseValidator } from "../validation/responseValidator.js";

function closeHttpServer(server, timeoutMs) {
  if (!server) {
    return Promise.resolve(true);
  }

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
      server.closeAllConnections?.();
      finish(false);
    }, timeoutMs);

    server.close((error) => finish(!error));
    server.closeIdleConnections?.();
  });
}

function closeRequestLimiter(requestLimiter, timeoutMs) {
  if (!requestLimiter?.close) {
    return Promise.resolve(true);
  }

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
    const timeout = setTimeout(() => finish(false), timeoutMs);

    Promise.resolve(requestLimiter.close()).then(
      () => finish(true),
      () => finish(false)
    );
  });
}

function closeIdempotencyManager(manager, timeoutMs) {
  if (!manager?.close) {
    return Promise.resolve(true);
  }

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
    const timeout = setTimeout(() => finish(false), timeoutMs);

    Promise.resolve(manager.close()).then(
      () => finish(true),
      () => finish(false)
    );
  });
}

function closeAuthStrategies(strategies, timeoutMs) {
  if (!strategies?.close) {
    return Promise.resolve(true);
  }

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
    const timeout = setTimeout(() => finish(false), timeoutMs);

    Promise.resolve().then(() => strategies.close()).then(
      () => finish(true),
      () => finish(false)
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
      console.error(`Graceful shutdown exceeded ${timeoutMs}ms`);
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
    const rateLimitStoreClosed = await closeRequestLimiter(
      this.requestLimiter,
      remainingTime()
    );
    const idempotencyStoreClosed = await closeIdempotencyManager(
      this.idempotencyManager,
      remainingTime()
    );
    const authStrategiesClosed = await closeAuthStrategies(
      this.authStrategies,
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
        authStrategiesClosed,
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
      !authStrategiesClosed ||
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
      authStrategiesClosed,
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
  environmentSecret = process.env.JWT_SECRET,
  routes,
  handlers,
  handlerServices,
  handlerRegistryOptions,
  strategies,
  authStrategyServices,
  authStrategyRegistryOptions,
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
    environment,
    environmentSecret
  });
  const customValues = mergeServiceValues(
    handlerServices,
    authStrategyServices,
    serviceValues
  );
  const values = {
    jwtConfig: configuration.jwt,
    verifyToken: (token) => verifyAccessToken(token, { config: configuration.jwt }),
    ...customValues
  };
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
  let activeStrategies = strategies;

  try {
    await activeLogger.info(
      "service.registration.completed",
      "Service discovery and initialization completed",
      {
        serviceCount: services.describe().length,
        services: services.describe()
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
    activeStrategies =
      activeStrategies ||
      (await createAuthStrategyRegistry({
        ...authStrategyRegistryOptions,
        services
      }));
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
      defaultRequestTimeoutMs: configuration.application.requestTimeoutMs
    });
    const app = express();
    const { security } = configuration;

    app.set("trust proxy", security.reverseProxy.trustProxy);

    if (security.hidePoweredBy) {
      app.disable("x-powered-by");
    }

    app.use(activeRequestLogger);
    app.use(context.createMiddleware());

    if (security.helmetEnabled) {
      app.use(helmet());
    }

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
    app.use(cors(createCorsOptions(security)));
    app.use(express.json({ limit: security.jsonBodyLimit }));
    app.use(apiDispatcher);
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
          "httpsEnforcement",
          "requestLimiter",
          "requestServiceScope",
          "cors",
          "jsonParser",
          "apiDispatcher",
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
    await closeAuthStrategies(
      activeStrategies,
      configuration.application.shutdownTimeoutMs
    );
    await services.shutdown({
      timeoutMs: configuration.application.shutdownTimeoutMs
    });
    throw error;
  }
}
