import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { UploadConcurrencyGate } from "../src/framework/upload/uploadConcurrencyGate.js";
import {
  normalizeApiUploadConfig,
  normalizeUploadConfig
} from "../src/framework/upload/normalizeUploadConfig.js";
import { createUploadMiddleware } from "../src/framework/upload/uploadMiddleware.js";
import { FileTypeService } from "../src/services/filetype/FileTypeService.js";

// 上傳在校驗通過之前完整累積在記憶體裡（校驗需要完整內容——OLE2 的目錄扇區與
// OOXML 的 [Content_Types].xml 都可能落在檔案尾端）。實測 100 個並行 10MB
// 上傳是 1088 MB RSS，而那些位元組是 Buffer、落在 V8 堆之外，所以
// --max-old-space-size 擋不住：程序不會拋錯，只會被 OOM killer 殺掉。
//
// 三道限制共同把它綁死，這個檔案逐一釘住它們，以及那個一旦漏掉就單向累積的
// 槽位釋放。

const BOUNDARY = "----limitstest";
const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function png(totalBytes) {
  return Buffer.concat([
    PNG_HEAD,
    Buffer.alloc(Math.max(0, totalBytes - PNG_HEAD.length), 0x41)
  ]);
}

function multipart(files, fields = {}) {
  const parts = [];

  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
      )
    );
  }

  for (const [index, content] of files.entries()) {
    parts.push(
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file${index}"; filename="a${index}.png"\r\n` +
          "Content-Type: image/png\r\n\r\n"
      ),
      content,
      Buffer.from("\r\n")
    );
  }

  parts.push(Buffer.from(`--${BOUNDARY}--\r\n`));
  return Buffer.concat(parts);
}

const fileTypes = new FileTypeService({ config: {}, services: null, options: {} });

async function uploadDirectory(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "upload-limits-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function uploadConfig(directory, overrides = {}) {
  return normalizeUploadConfig(
    {
      enabled: true,
      directory,
      maxFileSizeBytes: 4096,
      maxFiles: 3,
      allowedMimeTypes: ["image/png"],
      ...overrides
    },
    "test upload",
    fileTypes
  );
}

/** 送一個完整的 multipart 請求進中間件，回傳 next() 收到的錯誤（或 null）。 */
function send(middleware, body, { declareLength = true } = {}) {
  const req = new PassThrough();
  req.headers = { "content-type": `multipart/form-data; boundary=${BOUNDARY}` };

  if (declareLength) {
    req.headers["content-length"] = String(body.length);
  }

  req.get = (name) => req.headers[String(name).toLowerCase()];
  req.complete = false;

  const headers = new Map();
  const res = { setHeader: (name, value) => headers.set(name.toLowerCase(), value) };
  const settled = new Promise((resolve) => {
    middleware(req, res, (error) => resolve({ error: error || null, headers, req }));
  });

  req.write(body);
  req.complete = true;
  req.end();
  return settled;
}

/** .finally(releaseSlot) 排在 next() 之後一個 microtask。 */
const drain = () =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

// --- 閘門本身 ------------------------------------------------------------------

test("the gate hands out exactly its configured number of slots", () => {
  const gate = new UploadConcurrencyGate({ maxConcurrentUploads: 2 });

  const first = gate.acquire();
  const second = gate.acquire();

  assert.equal(typeof first, "function");
  assert.equal(typeof second, "function");
  assert.equal(gate.acquire(), null, "第三個必須拿不到");
  assert.deepEqual(gate.stats(), {
    active: 2,
    peak: 2,
    rejected: 1,
    maxConcurrentUploads: 2
  });

  first();
  assert.equal(typeof gate.acquire(), "function", "釋放之後槽位要回來");
});

test("releasing a slot twice does not create a slot out of nothing", () => {
  const gate = new UploadConcurrencyGate({ maxConcurrentUploads: 1 });
  const release = gate.acquire();

  // 中間件有多條結束路徑，同一個槽位被放兩次是真實會發生的。不冪等的話
  // active 會變成負數，閘門就永遠不會滿——上限靜默失效。
  release();
  release();
  release();

  assert.equal(gate.stats().active, 0);
  assert.equal(typeof gate.acquire(), "function");
  assert.equal(gate.acquire(), null);
});

test("the gate refuses to be built without a usable limit", () => {
  for (const maxConcurrentUploads of [0, -1, 1.5, "10", undefined]) {
    assert.throws(
      () => new UploadConcurrencyGate({ maxConcurrentUploads }),
      /positive maxConcurrentUploads/,
      `${maxConcurrentUploads} 不該被接受`
    );
  }
});

// --- 單一請求的位元組上限 --------------------------------------------------------

test("a declared Content-Length over the limit is refused before a slot is taken", async (t) => {
  const gate = new UploadConcurrencyGate({ maxConcurrentUploads: 1 });
  const middleware = createUploadMiddleware({
    config: uploadConfig(await uploadDirectory(t), {
      maxFiles: 1,
      maxFileSizeBytes: 2000,
      maxRequestBytes: 2048
    }),
    logger: null,
    fileTypes,
    gate
  });

  const { error } = await send(middleware, multipart([png(4000)]));

  assert.equal(error.code, "UPLOAD_REQUEST_TOO_LARGE");
  assert.equal(error.statusCode, 413);
  // 誠實的客戶端在讀進任何位元組之前就被擋下，所以連槽位都不該佔用。
  assert.deepEqual(gate.stats(), {
    active: 0,
    peak: 0,
    rejected: 0,
    maxConcurrentUploads: 1
  });
});

test("a client that lies about Content-Length is still stopped mid-stream", async (t) => {
  const gate = new UploadConcurrencyGate({ maxConcurrentUploads: 1 });
  const middleware = createUploadMiddleware({
    config: uploadConfig(await uploadDirectory(t), {
      maxFiles: 1,
      maxFileSizeBytes: 2000,
      maxRequestBytes: 2048
    }),
    logger: null,
    fileTypes,
    gate
  });

  // 不宣告 Content-Length（chunked），或宣告不實——兩者都只能靠逐位元組計數。
  const { error } = await send(middleware, multipart([png(4000)]), {
    declareLength: false
  });

  assert.equal(error.code, "UPLOAD_REQUEST_TOO_LARGE");
  await drain();
  assert.equal(gate.stats().active, 0, "中途切斷也要放掉槽位");
});

test("text fields count toward the request budget, not just files", async (t) => {
  const middleware = createUploadMiddleware({
    config: uploadConfig(await uploadDirectory(t), {
      maxFiles: 1,
      maxFileSizeBytes: 2000,
      maxRequestBytes: 3000,
      maxFieldSizeBytes: 65536
    }),
    logger: null,
    fileTypes,
    gate: new UploadConcurrencyGate({ maxConcurrentUploads: 1 })
  });

  // 檔案本身很小，超限的是文字欄位。maxFileSizeBytes 對這種請求毫無作用。
  const { error } = await send(
    middleware,
    multipart([png(256)], { note: "x".repeat(4000) }),
    { declareLength: false }
  );

  assert.equal(error.code, "UPLOAD_REQUEST_TOO_LARGE");
});

// --- 每個請求的檔案總量 ----------------------------------------------------------

test("files that each fit can still be refused as a group", async (t) => {
  const gate = new UploadConcurrencyGate({ maxConcurrentUploads: 1 });
  const middleware = createUploadMiddleware({
    config: uploadConfig(await uploadDirectory(t), {
      maxFileSizeBytes: 4096,
      maxFiles: 3,
      maxTotalFileBytes: 6000,
      maxRequestBytes: 1048576
    }),
    logger: null,
    fileTypes,
    gate
  });

  // 三個 3000 位元組的檔案，每一個都在 maxFileSizeBytes 之內。單檔上限限制不住
  // 總和——這正是先前一個請求能佔 maxFiles × maxFileSizeBytes 的原因。
  const { error } = await send(middleware, multipart([png(3000), png(3000), png(3000)]));

  assert.equal(error.code, "UPLOAD_TOTAL_TOO_LARGE");
  assert.equal(error.statusCode, 413);
  await drain();
  assert.equal(gate.stats().active, 0);
});

test("a group inside the total budget is accepted", async (t) => {
  const middleware = createUploadMiddleware({
    config: uploadConfig(await uploadDirectory(t), {
      maxFileSizeBytes: 4096,
      maxFiles: 3,
      maxTotalFileBytes: 6000,
      maxRequestBytes: 1048576
    }),
    logger: null,
    fileTypes,
    gate: new UploadConcurrencyGate({ maxConcurrentUploads: 1 })
  });

  const { error, req } = await send(middleware, multipart([png(2000), png(2000)]));

  assert.equal(error, null);
  assert.equal(req.files.length, 2);
});

// --- 全域併發 --------------------------------------------------------------------

test("uploads beyond the gate get 503 with Retry-After, not a queue slot", async (t) => {
  const directory = await uploadDirectory(t);
  const gate = new UploadConcurrencyGate({ maxConcurrentUploads: 2 });
  const config = uploadConfig(directory);
  const middleware = createUploadMiddleware({ config, logger: null, fileTypes, gate });
  const body = multipart([png(1024)]);

  // 五個同時進來，閘門只有兩個槽位。
  const results = await Promise.all(
    Array.from({ length: 5 }, () => send(middleware, body))
  );

  const accepted = results.filter(({ error }) => error === null);
  const refused = results.filter(({ error }) => error?.code === "UPLOAD_CAPACITY_EXCEEDED");

  assert.equal(accepted.length, 2);
  assert.equal(refused.length, 3);
  assert.equal(refused[0].error.statusCode, 503);
  // 排隊會讓客戶端握著連線慢慢傳，而佔住槽位正是這裡要防的事。
  assert.equal(refused[0].headers.get("retry-after"), "1");
  assert.equal(gate.stats().peak, 2);
});

test("slots come back after every terminal path, so capacity does not decay", async (t) => {
  const directory = await uploadDirectory(t);
  const gate = new UploadConcurrencyGate({ maxConcurrentUploads: 2 });
  const config = uploadConfig(directory, {
    maxFileSizeBytes: 2000,
    maxTotalFileBytes: 2000,
    maxRequestBytes: 1048576
  });
  const middleware = createUploadMiddleware({ config, logger: null, fileTypes, gate });

  // 交錯成功與失敗，跑三輪。漏放一次槽位是單向累積的：上傳會在某個時點之後
  // 全部開始回 503，而且沒有任何錯誤指向原因。
  for (let round = 0; round < 3; round += 1) {
    const [ok, tooBig] = await Promise.all([
      send(middleware, multipart([png(512)])),
      send(middleware, multipart([png(1500), png(1500)]))
    ]);

    assert.equal(ok.error, null, `第 ${round + 1} 輪的合法上傳應該通過`);
    assert.equal(tooBig.error.code, "UPLOAD_TOTAL_TOO_LARGE");
    await drain();
    assert.equal(gate.stats().active, 0, `第 ${round + 1} 輪之後槽位應該全部回來`);
  }

  assert.equal(gate.stats().rejected, 0, "兩個槽位始終夠用，不該有人被拒");
});

test("a client that disconnects mid-upload gives its slot back", async (t) => {
  const gate = new UploadConcurrencyGate({ maxConcurrentUploads: 1 });
  const middleware = createUploadMiddleware({
    config: uploadConfig(await uploadDirectory(t)),
    logger: null,
    fileTypes,
    gate
  });

  const req = new PassThrough();
  req.headers = {
    "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
    "content-length": "100000"
  };
  req.get = (name) => req.headers[String(name).toLowerCase()];
  req.complete = false;

  const settled = new Promise((resolve) => {
    middleware(req, { setHeader() {} }, (error) => resolve(error));
  });

  // 只寫一部分就斷線——最便宜的一種上傳中斷，而且是攻擊者最容易大量製造的。
  // 這條路徑漏放槽位的話，閘門會被慢慢啃光，之後所有上傳一律 503。
  req.write(multipart([png(512)]).subarray(0, 200));
  req.emit("close");

  const error = await settled;
  assert.equal(error.code, "UPLOAD_ABORTED");
  await drain();
  assert.equal(gate.stats().active, 0);
  assert.equal(typeof gate.acquire(), "function");
});

test("a multipart header busboy cannot parse gives its slot back", async (t) => {
  const gate = new UploadConcurrencyGate({ maxConcurrentUploads: 1 });
  const middleware = createUploadMiddleware({
    config: uploadConfig(await uploadDirectory(t)),
    logger: null,
    fileTypes,
    gate
  });

  const req = new PassThrough();
  // 沒有 boundary，busboy 在建構時就拋錯——這條路徑比解析期的錯誤更早，
  // 走不到 parser.on("close") 的釋放。
  req.headers = { "content-type": "multipart/form-data" };
  req.get = (name) => req.headers[String(name).toLowerCase()];
  req.complete = false;

  const error = await new Promise((resolve) => {
    middleware(req, { setHeader() {} }, resolve);
  });

  assert.equal(error.code, "UPLOAD_MALFORMED");
  await drain();
  assert.equal(gate.stats().active, 0);
  assert.equal(typeof gate.acquire(), "function");
});

test("a malformed multipart body gives its slot back", async (t) => {
  const gate = new UploadConcurrencyGate({ maxConcurrentUploads: 1 });
  const middleware = createUploadMiddleware({
    config: uploadConfig(await uploadDirectory(t)),
    logger: null,
    fileTypes,
    gate
  });

  const { error } = await send(middleware, Buffer.from("not multipart at all"));

  assert.ok(error);
  await drain();
  assert.equal(gate.stats().active, 0);
  // 槽位真的回來了才拿得到下一個。
  assert.equal(typeof gate.acquire(), "function");
});

test("an upload middleware with no gate still works", async (t) => {
  // gate 是選填的，直接建構中間件的呼叫端（測試、或不經 dispatcher 的組裝）
  // 不該因此壞掉。
  const middleware = createUploadMiddleware({
    config: uploadConfig(await uploadDirectory(t)),
    logger: null,
    fileTypes
  });

  const { error, req } = await send(middleware, multipart([png(1024)]));

  assert.equal(error, null);
  assert.equal(req.files.length, 1);
});

// --- 設定 ------------------------------------------------------------------------

test("the per-route totals default to the product they are meant to bound", () => {
  const config = normalizeUploadConfig(
    {
      enabled: true,
      directory: "storage/uploads",
      maxFileSizeBytes: 1000,
      maxFiles: 3,
      maxFieldCount: 2,
      maxFieldSizeBytes: 100,
      allowedMimeTypes: ["image/png"]
    },
    "test upload",
    fileTypes
  );

  assert.equal(config.maxTotalFileBytes, 3000);
  assert.equal(config.maxRequestBytes, 3200);
});

test("upload sizes have a ceiling, because they multiply", () => {
  const base = {
    enabled: true,
    directory: "storage/uploads",
    allowedMimeTypes: ["image/png"]
  };

  // 先前沒有上限，所以 maxFiles: 50 配 maxFileSizeBytes: 100MB 會通過驗證，
  // 而那是每個請求 5GB。
  assert.throws(
    () => normalizeUploadConfig({ ...base, maxFileSizeBytes: 104857601 }, "test", fileTypes),
    /"maxFileSizeBytes" must not exceed 104857600, because uploads are buffered in memory/
  );
  assert.throws(
    () => normalizeUploadConfig({ ...base, maxFiles: 21 }, "test", fileTypes),
    /"maxFiles" must not exceed 20/
  );
  assert.equal(
    normalizeUploadConfig({ ...base, maxFileSizeBytes: 104857600 }, "test", fileTypes)
      .maxFileSizeBytes,
    104857600
  );
});

test("the totals must be able to hold what the per-item limits allow", () => {
  const base = {
    enabled: true,
    directory: "storage/uploads",
    allowedMimeTypes: ["image/png"],
    maxFileSizeBytes: 5000,
    maxFiles: 2
  };

  // 這兩個組合每一半都合法，只有放在一起才錯——一條沒有任何檔案能通過的
  // route，或一個永遠達不到的檔案總量。
  assert.throws(
    () => normalizeUploadConfig({ ...base, maxTotalFileBytes: 4000 }, "test", fileTypes),
    /"maxTotalFileBytes" \(4000\) must be at least "maxFileSizeBytes" \(5000\)/
  );
  assert.throws(
    () =>
      normalizeUploadConfig(
        { ...base, maxTotalFileBytes: 10000, maxRequestBytes: 9000 },
        "test",
        fileTypes
      ),
    /"maxRequestBytes" \(9000\) must be at least "maxTotalFileBytes" \(10000\)/
  );
});

// --- 啟動時把乘積講出來 -----------------------------------------------------------

test("startup states the worst-case upload memory, because nobody computes it", async (t) => {
  const { createApiDispatcher } = await import(
    "../src/framework/middleware/apiDispatcher.js"
  );
  const { BaseRequestHandler } = await import("../src/framework/api/BaseRequestHandler.js");
  const directory = await uploadDirectory(t);
  const logs = [];
  const logger = {
    debug: async () => {},
    warn: async () => {},
    error: async () => {},
    info: async (event, message, context) => logs.push({ event, context })
  };

  class UploadHandler extends BaseRequestHandler {
    static handlerName = "uploadHandler";
    async execute() {
      return this.response({});
    }
  }

  createApiDispatcher({
    routes: [
      {
        method: "POST",
        path: "/api/v1/attachments",
        description: "Upload an attachment.",
        authType: "public",
        authorizationPolicies: [{ name: "allowAll", options: {} }],
        version: "v1",
        deprecation: { deprecated: false, deprecatedAt: null, sunsetAt: null, replacement: null },
        idempotency: { enabled: false },
        requestSchema: { body: { type: "object", additionalProperties: true } },
        responseSchema: { 200: { type: "object", additionalProperties: true } },
        handler: "uploadHandler",
        upload: {
          enabled: true,
          directory,
          maxFileSizeBytes: 8388608,
          maxFiles: 2,
          maxFieldCount: 10,
          maxFieldSizeBytes: 1024,
          allowedMimeTypes: ["image/png"]
        }
      }
    ],
    handlers: {
      uploadHandler: new UploadHandler({
        get: () => undefined,
        require: () => undefined,
        has: () => false
      })
    },
    strategies: { has: () => true, authenticate: async () => ({ type: "public" }) },
    context: { update() {}, get: () => ({}) },
    logger,
    time: {
      timestamp: () => "2026-01-01T00:00:00.000+08:00",
      nowMs: () => 0,
      at: () => new Date(0)
    },
    fileTypes,
    apiUpload: normalizeApiUploadConfig({ maxConcurrentUploads: 4 })
  });

  const budget = logs.find(({ event }) => event === "api.upload_budget");

  // 這兩個數字先前分別住在全域設定與 handler 的 static api.upload 裡，乘積不在
  // 任何地方，也沒有任何人被要求看過它。實測 100 個並行 10MB 是 1088 MB RSS。
  assert.ok(budget, "有上傳 route 時必須報告記憶體預算");
  assert.equal(budget.context.maxConcurrentUploads, 4);
  // 2 × 8MB 檔案 + 10 × 1KB 欄位 = 16787456
  assert.equal(budget.context.largestRequestBytes, 16787456);
  assert.equal(budget.context.worstCaseBytes, 4 * 16787456);
  assert.deepEqual(budget.context.apis, [
    {
      api: "post /api/v1/attachments",
      maxRequestBytes: 16787456,
      maxTotalFileBytes: 16777216
    }
  ]);
});

test("the global upload config defaults and validates its concurrency", () => {
  assert.equal(normalizeApiUploadConfig({}).maxConcurrentUploads, 10);
  assert.equal(normalizeApiUploadConfig({ maxConcurrentUploads: 1 }).maxConcurrentUploads, 1);

  for (const maxConcurrentUploads of [0, -1, 1.5, "ten"]) {
    assert.throws(
      () => normalizeApiUploadConfig({ maxConcurrentUploads }),
      /"maxConcurrentUploads" must be a positive integer/,
      `${maxConcurrentUploads} 不該被接受`
    );
  }

  assert.throws(
    () => normalizeApiUploadConfig({ maxConcurrentUploads: 2001 }),
    /"maxConcurrentUploads" must not exceed 2000/
  );
  assert.throws(() => normalizeApiUploadConfig([]), /must be an object/);
  assert.throws(() => normalizeApiUploadConfig(null), /must be an object/);
});
