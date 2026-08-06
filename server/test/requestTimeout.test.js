import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import express from "express";
import { sendSuccess } from "../src/framework/http/apiResponse.js";
import { createRequestTimeoutMiddleware } from "../src/framework/middleware/requestTimeout.js";
import { RequestContextService } from "../src/services/context/RequestContextService.js";

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

test("request timeout returns the standard 504 response and aborts req.signal", async (t) => {
  const entries = [];
  const logger = {
    warn: async (event, message, context) => {
      entries.push({ event, message, context });
    }
  };
  const app = express();
  const context = new RequestContextService();
  let requestSignal;

  app.use((req, res, next) => {
    req.requestId = "timeout-request";
    res.setHeader("X-Request-Id", req.requestId);
    next();
  });
  app.use(context.createMiddleware());
  app.get(
    "/api/slow",
    createRequestTimeoutMiddleware({ timeoutMs: 20, logger, context }),
    async (req, res) => {
      requestSignal = req.signal;
      await new Promise((resolve) => setTimeout(resolve, 60));

      if (!res.headersSent) {
        sendSuccess(res, { completed: true });
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

  await new Promise((resolve) => setTimeout(resolve, 60));
});
