import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Logger } from "../src/services/logging/Logger.js";
import { SystemLogger } from "../src/services/logging/systemLogger.js";

test("system logger requires an injected logger", () => {
  assert.throws(
    () => new SystemLogger(),
    /requires a Logger/
  );
});

test("system logger writes independent JSONL logs and redacts sensitive context", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "erp-system-logs-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(directory, { recursive: true, force: true });
  });

  const profileLogger = new Logger({
    name: "system",
    config: {
      enabled: true,
      directory,
      filePrefix: "system",
      retentionDays: 30,
      cleanupIntervalHours: 24,
      timeZone: "Asia/Hong_Kong",
      maxFileSizeBytes: 10485760,
      redactedFields: ["password", "token"]
    }
  });
  const logger = new SystemLogger({ logger: profileLogger });

  await logger.info("application.started", "Application started", {
    port: 3000,
    password: "database-secret",
    nested: { token: "jwt-secret" }
  });

  const files = await readdir(directory);
  assert.equal(files.length, 1);
  assert.match(files[0], /^system-\d{4}-\d{2}-\d{2}\.log$/);

  const content = await readFile(path.join(directory, files[0]), "utf8");
  const entry = JSON.parse(content.trim());
  assert.deepEqual(Object.keys(entry), [
    "timestamp",
    "level",
    "event",
    "message",
    "context"
  ]);
  assert.equal(entry.level, "info");
  assert.equal(entry.event, "application.started");
  assert.equal(entry.message, "Application started");
  assert.equal(entry.context.password, "[REDACTED]");
  assert.equal(entry.context.nested.token, "[REDACTED]");
  assert.match(entry.timestamp, /\+08:00$/);
});
