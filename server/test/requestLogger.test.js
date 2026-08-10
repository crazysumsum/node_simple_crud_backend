import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readdir, readFile, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FileLogWriter } from "../src/services/logging/fileLogWriter.js";
import { Logger } from "../src/services/logging/Logger.js";
import { createRequestLogger } from "../src/framework/middleware/requestLogger.js";
import { createTestTime } from "../test-support/createTestTime.js";

const baseConfig = {
  enabled: true,
  directory: "",
  filePrefix: "requests",
  retentionDays: 30,
  cleanupIntervalHours: 24,
  maxFileSizeBytes: 10485760,
  redactedFields: ["password", "token"]
};
const time = createTestTime();

class MockResponse extends EventEmitter {
  constructor() {
    super();
    this.headers = new Map();
    this.statusCode = 201;
    this.writableFinished = false;
  }

  setHeader(name, value) {
    this.headers.set(name.toLowerCase(), value);
  }

  getHeader(name) {
    return this.headers.get(name.toLowerCase());
  }

  send(body) {
    this.writableFinished = true;
    this.emit("finish");
    return body;
  }

  end(chunk) {
    this.writableFinished = true;
    this.emit("finish");
    return chunk;
  }
}

test("request logger requires an injected logger", () => {
  assert.throws(
    () => createRequestLogger(),
    /requires a Logger/
  );
});

test("request logger captures metadata and redacts sensitive fields", async () => {
  let resolveEntry;
  const entryWritten = new Promise((resolve) => {
    resolveEntry = resolve;
  });
  const writer = {
    async write(entry) {
      resolveEntry(entry);
    }
  };
  const logger = new Logger({
    name: "request",
    config: baseConfig,
    time,
    writer
  });
  const middleware = createRequestLogger({ logger, time });
  const req = {
    method: "POST",
    originalUrl: "/api/users?active=true",
    headers: { "x-request-id": "test-request-id" },
    ip: "127.0.0.1",
    query: { active: "true" },
    params: { id: "42" },
    body: { name: "Sam", password: "request-secret" }
  };
  const res = new MockResponse();
  res.setHeader("content-type", "application/json; charset=utf-8");

  middleware(req, res, () => {
    res.send({ ok: true, token: "response-secret" });
  });

  const entry = await entryWritten;

  assert.deepEqual(Object.keys(entry), [
    "timestamp",
    "level",
    "event",
    "message",
    "context"
  ]);
  assert.equal(entry.level, "info");
  assert.equal(entry.event, "http.request.completed");
  assert.equal(entry.message, "HTTP request completed");
  assert.match(entry.timestamp, /\+08:00$/);
  assert.equal(req.requestId, "test-request-id");
  assert.equal(entry.context.requestId, "test-request-id");
  assert.equal(entry.context.url, "/api/users?active=true");
  assert.equal(entry.context.clientIp, "127.0.0.1");
  assert.equal(entry.context.output.statusCode, 201);
  // 成功回應預設不記錄 body：業務欄位帶的是個資，而 redactedFields 是黑名單，
  // 擋不住列舉不完的欄位名。中介資料仍然完整保留。
  assert.equal(entry.context.input.body, "[NOT_LOGGED]");
  assert.equal(entry.context.output.body, "[NOT_LOGGED]");
  assert.equal(entry.context.bodyCapture, "none");
  assert.equal(entry.context.completion, "finished");
  assert.match(entry.context.requestTime, /\+08:00$/);
  assert.match(entry.context.responseTime, /\+08:00$/);
  assert.ok(entry.context.durationMs >= 0);
});

/**
 * 跑一次請求並取回寫出的日誌 entry。
 */
async function captureEntry({ config = {}, req = {}, apiRoute, status = 200, responseBody, responseContentType = "application/json; charset=utf-8" } = {}) {
  let resolveEntry;
  const entryWritten = new Promise((resolve) => {
    resolveEntry = resolve;
  });
  const logger = new Logger({
    name: "request",
    config: { ...baseConfig, ...config },
    time,
    writer: { async write(entry) { resolveEntry(entry); } }
  });
  const middleware = createRequestLogger({ logger, time });
  const request = {
    method: "POST",
    originalUrl: "/api/v1/employees",
    headers: {},
    ip: "127.0.0.1",
    query: {},
    params: {},
    get(name) { return this.headers[name.toLowerCase()]; },
    ...req
  };

  if (apiRoute) {
    request.apiRoute = apiRoute;
  }

  const res = new MockResponse();
  res.statusCode = status;

  if (responseContentType !== null) {
    res.setHeader("content-type", responseContentType);
  }

  middleware(request, res, () => {
    res.send(responseBody);
  });

  return (await entryWritten).context;
}

const employee = {
  name: "陳大文",
  idNumber: "A123456789",
  monthlySalary: 68000,
  password: "hunter2"
};

test("request logger records full bodies when a route opts in", async () => {
  const context = await captureEntry({
    req: { body: employee },
    apiRoute: { logging: { bodyCapture: "full" } },
    responseBody: { ok: true, token: "response-secret" }
  });

  assert.deepEqual(context.input.body, { ...employee, password: "[REDACTED]" });
  assert.equal(context.output.body.token, "[REDACTED]");
  assert.equal(context.bodyCapture, "full");
});

test("request logger records full bodies on any error status", async () => {
  for (const status of [400, 409, 500, 503]) {
    const context = await captureEntry({
      req: { body: employee },
      status,
      responseBody: { success: false, error: { code: "X" } }
    });

    assert.deepEqual(
      context.input.body,
      { ...employee, password: "[REDACTED]" },
      `HTTP ${status} must keep the request body for reproduction`
    );
    assert.equal(context.output.body.error.code, "X");
  }
});

test("request logger keeps successful bodies out of the log", async () => {
  for (const status of [200, 201, 204, 304]) {
    const context = await captureEntry({
      req: { body: employee },
      status,
      responseBody: { data: { idNumber: "A123456789" } }
    });

    assert.equal(context.input.body, "[NOT_LOGGED]", `HTTP ${status} leaked the request body`);
    assert.equal(context.output.body, "[NOT_LOGGED]", `HTTP ${status} leaked the response body`);
  }
});

test("request logger never records file uploads or downloads", async () => {
  // 上傳：即使 route 要求 full，也不記錄。
  const upload = await captureEntry({
    req: {
      headers: { "content-type": "multipart/form-data; boundary=x" },
      body: { file: "binary-ish" }
    },
    apiRoute: { logging: { bodyCapture: "full" } },
    responseBody: { ok: true }
  });
  assert.equal(upload.input.body, "[FILE_TRANSFER]");

  // 下載：即使是錯誤狀態碼，也不記錄二進位回應。
  const download = await captureEntry({
    req: { body: { reportId: 7 } },
    status: 500,
    responseContentType: "application/pdf",
    responseBody: Buffer.from("%PDF-1.7 binary")
  });
  assert.equal(download.output.body, "[FILE_TRANSFER]");
  // 請求本身是 JSON，錯誤時仍應保留以便重現。
  assert.deepEqual(download.input.body, { reportId: 7 });

  // Buffer 回應在沒有 content-type 時同樣視為檔案。
  const buffered = await captureEntry({
    req: { body: {} },
    status: 500,
    responseContentType: null,
    responseBody: Buffer.from("raw")
  });
  assert.equal(buffered.output.body, "[FILE_TRANSFER]");
});

test("request logger honours a disabled error-status override", async () => {
  const context = await captureEntry({
    config: { bodyCaptureErrorStatus: null },
    req: { body: employee },
    status: 500,
    responseBody: { success: false }
  });

  assert.equal(context.input.body, "[NOT_LOGGED]");
  assert.equal(context.output.body, "[NOT_LOGGED]");
});

test("request logger redacts sensitive query values in the logged URL", async () => {
  let resolveEntry;
  const entryWritten = new Promise((resolve) => {
    resolveEntry = resolve;
  });
  const logger = new Logger({
    name: "request",
    config: baseConfig,
    time,
    writer: { write: async (entry) => resolveEntry(entry) }
  });
  const middleware = createRequestLogger({ logger, time });
  const req = {
    method: "GET",
    originalUrl: "/api/users?token=url-secret&active=true",
    headers: {},
    ip: "127.0.0.1",
    query: { token: "url-secret", active: "true" },
    params: {},
    body: undefined
  };
  const res = new MockResponse();

  middleware(req, res, () => res.send({ ok: true }));

  const entry = await entryWritten;
  assert.equal(
    entry.context.url,
    "/api/users?token=%5BREDACTED%5D&active=true"
  );
  assert.equal(entry.context.url.includes("url-secret"), false);
});

test("request logger records client disconnects with the shared log contract", async () => {
  let resolveEntry;
  const entryWritten = new Promise((resolve) => {
    resolveEntry = resolve;
  });
  const logger = new Logger({
    name: "request",
    config: baseConfig,
    time,
    writer: { write: async (entry) => resolveEntry(entry) }
  });
  const middleware = createRequestLogger({ logger, time });
  const req = {
    method: "GET",
    originalUrl: "/api/slow",
    headers: {},
    ip: "127.0.0.1",
    query: {},
    params: {}
  };
  const res = new MockResponse();

  middleware(req, res, () => res.emit("close"));

  const entry = await entryWritten;
  assert.equal(entry.level, "warn");
  assert.equal(entry.event, "http.request.client_disconnected");
  assert.equal(entry.message, "HTTP request ended before completion");
  assert.equal(entry.context.completion, "client_disconnected");
});

test("file writer appends JSONL and removes expired log files", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "erp-request-logs-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(directory, { recursive: true, force: true });
  });

  const oldFile = path.join(directory, "requests-2020-01-01.log");
  await writeFile(oldFile, "old\n", "utf8");
  const oldDate = time.at(time.nowMs() - 10 * 24 * 60 * 60 * 1000);
  await utimes(oldFile, oldDate, oldDate);

  const writer = new FileLogWriter({
    config: {
      ...baseConfig,
      directory,
      retentionDays: 2
    },
    time
  });
  const entry = {
    timestamp: time.timestamp(),
    level: "info",
    event: "http.request.completed",
    message: "HTTP request completed",
    context: { method: "GET", url: "/api/health" }
  };

  await writer.write(entry);

  const files = await readdir(directory);
  assert.equal(files.includes("requests-2020-01-01.log"), false);

  const currentFile = files.find((fileName) => fileName.startsWith("requests-"));
  const content = await readFile(path.join(directory, currentFile), "utf8");
  assert.deepEqual(JSON.parse(content.trim()), entry);
});

test("file writer reuses its resolved target instead of rescanning per write", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "erp-log-scan-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(directory, { recursive: true, force: true });
  });

  // 保留期內累積的檔案：每筆都掃目錄的話，成本會隨這個數量上升。
  for (let index = 0; index < 25; index += 1) {
    await writeFile(path.join(directory, `other-2026-07-${index}.log`), "x\n", "utf8");
  }

  const writer = new FileLogWriter({
    config: { ...baseConfig, directory, cleanupIntervalHours: 24 },
    time
  });
  await writer.ready;

  const entry = {
    timestamp: time.timestamp(),
    level: "info",
    event: "http.request.completed",
    message: "HTTP request completed",
    context: {}
  };
  let scans = 0;
  const resolveTarget = writer.resolveTarget.bind(writer);
  writer.resolveTarget = (date) => {
    scans += 1;
    return resolveTarget(date);
  };

  for (let index = 0; index < 20; index += 1) {
    await writer.write(entry);
  }

  assert.equal(scans, 1, "the directory must be scanned once, not per write");

  const content = await readFile(
    path.join(directory, `requests-${time.fileDate()}.log`),
    "utf8"
  );
  assert.equal(content.trim().split("\n").length, 20);
});

test("file writer keeps log files and their directory owner-only", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "erp-log-mode-"));
  const directory = path.join(parent, "logs");
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(parent, { recursive: true, force: true });
  });

  const { mkdir, chmod, stat: statFile } = await import("node:fs/promises");
  // 升級情境：目錄與檔案原本是全域可讀。
  await mkdir(directory, { recursive: true, mode: 0o755 });
  const legacyFile = path.join(directory, `requests-${time.fileDate()}.log`);
  await writeFile(legacyFile, "{}\n", "utf8");
  await chmod(legacyFile, 0o644);

  const writer = new FileLogWriter({
    config: { ...baseConfig, directory, fileMode: 0o600, directoryMode: 0o700 },
    time
  });
  await writer.ready;

  const mode = async (target) => (await statFile(target)).mode & 0o777;

  // 既有檔案必須一併收緊——它們正是裝著已落盤資料的那些。
  assert.equal(await mode(directory), 0o700);
  assert.equal(await mode(legacyFile), 0o600);

  // 之後新建的檔案（含輪替出來的）同樣必須是 0600。
  const entry = {
    timestamp: time.timestamp(),
    level: "info",
    event: "http.request.completed",
    message: "HTTP request completed",
    context: {}
  };
  await writer.write(entry);
  writer.config = { ...writer.config, maxFileSizeBytes: 1 };
  writer.target = null;
  await writer.write(entry);

  const files = await readdir(directory);
  assert.ok(files.length >= 2, `expected a rotated file, got ${files.join(", ")}`);

  for (const fileName of files) {
    assert.equal(
      await mode(path.join(directory, fileName)),
      0o600,
      `${fileName} must not be readable by other users`
    );
  }
});

test("logging config rejects an out-of-range file mode", async () => {
  const { normalizeLoggerConfig } = await import(
    "../src/services/logging/normalizeLoggingConfig.js"
  );

  // 字串以八進位解讀，避免誤寫十進位 600。
  assert.equal(
    normalizeLoggerConfig({ ...baseConfig, directory: "logs", fileMode: "640" }, "request")
      .fileMode,
    0o640
  );
  assert.throws(
    () =>
      normalizeLoggerConfig(
        { ...baseConfig, directory: "logs", fileMode: 0o1777 },
        "request"
      ),
    /fileMode/
  );
});

test("file writer rotates logs before the size limit is exceeded", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "erp-rotating-logs-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(directory, { recursive: true, force: true });
  });

  const entry = {
    timestamp: time.timestamp(),
    level: "info",
    event: "http.request.completed",
    message: "HTTP request completed",
    context: {
      method: "POST",
      url: "/api/orders",
      output: { statusCode: 201 }
    }
  };
  const lineSize = Buffer.byteLength(`${JSON.stringify(entry)}\n`, "utf8");
  const writer = new FileLogWriter({
    config: {
      ...baseConfig,
      directory,
      maxFileSizeBytes: lineSize + 10
    },
    time
  });

  await writer.write(entry);
  await writer.write(entry);

  const files = await readdir(directory);
  assert.equal(files.length, 2);
  assert.ok(files.some((fileName) => /^requests-\d{4}-\d{2}-\d{2}\.log$/.test(fileName)));
  assert.ok(
    files.some((fileName) => /^requests-\d{4}-\d{2}-\d{2}-001\.log$/.test(fileName))
  );

  for (const fileName of files) {
    const content = await readFile(path.join(directory, fileName));
    assert.ok(content.length <= lineSize + 10);
    assert.deepEqual(JSON.parse(content.toString("utf8").trim()), entry);
  }
});
