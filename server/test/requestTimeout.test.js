import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import express from "express";
import { sendSuccess } from "../src/framework/http/apiResponse.js";
import { createRequestTimeoutMiddleware } from "../src/framework/middleware/requestTimeout.js";
import { RequestContextService } from "../src/services/context/RequestContextService.js";
import { createTestTime, servicesWithTime } from "../test-support/createTestTime.js";

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

test("request timeout returns the standard 504 response and aborts req.requestTimeout.signal", async (t) => {
  const entries = [];
  const logger = {
    warn: async (event, message, context) => {
      entries.push({ event, message, context });
    }
  };
  const app = express();
  const time = createTestTime();
  const context = new RequestContextService({ services: servicesWithTime(time) });
  let requestSignal;

  app.use((req, res, next) => {
    req.requestId = "timeout-request";
    res.setHeader("X-Request-Id", req.requestId);
    next();
  });
  app.use(context.createMiddleware());
  app.get(
    "/api/slow",
    createRequestTimeoutMiddleware({ timeoutMs: 20, logger, context, time }),
    async (req, res) => {
      requestSignal = req.requestTimeout.signal;
      await new Promise((resolve) => { setTimeout(resolve, 60); });

      if (!res.headersSent) {
        sendSuccess(res, { completed: true }, { time });
      }
    }
  );
  const baseUrl = await startServer(t, app);
  const response = await fetch(`${baseUrl}/api/slow`);
  const body = await response.json();

  assert.equal(response.status, 504);
  assert.equal(body.success, false);
  assert.equal(body.error.code, "REQUEST_TIMEOUT");
  assert.equal(body.error.message, "Request timed out");
  assert.equal(body.meta.requestId, "timeout-request");
  assert.equal(requestSignal.aborted, true);
  assert.equal(requestSignal.reason.code, "REQUEST_TIMEOUT");
  assert.equal(entries[0].event, "http.request_timeout");
  assert.equal(entries[0].context.timeoutMs, 20);
  assert.equal(entries[0].context.responseAlreadyStarted, false);

  await new Promise((resolve) => { setTimeout(resolve, 60); });
});

test("a timeout during a streamed response aborts the connection instead of throwing", async (t) => {
  const entries = [];
  const logger = {
    warn: async (event, message, context) => {
      entries.push({ event, message, context });
    },
    error: async (event, message, context) => {
      entries.push({ event, message, context });
    }
  };
  const app = express();
  const time = createTestTime();
  const context = new RequestContextService({ services: servicesWithTime(time) });

  app.use(context.createMiddleware());
  app.get(
    "/api/stream",
    createRequestTimeoutMiddleware({ timeoutMs: 20, logger, context, time }),
    async (_req, res) => {
      // header 一旦送出，逾時就不可能再改成 504：res.setHeader 會拋
      // ERR_HTTP_HEADERS_SENT，而計時器裡的例外會終止整個程序。
      res.status(200);
      res.setHeader("Content-Type", "application/octet-stream");
      res.write("first-chunk");
      await new Promise((resolve) => { setTimeout(resolve, 200); });
    }
  );

  const uncaught = [];
  const onUncaught = (error) => uncaught.push(error);
  process.on("uncaughtException", onUncaught);
  t.after(() => process.removeListener("uncaughtException", onUncaught));

  const baseUrl = await startServer(t, app);
  const response = await fetch(`${baseUrl}/api/stream`);

  assert.equal(response.status, 200);
  await assert.rejects(() => response.text(), "串流應該被中斷");

  await new Promise((resolve) => { setTimeout(resolve, 60); });

  assert.deepEqual(uncaught, [], "逾時不得產生未捕捉例外");
  assert.equal(entries[0].event, "http.request_timeout");
  assert.equal(entries[0].context.responseAlreadyStarted, true);
});
