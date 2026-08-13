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

/**
 * 把 trustProxy 的設定接到真的 Express 上，回傳它算出來的 req.ip。
 *
 * 這裡刻意走完整條路徑（normalizeSecurityConfig → app.set("trust proxy")），
 * 因為要驗的正是「這個設定值餵給 Express 之後會發生什麼」——只測正規化的
 * 輸出，證明不了信任範圍是對的。
 */
async function clientIpFor(t, trustProxy, forwardedFor) {
  const security = normalizeSecurityConfig({
    ...securityConfig,
    reverseProxy: { trustProxy }
  });
  const app = express();
  app.set("trust proxy", security.reverseProxy.trustProxy);
  app.get("/ip", (req, res) => sendSuccess(res, { ip: req.ip }, { time }));
  const baseUrl = await startServer(t, app);

  const response = await fetch(`${baseUrl}/ip`, {
    headers: { "X-Forwarded-For": forwardedFor }
  });
  return (await response.json()).data.ip;
}

test("a hop count trusts a position, so a shorter path lets the client pick req.ip", async (t) => {
  // 部署有兩條入口：公開流量走 CDN 再走 LB（兩跳），另一條直連 LB（一跳）。
  // 跳數只能照其中一條設。
  const REAL_CHAIN = "203.0.113.7, 10.0.0.9";
  const FORGED_ON_SHORT_PATH = "1.2.3.4, 198.51.100.20";

  assert.equal(await clientIpFor(t, "2", REAL_CHAIN), "203.0.113.7");

  // 同一個設定，短路徑上的請求。從右邊數兩跳會數進客戶端自己送的那一段，
  // 於是 req.ip 完全由它指定——而 req.ip 餵的是 IP 限流、公開 route 的
  // idempotency scope、以及日誌的 clientIp。
  assert.equal(await clientIpFor(t, "2", FORGED_ON_SHORT_PATH), "1.2.3.4");

  // 照短路徑設就不會被騙，但長路徑上拿到的會是 CDN 的位址而不是客戶端的。
  assert.equal(await clientIpFor(t, "1", FORGED_ON_SHORT_PATH), "198.51.100.20");
});

test("trusted addresses stop at the first stranger, whatever the chain length", async (t) => {
  // loopback 是測試裡的 socket peer，10.0.0.0/8 是 LB。
  const TRUSTED = "loopback, 10.0.0.0/8";

  // 長路徑：兩層都在信任範圍內，走到 203.0.113.7 才停。
  assert.equal(await clientIpFor(t, TRUSTED, "203.0.113.7, 10.0.0.9"), "203.0.113.7");

  // 短路徑上的同一個偽造：198.51.100.20 不在 10/8 內，就地停住，偽造的
  // 1.2.3.4 永遠取不到。一個設定同時涵蓋兩條路徑，這是跳數做不到的。
  assert.equal(
    await clientIpFor(t, TRUSTED, "1.2.3.4, 198.51.100.20"),
    "198.51.100.20"
  );
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
