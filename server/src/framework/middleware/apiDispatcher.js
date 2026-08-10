import { Router } from "express";
import apiConfig from "../../../config/api.js";
import applicationConfig from "../../../config/application.js";
import { BaseRequestHandler } from "../api/BaseRequestHandler.js";
import { createAuthorizationPolicyRegistry } from "../authorization/authorizationPolicyRegistry.js";
import { sendError } from "../http/apiResponse.js";
import {
  markRequestProcessingCompleted,
  markRequestProcessingStarted
} from "../http/requestProcessingLifecycle.js";
import { IdempotencyManager } from "../idempotency/IdempotencyManager.js";
import { MemoryIdempotencyStore } from "../idempotency/IdempotencyStore.js";
import { normalizeIdempotencyConfig } from "../idempotency/normalizeIdempotencyConfig.js";
import { createRequestTimeoutMiddleware } from "./requestTimeout.js";
import { RequestValidator } from "../validation/requestValidator.js";
import { ResponseValidator } from "../validation/responseValidator.js";
import { normalizeApiVersioningConfig } from "../versioning/normalizeApiVersioningConfig.js";
import {
  createApiLifecycleMiddleware,
  normalizeApiLifecycle
} from "../versioning/apiLifecycle.js";

const HTTP_METHODS = new Set(["delete", "get", "patch", "post", "put"]);
// Express 5 移除了 :param? 與裸 * 兩種寫法。提早比對可換來清楚的設定錯誤訊息，
// 而不是等 path-to-regexp 在註冊 route 時丟出難以對應到 handler 的例外。
const LEGACY_PATH_SYNTAX = /:[A-Za-z0-9_]+\?|\*(?![A-Za-z_])/;
const BODY_CAPTURE_MODES = new Set(["none", "full"]);

// routes 也可以由呼叫端直接傳入，未必經過 apiDefinitionResolver 補上預設值。
// 這裡收斂成一個一定存在且合法的物件，requestLogger 才能安全讀取。
function normalizeRouteLogging(source, routeKey) {
  if (source === undefined || source === null) {
    return Object.freeze({ bodyCapture: "none" });
  }

  if (typeof source !== "object" || Array.isArray(source)) {
    throw new Error(`logging config must be an object for ${routeKey}`);
  }

  const bodyCapture = String(source.bodyCapture ?? "none").toLowerCase();

  if (!BODY_CAPTURE_MODES.has(bodyCapture)) {
    throw new Error(
      `logging.bodyCapture must be "none" or "full" for ${routeKey}`
    );
  }

  return Object.freeze({ bodyCapture });
}

export function validateApiConfig(
  routes,
  handlers,
  strategies,
  defaultRequestTimeoutMs,
  authorizationPolicies = createAuthorizationPolicyRegistry(),
  versioning = normalizeApiVersioningConfig(apiConfig.versioning),
  idempotencyManager
) {
  if (!Array.isArray(routes)) {
    throw new TypeError("API config must export an array");
  }

  const configuredRoutes = new Set();

  for (const route of routes) {
    const method = String(route.method || "").toLowerCase();
    const routeKey = `${method} ${route.path}`;

    if (!HTTP_METHODS.has(method)) {
      throw new Error(`Unsupported HTTP method in API config: ${route.method}`);
    }

    if (typeof route.path !== "string" || !route.path.startsWith("/api/")) {
      throw new Error(`API path must start with /api/: ${route.path}`);
    }

    const removedPathSyntax = LEGACY_PATH_SYNTAX.exec(route.path)?.[0];

    if (removedPathSyntax) {
      throw new Error(
        `API path uses route syntax removed in Express 5 ("${removedPathSyntax}") for ${routeKey}. Write optional segments as {/:name} and wildcards as *name.`
      );
    }

    if (typeof route.description !== "string" || !route.description.trim()) {
      throw new Error(`API description is required for ${routeKey}`);
    }

    if (
      route.requestSchema === null ||
      typeof route.requestSchema !== "object" ||
      Array.isArray(route.requestSchema)
    ) {
      throw new Error(`requestSchema is required for ${routeKey}`);
    }

    if (
      route.responseSchema === null ||
      typeof route.responseSchema !== "object" ||
      Array.isArray(route.responseSchema)
    ) {
      throw new Error(`responseSchema is required for ${routeKey}`);
    }

    if (!strategies.has(route.authType)) {
      throw new Error(`Unsupported authentication type for ${routeKey}: ${route.authType}`);
    }

    authorizationPolicies.normalize(route.authorizationPolicies, routeKey);

    if (
      route.deprecation === null ||
      typeof route.deprecation !== "object" ||
      Array.isArray(route.deprecation)
    ) {
      throw new Error(`deprecation config is required for ${routeKey}`);
    }

    normalizeApiLifecycle(route, versioning, routeKey);

    if (
      route.idempotency === null ||
      typeof route.idempotency !== "object" ||
      Array.isArray(route.idempotency)
    ) {
      throw new Error(`idempotency config is required for ${routeKey}`);
    }

    idempotencyManager?.routeOptions(route.idempotency, routeKey);
    normalizeRouteLogging(route.logging, routeKey);

    if (!(handlers[route.handler] instanceof BaseRequestHandler)) {
      throw new Error(`Handler not found for ${routeKey}: ${route.handler}`);
    }

    const timeoutMs = Number(route.timeoutMs ?? defaultRequestTimeoutMs);

    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error(`Request timeout must be a positive integer for ${routeKey}`);
    }

    if (configuredRoutes.has(routeKey)) {
      throw new Error(`Duplicate API config: ${routeKey}`);
    }

    configuredRoutes.add(routeKey);
  }
}

export function createApiDispatcher({
  routes,
  handlers,
  strategies,
  validator,
  responseValidator,
  authorizationPolicies,
  versioning,
  idempotencyManager,
  context,
  logger,
  time,
  defaultRequestTimeoutMs = Number(applicationConfig.requestTimeoutMs)
} = {}) {
  if (
    !strategies ||
    typeof strategies.has !== "function" ||
    typeof strategies.authenticate !== "function"
  ) {
    throw new TypeError("API dispatcher requires an authentication strategy registry");
  }

  const activeValidator = validator || new RequestValidator();
  const activeResponseValidator = responseValidator || new ResponseValidator();
  const activeAuthorizationPolicies =
    authorizationPolicies || createAuthorizationPolicyRegistry();
  const activeVersioning =
    versioning || normalizeApiVersioningConfig(apiConfig.versioning);
  const activeLogger = logger;

  if (
    !activeLogger ||
    ["info", "warn", "error"].some(
      (method) => typeof activeLogger[method] !== "function"
    )
  ) {
    throw new TypeError("API dispatcher requires a system logger");
  }

  if (!context || typeof context.update !== "function") {
    throw new TypeError("API dispatcher requires a request context service");
  }

  if (!time || typeof time.timestamp !== "function") {
    throw new TypeError("API dispatcher requires a time service");
  }

  const activeIdempotencyManager =
    idempotencyManager ||
    new IdempotencyManager({
      config: normalizeIdempotencyConfig(apiConfig.idempotency),
      store: new MemoryIdempotencyStore(),
      logger: activeLogger,
      context
    });

  validateApiConfig(
    routes,
    handlers,
    strategies,
    defaultRequestTimeoutMs,
    activeAuthorizationPolicies,
    activeVersioning,
    activeIdempotencyManager
  );

  const router = Router();
  const registeredApis = [];

  for (const route of routes) {
    const method = route.method.toLowerCase();
    const handler = handlers[route.handler];
    const routeKey = `${method} ${route.path}`;
    const timeoutMs = Number(route.timeoutMs ?? defaultRequestTimeoutMs);
    const lifecycle = normalizeApiLifecycle(route, activeVersioning, routeKey);
    const policies = activeAuthorizationPolicies.normalize(
      route.authorizationPolicies,
      routeKey
    );
    const idempotency = activeIdempotencyManager.routeOptions(
      route.idempotency,
      routeKey
    );
    const logging = normalizeRouteLogging(route.logging, routeKey);
    const validateRequest = activeValidator.compile(route.requestSchema, routeKey);
    const validateResponse = activeResponseValidator.compile(
      route.responseSchema,
      routeKey
    );
    const registeredApi = {
      method: route.method,
      path: route.path,
      description: route.description,
      authType: route.authType,
      authorizationPolicies: policies,
      handler: route.handler,
      version: lifecycle.version,
      deprecation: lifecycle,
      idempotency,
      logging,
      timeoutMs,
      requestSchemaLocations: Object.keys(route.requestSchema),
      responseStatusCodes: Object.keys(route.responseSchema)
    };

    registeredApis.push(registeredApi);

    void activeLogger.info("api.registered", "API route registered", registeredApi);

    router[method](
      route.path,
      (req, _res, next) => {
        req.apiRoute = registeredApi;
        req.validateResponse = validateResponse;
        context.update({ apiRoute: registeredApi });
        next();
      },
      createApiLifecycleMiddleware({
        lifecycle,
        config: activeVersioning,
        logger: activeLogger
      }),
      createRequestTimeoutMiddleware({
        timeoutMs,
        logger: activeLogger,
        context,
        time
      }),
      async (req, res, next) => {
        markRequestProcessingStarted(req);

        try {
          req.auth = await strategies.authenticate(route.authType, req);
          context.update({ auth: req.auth });
          await activeAuthorizationPolicies.authorize(
            policies,
            req,
            registeredApi
          );
          context.update({ authorizationPolicies: policies });
          validateRequest(req);
          await activeIdempotencyManager.execute(
            req,
            res,
            idempotency,
            () => handler.handle(req, res, next)
          );
        } catch (error) {
          if (req.requestTimeout?.signal?.aborted && res.writableEnded) {
            return;
          }

          next(error);
        } finally {
          markRequestProcessingCompleted(req);
        }
      }
    );
  }

  void activeLogger.info("api.registration.completed", "API registration completed", {
    registeredApiCount: registeredApis.length,
    registeredApis
  });

  router.use("/api", (req, res) => {
    void activeLogger.warn("api.not_registered", "Unregistered API request blocked", {
      requestId: req.requestId || null,
      method: req.method,
      url: req.originalUrl || req.url
    });

    sendError(res, {
      statusCode: 401,
      code: "Unauthorized Access",
      message: "Unauthorized Access",
      time
    });
  });

  return router;
}
