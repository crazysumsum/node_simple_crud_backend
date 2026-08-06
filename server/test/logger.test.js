import assert from "node:assert/strict";
import test from "node:test";
import { LoggerRegistry } from "../src/services/logging/LoggerRegistry.js";
import { Logger } from "../src/services/logging/Logger.js";
import { LoggingService } from "../src/services/logging/LoggingService.js";

const loggerConfig = {
  enabled: true,
  directory: "logs/test",
  filePrefix: "test",
  retentionDays: 1,
  cleanupIntervalHours: 1,
  timeZone: "UTC",
  maxFileSizeBytes: 1024,
  redactedFields: ["password"]
};

test("generic logger sanitizes entries before delegating to its writer", async () => {
  const entries = [];
  const logger = new Logger({
    name: "test",
    config: loggerConfig,
    writer: {
      write: async (entry) => entries.push(entry),
      flush: async () => {}
    }
  });

  await logger.write({
    event: "user.created",
    message: "User created",
    context: { password: "secret" }
  });

  assert.equal(entries.length, 1);
  assert.deepEqual(Object.keys(entries[0]), [
    "timestamp",
    "level",
    "event",
    "message",
    "context"
  ]);
  assert.equal(typeof entries[0].timestamp, "string");
  assert.equal(entries[0].level, "info");
  assert.equal(entries[0].event, "user.created");
  assert.equal(entries[0].message, "User created");
  assert.equal(entries[0].context.password, "[REDACTED]");
});

test("generic logger rejects profile-specific top-level fields", async () => {
  const logger = new Logger({
    name: "test",
    config: loggerConfig,
    writer: { write: async () => {} }
  });

  await assert.rejects(
    () => logger.write({ event: "invalid", requestId: "outside-context" }),
    /Put logger-specific data in context/
  );
});

test("generic logger formats timestamps in its configured time zone", async () => {
  const entries = [];
  const logger = new Logger({
    name: "hong-kong",
    config: { ...loggerConfig, timeZone: "Asia/Hong_Kong" },
    writer: { write: async (entry) => entries.push(entry) }
  });

  await logger.write({
    timestamp: "2026-08-05T10:01:42.461Z",
    event: "time.checked",
    message: "Time checked"
  });

  assert.equal(entries[0].timestamp, "2026-08-05T18:01:42.461+08:00");
});

test("logger registry creates and exposes every configured logger profile", async () => {
  const flushed = [];
  const registry = new LoggerRegistry({
    configs: {
      request: loggerConfig,
      system: { ...loggerConfig, filePrefix: "system" },
      audit: { ...loggerConfig, filePrefix: "audit" }
    },
    loggerFactory: (name) => ({
      name,
      flush: async () => flushed.push(name)
    })
  });

  assert.deepEqual(registry.names(), ["request", "system", "audit"]);
  assert.equal(registry.require("audit").name, "audit");
  assert.throws(() => registry.require("missing"), /not registered/);

  await registry.flush();
  assert.deepEqual(flushed.sort(), ["audit", "request", "system"]);
});

test("generic logger filters entries below its configured minimum level", async () => {
  const entries = [];
  const logger = new Logger({
    name: "security",
    config: {
      ...loggerConfig,
      filePrefix: "security",
      minimumLevel: "warn"
    },
    writer: {
      write: async (entry) => entries.push(entry),
      flush: async () => {}
    }
  });

  await logger.write({ event: "ignored", level: "info" });
  await logger.write({ event: "written", level: "warn" });

  assert.equal(entries.length, 1);
  assert.equal(entries[0].event, "written");
  assert.equal(entries[0].level, "warn");
});

test("logging service flushes registry loggers once and separately flushes an injected logger", async () => {
  const createRegistry = (flushes) => {
    const loggers = {
      request: {
        enabled: false,
        flush: async () => {
          flushes.request += 1;
        },
        isSensitiveField: () => false,
        write: async () => {}
      },
      system: {
        enabled: true,
        flush: async () => {
          flushes.system += 1;
        },
        write: async () => {}
      }
    };

    return {
      require: (name) => loggers[name],
      flush: async () => Promise.all(Object.values(loggers).map((logger) => logger.flush()))
    };
  };

  const defaultFlushes = { request: 0, system: 0 };
  const defaultService = new LoggingService({
    config: { logging: { loggers: {} } },
    options: { loggerRegistry: createRegistry(defaultFlushes) }
  });

  await defaultService.shutdown();
  assert.deepEqual(defaultFlushes, { request: 1, system: 1 });

  const injectedFlushes = { request: 0, system: 0 };
  let injectedLoggerFlushes = 0;
  const injectedService = new LoggingService({
    config: { logging: { loggers: {} } },
    options: {
      logger: {
        flush: async () => {
          injectedLoggerFlushes += 1;
        }
      },
      loggerRegistry: createRegistry(injectedFlushes)
    }
  });

  await injectedService.shutdown();
  assert.equal(injectedLoggerFlushes, 1);
  assert.deepEqual(injectedFlushes, { request: 1, system: 1 });
});
