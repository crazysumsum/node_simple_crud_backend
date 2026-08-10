import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import express from "express";
import requestConfig from "../config/request.js";
import {
  RequestValidationError,
  RequestValidator
} from "../src/framework/validation/requestValidator.js";

const itemSchema = {
  params: {
    type: "object",
    required: ["id"],
    additionalProperties: false,
    properties: { id: { type: "integer", minimum: 1 } }
  },
  query: {
    type: "object",
    additionalProperties: false,
    properties: {
      page: { type: "integer", default: 1 },
      size: { type: "integer" }
    }
  },
  body: {
    type: "object",
    required: ["name"],
    additionalProperties: false,
    properties: { name: { type: "string" } }
  }
};

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

/**
 * 驗證必須在真實 Express request 上執行。以字面物件模擬 req 會讓
 * req.query 的 getter 行為消失，正是這些測試要守住的地方。
 */
function createValidatorApp(requestSchema, { path = "/api/v1/items/:id", method = "post" } = {}) {
  const validate = new RequestValidator({
    config: requestConfig.validation.input
  }).compile(requestSchema, `${method} ${path}`);
  const app = express();

  app.set("query parser", "extended");
  app.use(express.json());
  app[method](path, (req, res) => {
    try {
      validate(req);
    } catch (error) {
      if (!(error instanceof RequestValidationError)) {
        throw error;
      }

      res.status(error.statusCode).json({ code: error.code, details: error.details });
      return;
    }

    res.status(200).json({ input: req.input });
  });

  return app;
}

test("request validator coerces and defaults query and params on a real Express request", async (t) => {
  const baseUrl = await startServer(t, createValidatorApp(itemSchema));

  const response = await fetch(`${baseUrl}/api/v1/items/42?size=10`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "widget" })
  });
  const { input } = await response.json();

  assert.equal(response.status, 200);
  // 型別轉換與 default 都必須出現在 req.input，而不是只停留在 Ajv 內部。
  assert.deepEqual(input.params, { id: 42 });
  assert.deepEqual(input.query, { size: 10, page: 1 });
  assert.deepEqual(input.body, { name: "widget" });
  assert.equal(typeof input.params.id, "number");
  assert.equal(typeof input.query.size, "number");
  assert.equal(input.query.page, 1);
});

test("request validator reports location-tagged details for every invalid input", async (t) => {
  const baseUrl = await startServer(t, createValidatorApp(itemSchema));

  const response = await fetch(`${baseUrl}/api/v1/items/7?unknown=1`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nickname: "widget" })
  });
  const { code, details } = await response.json();

  assert.equal(response.status, 400);
  assert.equal(code, "REQUEST_VALIDATION_FAILED");
  assert.ok(
    details.some(
      (detail) => detail.location === "query" && detail.keyword === "additionalProperties"
    ),
    `expected an unknown query field detail, received ${JSON.stringify(details)}`
  );
  // 缺少 required 欄位時，路徑要補上欄位名而不是停在容器層級。
  assert.ok(
    details.some(
      (detail) =>
        detail.location === "body" &&
        detail.keyword === "required" &&
        detail.path === "/name"
    ),
    `expected a missing body/name detail, received ${JSON.stringify(details)}`
  );
});

test("request validator rejects a request that omits a required JSON body", async (t) => {
  const baseUrl = await startServer(t, createValidatorApp(itemSchema));

  const response = await fetch(`${baseUrl}/api/v1/items/7`, { method: "POST" });
  const { code, details } = await response.json();

  assert.equal(response.status, 400);
  assert.equal(code, "REQUEST_VALIDATION_FAILED");
  assert.ok(
    details.some(
      (detail) => detail.location === "body" && detail.path === "/name"
    ),
    `expected a missing body/name detail, received ${JSON.stringify(details)}`
  );
});

test("request validator keeps nested query objects produced by the extended query parser", async (t) => {
  const nestedSchema = {
    query: {
      type: "object",
      additionalProperties: false,
      properties: {
        filter: {
          type: "object",
          additionalProperties: false,
          properties: { status: { type: "string" } }
        },
        tags: { type: "array", items: { type: "string" } }
      }
    }
  };
  const baseUrl = await startServer(
    t,
    createValidatorApp(nestedSchema, { path: "/api/v1/items", method: "get" })
  );

  const response = await fetch(
    `${baseUrl}/api/v1/items?filter[status]=open&tags[]=a&tags[]=b`
  );
  const { input } = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(input.query, { filter: { status: "open" }, tags: ["a", "b"] });
});

test("request validator exposes only the locations declared in the request schema", async (t) => {
  const baseUrl = await startServer(
    t,
    createValidatorApp(
      { query: { type: "object", additionalProperties: false, properties: {} } },
      { path: "/api/v1/items", method: "get" }
    )
  );

  const response = await fetch(`${baseUrl}/api/v1/items`);
  const { input } = await response.json();

  assert.deepEqual(input, { params: {}, query: {}, body: null, headers: {} });
});
