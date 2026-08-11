import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import express from "express";
import { BaseRequestHandler } from "../src/framework/api/BaseRequestHandler.js";
import {
  AuthenticationError,
  AuthStrategyRegistry,
  createAuthStrategyRegistry
} from "../src/framework/auth/authStrategyRegistry.js";
import jwtConfig from "../config/jwt.js";
import { createServiceContainer } from "../src/framework/services/createServiceContainer.js";
import { RequestContextService } from "../src/services/context/RequestContextService.js";
import {
  createApiDispatcher as createDispatcher,
  validateApiConfig
} from "../src/framework/middleware/apiDispatcher.js";
import { createErrorHandler } from "../src/framework/middleware/errorHandler.js";
import {
  createTestTime,
  servicesWithTime
} from "../test-support/createTestTime.js";

const silentLogger = {
  debug: async () => {},
  info: async () => {},
  warn: async () => {},
  error: async () => {}
};
const emptyRequestSchema = {};
const anySuccessResponseSchema = { 200: {} };
const time = createTestTime();
const requestContext = new RequestContextService({ services: servicesWithTime(time) });
// 策略現在是一般 service，所以測試也經由真實的 container 取得它們——
// 這條路徑與 Application Factory 完全相同。
// jwt 也是同一個目錄裡被發現的一般 service，不再由測試手動組裝。
const strategyContainer = await createServiceContainer({
  config: { jwt: jwtConfig },
  values: {
    // 策略宣告依賴 logging 以固定初始化順序，測試提供同形狀的替身。
    logging: { logger: silentLogger }
  },
  discoveryOptions: {
    servicesDirectory: new URL("../src/services/auth/", import.meta.url)
  },
  options: {}
});
const jwtService = strategyContainer.require("jwt");
const issueAccessToken = (payload, options) => jwtService.issue(payload, options);
const defaultAuthStrategies = createAuthStrategyRegistry({
  services: strategyContainer,
  logger: silentLogger
});
const apiRouteDefaults = {
  version: "v1",
  deprecation: {
    deprecated: false,
    deprecatedAt: null,
    sunsetAt: null,
    replacement: null
  },
  authorizationPolicies: [{ name: "allowAll", options: {} }],
  idempotency: { enabled: false }
};

function createApiDispatcher(options = {}) {
  return createDispatcher({
    strategies: defaultAuthStrategies,
    context: requestContext,
    time,
    ...options
  });
}

class TestHandler extends BaseRequestHandler {
  constructor(name, callback, logger = silentLogger) {
    super(name, { logger, time });
    this.callback = callback;
  }

  execute(req, res, next) {
    return this.callback(req, res, next);
  }
}

async function startTestServer(t, dispatcher, errorLogger = silentLogger) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.requestId = req.get("x-request-id") || "test-request-id";
    next();
  });
  app.use(requestContext.createMiddleware());
  app.use(dispatcher);
  app.use(createErrorHandler({ logger: errorLogger, time }));

  const server = createServer(app);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  t.after(
    () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      })
  );

  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

test("dispatcher invokes a configured public API", async (t) => {
  const systemLogs = [];
  const logger = {
    debug: async () => {},
    warn: async () => {},
    error: async (event, message, context) => {
      systemLogs.push({ level: "error", event, message, context });
    },
    info: async (event, message, context) => {
      systemLogs.push({ level: "info", event, message, context });
    }
  };
  const dispatcher = createApiDispatcher({
    routes: [
      {
        ...apiRouteDefaults,
        method: "GET",
        path: "/api/v1/public",
        description: "Public test endpoint.",
        authType: "public",
        requestSchema: emptyRequestSchema,
        responseSchema: anySuccessResponseSchema,
        handler: "publicHandler"
      }
    ],
    handlers: {
      publicHandler: new TestHandler(
        "publicHandler",
        (req) => ({ authType: req.auth.type }),
        logger
      )
    },
    logger
  });
  const baseUrl = await startTestServer(t, dispatcher);

  const response = await fetch(`${baseUrl}/api/v1/public`, {
    headers: { "X-Request-Id": "handler-request-id" }
  });
  assert.equal(response.status, 200);
  const responseBody = await response.json();
  assert.equal(responseBody.success, true);
  assert.deepEqual(responseBody.data, { authType: "public" });
  assert.equal(responseBody.meta.requestId, "handler-request-id");

  const handlerLogs = systemLogs.filter((entry) =>
    entry.event.startsWith("request.handler.")
  );
  assert.equal(handlerLogs.length, 2);
  assert.equal(handlerLogs[0].event, "request.handler.started");
  assert.equal(handlerLogs[1].event, "request.handler.finished");
  assert.equal(handlerLogs[0].context.requestId, "handler-request-id");
  assert.equal(handlerLogs[1].context.requestId, "handler-request-id");
  assert.equal(typeof handlerLogs[0].context.startTime, "string");
  assert.equal(typeof handlerLogs[1].context.endTime, "string");
  assert.ok(handlerLogs[1].context.durationMs >= 0);
  assert.equal(handlerLogs[1].context.outcome, "completed");

  const registrationLog = systemLogs.find(
    (entry) => entry.event === "api.registration.completed"
  );
  assert.equal(registrationLog.context.registeredApiCount, 1);
  assert.deepEqual(registrationLog.context.registeredApis, [
    {
      method: "GET",
      path: "/api/v1/public",
      description: "Public test endpoint.",
      authType: "public",
      authorizationPolicies: [{ name: "allowAll", options: {} }],
      handler: "publicHandler",
      version: "v1",
      deprecation: {
        version: "v1",
        deprecated: false,
        deprecatedAt: null,
        sunsetAt: null,
        replacement: null
      },
      idempotency: { enabled: false, ttlMs: 86400000 },
      // route 未指定時收斂成安全預設，requestLogger 才能無條件讀取。
      logging: { bodyCapture: "none" },
      // 檔案上傳與下載都必須明確啟用。
      upload: { enabled: false },
      download: { enabled: false },
      timeoutMs: 30000,
      requestSchemaLocations: [],
      responseStatusCodes: ["200"]
    }
  ]);
});

test("dispatcher validates request schemas before invoking the handler", async (t) => {
  const systemLogs = [];
  const logger = {
    ...silentLogger,
    error: async (event, message, context) => {
      systemLogs.push({ event, message, context });
    }
  };
  let handlerCalls = 0;
  const dispatcher = createApiDispatcher({
    routes: [
      {
        ...apiRouteDefaults,
        method: "POST",
        path: "/api/v1/products/:id",
        description: "Validate a product request.",
        authType: "public",
        requestSchema: {
          params: {
            type: "object",
            required: ["id"],
            additionalProperties: false,
            properties: {
              id: { type: "integer", minimum: 1 }
            }
          },
          query: {
            type: "object",
            additionalProperties: false,
            properties: {
              includeInactive: { type: "boolean", default: false }
            }
          },
          body: {
            type: "object",
            required: ["name", "price"],
            additionalProperties: false,
            properties: {
              name: { type: "string", minLength: 1, maxLength: 100 },
              price: { type: "number", minimum: 0 }
            }
          }
        },
        responseSchema: anySuccessResponseSchema,
        handler: "productHandler"
      }
    ],
    handlers: {
      productHandler: new TestHandler("productHandler", (req) => {
        handlerCalls += 1;
        return {
          id: req.input.params.id,
          idType: typeof req.input.params.id,
          includeInactive: req.input.query.includeInactive,
          price: req.input.body.price,
          priceType: typeof req.input.body.price
        };
      })
    },
    logger
  });
  const baseUrl = await startTestServer(t, dispatcher, logger);

  const validResponse = await fetch(`${baseUrl}/api/v1/products/42`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Keyboard", price: "199.9" })
  });
  assert.equal(validResponse.status, 200);
  assert.deepEqual((await validResponse.json()).data, {
    id: 42,
    idType: "number",
    includeInactive: false,
    price: 199.9,
    priceType: "number"
  });

  const invalidResponse = await fetch(
    `${baseUrl}/api/v1/products/not-a-number?unknown=true`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Request-Id": "invalid-schema-request"
      },
      body: JSON.stringify({ price: -1, unknown: true })
    }
  );
  const invalidBody = await invalidResponse.json();

  assert.equal(invalidResponse.status, 400);
  assert.equal(invalidBody.error.code, "REQUEST_VALIDATION_FAILED");
  assert.equal(invalidBody.error.message, "Request validation failed");
  assert.equal(invalidBody.meta.requestId, "invalid-schema-request");
  assert.ok(invalidBody.error.details.length >= 4);
  assert.equal(handlerCalls, 1);
  assert.ok(
    systemLogs.some(
      (entry) =>
        entry.event === "http.request_failed" &&
        entry.context.requestId === "invalid-schema-request" &&
        entry.context.error.code === "REQUEST_VALIDATION_FAILED"
    )
  );
});

test("JWT APIs reject missing tokens and accept valid tokens", async (t) => {
  const dispatcher = createApiDispatcher({
    routes: [
      {
        ...apiRouteDefaults,
        method: "GET",
        path: "/api/v1/profile",
        description: "Return the authenticated user profile.",
        authType: "jwt",
        requestSchema: emptyRequestSchema,
        responseSchema: anySuccessResponseSchema,
        handler: "profileHandler"
      }
    ],
    handlers: {
      profileHandler: new TestHandler("profileHandler", (req) => ({
        userId: req.user.sub
      }))
    },
    logger: silentLogger
  });
  const baseUrl = await startTestServer(t, dispatcher);

  const missingTokenResponse = await fetch(`${baseUrl}/api/v1/profile`);
  assert.equal(missingTokenResponse.status, 401);
  assert.deepEqual((await missingTokenResponse.json()).error, {
    code: "Unauthorized Access",
    message: "Unauthorized Access"
  });

  const token = issueAccessToken({ role: "admin" }, { subject: "user-42" });
  const authenticatedResponse = await fetch(`${baseUrl}/api/v1/profile`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.equal(authenticatedResponse.status, 200);
  assert.deepEqual((await authenticatedResponse.json()).data, { userId: "user-42" });
});

test("dispatcher blocks handler output that violates its response schema", async (t) => {
  const systemLogs = [];
  const logger = {
    ...silentLogger,
    error: async (event, message, context) => {
      systemLogs.push({ event, message, context });
    }
  };
  const dispatcher = createApiDispatcher({
    routes: [
      {
        ...apiRouteDefaults,
        method: "GET",
        path: "/api/v1/invalid-output",
        description: "Return output that violates its contract.",
        authType: "public",
        requestSchema: emptyRequestSchema,
        responseSchema: {
          200: {
            type: "object",
            required: ["count"],
            additionalProperties: false,
            properties: {
              count: { type: "integer" }
            }
          }
        },
        handler: "invalidOutputHandler"
      }
    ],
    handlers: {
      invalidOutputHandler: new TestHandler(
        "invalidOutputHandler",
        () => ({ count: "not-an-integer", internalSecret: "must-not-leak" }),
        logger
      )
    },
    logger
  });
  const baseUrl = await startTestServer(t, dispatcher, logger);
  const response = await fetch(`${baseUrl}/api/v1/invalid-output`, {
    headers: { "X-Request-Id": "invalid-response-request" }
  });
  const body = await response.json();

  assert.equal(response.status, 500);
  assert.equal(body.success, false);
  assert.deepEqual(body.error, {
    code: "INTERNAL_SERVER_ERROR",
    message: "Internal server error"
  });
  assert.equal(body.meta.requestId, "invalid-response-request");
  assert.equal(JSON.stringify(body).includes("must-not-leak"), false);
  assert.ok(
    systemLogs.some(
      (entry) =>
        entry.event === "http.request_failed" &&
        entry.context.error.code === "RESPONSE_VALIDATION_FAILED" &&
        entry.context.error.details.length >= 2
    )
  );
});

test("dispatcher prevents handlers from bypassing the response contract", async (t) => {
  const dispatcher = createApiDispatcher({
    routes: [
      {
        ...apiRouteDefaults,
        method: "GET",
        path: "/api/v1/direct-response",
        description: "Reject direct response writes from a handler.",
        authType: "public",
        requestSchema: emptyRequestSchema,
        responseSchema: anySuccessResponseSchema,
        handler: "directResponseHandler"
      }
    ],
    handlers: {
      directResponseHandler: new TestHandler(
        "directResponseHandler",
        (_req, res) => res.json({ internalSecret: "must-not-leak" })
      )
    },
    logger: silentLogger
  });
  const baseUrl = await startTestServer(t, dispatcher);
  const response = await fetch(`${baseUrl}/api/v1/direct-response`);
  const body = await response.json();

  assert.equal(response.status, 500);
  assert.deepEqual(body.error, {
    code: "INTERNAL_SERVER_ERROR",
    message: "Internal server error"
  });
  assert.equal(JSON.stringify(body).includes("must-not-leak"), false);
});

test("dispatcher returns a generic 401 for APIs missing from registered definitions", async (t) => {
  const dispatcher = createApiDispatcher({
    routes: [],
    handlers: {},
    logger: silentLogger
  });
  const baseUrl = await startTestServer(t, dispatcher);

  const response = await fetch(`${baseUrl}/api/not-configured`);
  assert.equal(response.status, 401);
  assert.deepEqual((await response.json()).error, {
    code: "Unauthorized Access",
    message: "Unauthorized Access"
  });
});

test("dispatcher accepts newly registered authentication strategies", async (t) => {
  const strategies = new AuthStrategyRegistry().register("apiKey", async (req) => {
    if (req.get("x-api-key") !== "test-key") {
      throw new AuthenticationError("API_KEY_INVALID", "API key is invalid");
    }

    return { type: "apiKey" };
  });
  const dispatcher = createApiDispatcher({
    routes: [
      {
        ...apiRouteDefaults,
        method: "GET",
        path: "/api/v1/integration",
        description: "Test an extensible authentication strategy.",
        authType: "apiKey",
        requestSchema: emptyRequestSchema,
        responseSchema: anySuccessResponseSchema,
        handler: "integrationHandler"
      }
    ],
    handlers: {
      integrationHandler: new TestHandler("integrationHandler", (req) => ({
        authType: req.auth.type
      }))
    },
    strategies,
    logger: silentLogger
  });
  const baseUrl = await startTestServer(t, dispatcher);

  const deniedResponse = await fetch(`${baseUrl}/api/v1/integration`);
  assert.equal(deniedResponse.status, 401);
  assert.deepEqual((await deniedResponse.json()).error, {
    code: "Unauthorized Access",
    message: "Unauthorized Access"
  });

  const allowedResponse = await fetch(`${baseUrl}/api/v1/integration`, {
    headers: { "X-API-Key": "test-key" }
  });
  assert.equal(allowedResponse.status, 200);
  assert.deepEqual((await allowedResponse.json()).data, { authType: "apiKey" });
});

test("request context remains available across asynchronous handler work", async (t) => {
  const dispatcher = createApiDispatcher({
    routes: [
      {
        ...apiRouteDefaults,
        method: "GET",
        path: "/api/v1/context",
        description: "Inspect the current request context.",
        authType: "public",
        requestSchema: emptyRequestSchema,
        responseSchema: anySuccessResponseSchema,
        handler: "contextHandler"
      }
    ],
    handlers: {
      contextHandler: new TestHandler("contextHandler", async () => {
        await Promise.resolve();
        const context = requestContext.get();
        return {
          requestId: context.requestId,
          authType: context.auth.type,
          route: context.apiRoute.path,
          policies: context.authorizationPolicies
        };
      })
    },
    logger: silentLogger
  });
  const baseUrl = await startTestServer(t, dispatcher);
  const response = await fetch(`${baseUrl}/api/v1/context`, {
    headers: { "X-Request-Id": "context-request" }
  });

  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data, {
    requestId: "context-request",
    authType: "public",
    route: "/api/v1/context",
    policies: [{ name: "allowAll", options: {} }]
  });
});

test("authorization policies accept role options from API config", async (t) => {
  const dispatcher = createApiDispatcher({
    routes: [
      {
        ...apiRouteDefaults,
        method: "GET",
        path: "/api/v1/admin",
        description: "Restrict an endpoint to administrators.",
        authType: "jwt",
        authorizationPolicies: [
          "authenticated",
          { name: "hasRole", options: { roles: ["admin"], match: "all" } }
        ],
        requestSchema: emptyRequestSchema,
        responseSchema: anySuccessResponseSchema,
        handler: "adminHandler"
      }
    ],
    handlers: {
      adminHandler: new TestHandler("adminHandler", (req) => ({
        userId: req.user.sub
      }))
    },
    logger: silentLogger
  });
  const baseUrl = await startTestServer(t, dispatcher);
  const userToken = issueAccessToken({ role: "user" }, { subject: "user-1" });
  const denied = await fetch(`${baseUrl}/api/v1/admin`, {
    headers: { Authorization: `Bearer ${userToken}` }
  });

  assert.equal(denied.status, 403);
  assert.deepEqual((await denied.json()).error, {
    code: "Forbidden",
    message: "Forbidden"
  });

  const adminToken = issueAccessToken({ role: "admin" }, { subject: "admin-1" });
  const allowed = await fetch(`${baseUrl}/api/v1/admin`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.equal(allowed.status, 200);
  assert.deepEqual((await allowed.json()).data, { userId: "admin-1" });
});

test("versioned deprecated APIs publish lifecycle headers", async (t) => {
  const dispatcher = createApiDispatcher({
    routes: [
      {
        ...apiRouteDefaults,
        method: "GET",
        path: "/api/v1/legacy",
        description: "Expose lifecycle metadata for an old API.",
        deprecation: {
          deprecated: true,
          deprecatedAt: "2026-01-01T00:00:00.000Z",
          sunsetAt: "2026-12-31T00:00:00.000Z",
          replacement: "/api/v1/replacement"
        },
        authType: "public",
        requestSchema: emptyRequestSchema,
        responseSchema: anySuccessResponseSchema,
        handler: "legacyHandler"
      }
    ],
    handlers: {
      legacyHandler: new TestHandler("legacyHandler", () => ({ ok: true }))
    },
    logger: silentLogger
  });
  const baseUrl = await startTestServer(t, dispatcher);
  const response = await fetch(`${baseUrl}/api/v1/legacy`);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("api-version"), "v1");
  assert.equal(
    response.headers.get("deprecation"),
    `@${Date.parse("2026-01-01T00:00:00.000Z") / 1000}`
  );
  assert.equal(response.headers.get("sunset"), "Thu, 31 Dec 2026 00:00:00 GMT");
  assert.equal(
    response.headers.get("link"),
    '</api/v1/replacement>; rel="successor-version"'
  );
});

test("idempotency replays successful responses and rejects key reuse with new input", async (t) => {
  let handlerCalls = 0;
  const dispatcher = createApiDispatcher({
    routes: [
      {
        ...apiRouteDefaults,
        method: "POST",
        path: "/api/v1/orders",
        description: "Create an order exactly once.",
        authType: "public",
        idempotency: { enabled: true, ttlMs: 60000 },
        requestSchema: {
          body: {
            type: "object",
            required: ["sku"],
            additionalProperties: false,
            properties: { sku: { type: "string", minLength: 1 } }
          }
        },
        responseSchema: { 201: anySuccessResponseSchema[200] },
        handler: "createOrder"
      }
    ],
    handlers: {
      createOrder: new TestHandler("createOrder", function createOrder(req) {
        handlerCalls += 1;
        return this.response(
          { orderId: `order-${handlerCalls}`, sku: req.input.body.sku },
          { statusCode: 201 }
        );
      })
    },
    logger: silentLogger
  });
  const baseUrl = await startTestServer(t, dispatcher);
  const sendOrder = (key, sku) =>
    fetch(`${baseUrl}/api/v1/orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(key ? { "Idempotency-Key": key } : {})
      },
      body: JSON.stringify({ sku })
    });

  const missingKey = await sendOrder(null, "SKU-1");
  assert.equal(missingKey.status, 400);
  assert.equal((await missingKey.json()).error.code, "IDEMPOTENCY_KEY_REQUIRED");

  const first = await sendOrder("create-order-1", "SKU-1");
  const firstBody = await first.json();
  const replay = await sendOrder("create-order-1", "SKU-1");
  const replayBody = await replay.json();

  assert.equal(first.status, 201);
  assert.equal(replay.status, 201);
  assert.equal(replay.headers.get("idempotency-replayed"), "true");
  assert.deepEqual(replayBody, firstBody);
  assert.equal(handlerCalls, 1);

  const conflict = await sendOrder("create-order-1", "SKU-2");
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.code, "IDEMPOTENCY_CONFLICT");
  assert.equal(handlerCalls, 1);
});

test("API config rejects route syntax that Express 5 removed", () => {
  const route = (path) => [
    {
      ...apiRouteDefaults,
      method: "GET",
      path,
      description: "Route syntax check.",
      authType: "public",
      handler: "noop",
      requestSchema: emptyRequestSchema,
      responseSchema: anySuccessResponseSchema
    }
  ];
  const validate = (path) =>
    validateApiConfig(route(path), {}, defaultAuthStrategies, 1000);

  for (const path of ["/api/v1/items/:id?", "/api/v1/files/*"]) {
    assert.throws(
      () => validate(path),
      (error) => {
        assert.match(error.message, /route syntax removed in Express 5/);
        return true;
      },
      `expected ${path} to be rejected`
    );
  }

  // 合法寫法必須通過路徑檢查，錯誤只應來自後續的 handler 查找。
  for (const path of ["/api/v1/items/:id", "/api/v1/files/*splat"]) {
    assert.throws(
      () => validate(path),
      (error) => {
        assert.match(error.message, /Handler not found/);
        return true;
      },
      `expected ${path} to pass the path check`
    );
  }
});

assert.ok(defaultAuthStrategies.has("public"));
assert.ok(defaultAuthStrategies.has("jwt"));
