import assert from "node:assert/strict";
import test from "node:test";
import apiConfig from "../config/api.js";
import { BaseRequestHandler } from "../src/framework/api/BaseRequestHandler.js";
import { resolveApiDefinitions } from "../src/framework/api/apiDefinitionResolver.js";
import { normalizeApiConfig } from "../src/framework/api/normalizeApiConfig.js";

const apiDefaults = normalizeApiConfig(apiConfig).defaults;

const requestSchema = {
  params: {
    type: "object",
    required: ["userId"],
    additionalProperties: false,
    properties: { userId: { type: "integer", minimum: 1 } }
  }
};
const responseSchema = {
  200: {
    type: "object",
    required: ["id"],
    additionalProperties: false,
    properties: { id: { type: "integer" } }
  }
};

test("API definitions inherit secure defaults from configuration", () => {
  class GetUserHandler extends BaseRequestHandler {
    static handlerName = "getUser";
    static api = {
      method: "GET",
      path: "/api/v1/users/:userId",
      description: "Get a user.",
      requestSchema,
      responseSchema
    };
  }

  const handler = new GetUserHandler({});
  const routes = resolveApiDefinitions({ getUser: handler }, apiDefaults);
  const [route] = routes;

  assert.equal(route.handler, "getUser");
  assert.equal(route.version, "v1");
  assert.equal(route.authType, "jwt");
  assert.deepEqual(route.authorizationPolicies, [
    { name: "authenticated", options: {} }
  ]);
  assert.deepEqual(route.deprecation, {
    deprecated: false,
    deprecatedAt: null,
    sunsetAt: null,
    replacement: null
  });
  assert.deepEqual(route.idempotency, { enabled: false, ttlMs: null });
  assert.equal(route.timeoutMs, null);
  assert.equal(Object.isFrozen(routes), true);
  assert.equal(Object.isFrozen(route), true);
  assert.equal(Object.isFrozen(route.responseSchema[200]), true);
  assert.equal(Object.isFrozen(responseSchema), false);
});

test("Handler API metadata overrides arrays and merges supported nested defaults", () => {
  class PublicLegacyHandler extends BaseRequestHandler {
    static handlerName = "publicLegacy";
    static api = {
      method: "POST",
      path: "/api/v1/public/legacy",
      description: "Exercise API overrides.",
      authType: "public",
      authorizationPolicies: [{ name: "allowAll", options: {} }],
      deprecation: {
        deprecated: true,
        replacement: "/api/v1/public/current"
      },
      idempotency: { enabled: true },
      timeoutMs: 5000,
      requestSchema: {},
      responseSchema: { 204: { type: "null" } }
    };
  }

  const routes = resolveApiDefinitions(
    { publicLegacy: new PublicLegacyHandler({}) },
    apiDefaults
  );
  const [route] = routes;

  assert.equal(route.authType, "public");
  assert.deepEqual(route.authorizationPolicies, [
    { name: "allowAll", options: {} }
  ]);
  assert.deepEqual(route.deprecation, {
    deprecated: true,
    deprecatedAt: null,
    sunsetAt: null,
    replacement: "/api/v1/public/current"
  });
  assert.deepEqual(route.idempotency, { enabled: true, ttlMs: null });
  assert.equal(route.timeoutMs, 5000);
});

test("API definition resolution rejects missing and unknown Handler metadata", () => {
  class MissingSchemaHandler extends BaseRequestHandler {
    static handlerName = "missingSchema";
    static api = {
      method: "GET",
      path: "/api/v1/missing",
      description: "Missing response schema.",
      requestSchema: {}
    };
  }
  class UnknownFieldHandler extends BaseRequestHandler {
    static handlerName = "unknownField";
    static api = {
      method: "GET",
      path: "/api/v1/unknown",
      description: "Contains an unknown field.",
      requestSchema: {},
      responseSchema: { 200: {} },
      authentication: "jwt"
    };
  }

  assert.throws(
    () =>
      resolveApiDefinitions(
        { missingSchema: new MissingSchemaHandler({}) },
        apiDefaults
      ),
    /must define static api.responseSchema/
  );
  assert.throws(
    () =>
      resolveApiDefinitions(
        { unknownField: new UnknownFieldHandler({}) },
        apiDefaults
      ),
    /unknown fields: authentication/
  );
});
