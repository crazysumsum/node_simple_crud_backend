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
  assert.equal(entry.context.input.body.password, "[REDACTED]");
  assert.equal(entry.context.output.body.token, "[REDACTED]");
  assert.equal(entry.context.completion, "finished");
  assert.match(entry.context.requestTime, /\+08:00$/);
  assert.match(entry.context.responseTime, /\+08:00$/);
  assert.ok(entry.context.durationMs >= 0);
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
