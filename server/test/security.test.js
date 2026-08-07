import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import securityConfig from "../config/security.js";
import { sendSuccess } from "../src/framework/http/apiResponse.js";
import { createErrorHandler } from "../src/framework/middleware/errorHandler.js";
import { normalizeSecurityConfig } from "../src/framework/security/normalizeSecurityConfig.js";
import { createTestTime } from "../test-support/createTestTime.js";
import {
  createCorsOptions,
  createHttpsEnforcementMiddleware
} from "../src/framework/security/securityMiddleware.js";

const silentLogger = {
  error: async () => {}
};
const time = createTestTime();

async function startServer(t, app) {
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

  return `http://127.0.0.1:${server.address().port}`;
}

test("security middleware sets Helmet headers and enforces the CORS allowlist", async (t) => {
  const security = normalizeSecurityConfig(securityConfig);
  const allowedOrigin = security.cors.allowedOrigins[0];
  const app = express();
  app.disable("x-powered-by");
  app.use(helmet());
  app.use(cors(createCorsOptions(security)));
  app.get("/api/security", (_req, res) => sendSuccess(res, { ok: true }, { time }));
  app.use(createErrorHandler({ logger: silentLogger, time }));
  const baseUrl = await startServer(t, app);

  const allowedResponse = await fetch(`${baseUrl}/api/security`, {
    headers: { Origin: allowedOrigin }
  });
  assert.equal(allowedResponse.status, 200);
  assert.equal(allowedResponse.headers.get("access-control-allow-origin"), allowedOrigin);
  assert.equal(allowedResponse.headers.get("x-powered-by"), null);
  assert.equal(allowedResponse.headers.get("x-content-type-options"), "nosniff");
  assert.equal(allowedResponse.headers.get("x-frame-options"), "SAMEORIGIN");

  const deniedResponse = await fetch(`${baseUrl}/api/security`, {
    headers: { Origin: "https://attacker.example" }
  });
  const deniedBody = await deniedResponse.json();
  assert.equal(deniedResponse.status, 403);
  assert.equal(deniedBody.success, false);
  assert.equal(deniedBody.error.code, "CORS_ORIGIN_DENIED");
});

test("JSON body parser returns the standard 413 response when its limit is exceeded", async (t) => {
  const app = express();
  app.use(helmet());
  app.use(express.json({ limit: "20b" }));
  app.post("/api/body", (req, res) => sendSuccess(res, req.body, { time }));
  app.use(createErrorHandler({ logger: silentLogger, time }));
  const baseUrl = await startServer(t, app);

  const response = await fetch(`${baseUrl}/api/body`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value: "this body is larger than twenty bytes" })
  });
  const body = await response.json();

  assert.equal(response.status, 413);
  assert.equal(body.success, false);
  assert.equal(body.error.code, "REQUEST_BODY_TOO_LARGE");
  assert.equal(body.error.message, "Request body is too large");
});

test("JSON body parser returns the standard 400 response for malformed JSON", async (t) => {
  const app = express();
  app.use(express.json({ limit: "100kb" }));
  app.post("/api/body", (req, res) => sendSuccess(res, req.body, { time }));
  app.use(createErrorHandler({ logger: silentLogger, time }));
  const baseUrl = await startServer(t, app);

  const response = await fetch(`${baseUrl}/api/body`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: '{"missing":"closing brace"'
  });
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.success, false);
  assert.equal(body.error.code, "INVALID_JSON");
  assert.equal(body.error.message, "Invalid JSON request body");
});

test("HTTPS enforcement trusts only the configured reverse proxy hop", async (t) => {
  const security = normalizeSecurityConfig({
    ...securityConfig,
    reverseProxy: { trustProxy: "1", enforceHttps: true }
  });
  const app = express();
  app.set("trust proxy", security.reverseProxy.trustProxy);
  app.use(createHttpsEnforcementMiddleware(security));
  app.get("/api/secure", (_req, res) => sendSuccess(res, { secure: true }, { time }));
  app.use(createErrorHandler({ logger: silentLogger, time }));
  const baseUrl = await startServer(t, app);

  const insecureResponse = await fetch(`${baseUrl}/api/secure`);
  assert.equal(insecureResponse.status, 426);
  assert.equal((await insecureResponse.json()).error.code, "HTTPS_REQUIRED");

  const proxiedHttpsResponse = await fetch(`${baseUrl}/api/secure`, {
    headers: { "X-Forwarded-Proto": "https" }
  });
  assert.equal(proxiedHttpsResponse.status, 200);
  assert.equal((await proxiedHttpsResponse.json()).success, true);
});
