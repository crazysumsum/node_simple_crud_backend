import path from "node:path";
import { fileURLToPath } from "node:url";

const serverRoot = fileURLToPath(new URL("../../../", import.meta.url));
const LOG_LEVELS = Object.freeze(["debug", "info", "warn", "error"]);

function requirePlainObject(value, fieldName) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${fieldName} must be an object`);
  }

  return value;
}

function positiveNumber(value, fieldName) {
  const number = Number(value);

  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`Logging config "${fieldName}" must be a positive number`);
  }

  return number;
}

export function normalizeLoggerConfig(source, name = "logger") {
  const profile = requirePlainObject(source, `logging.loggers.${name}`);
  const directory = path.isAbsolute(profile.directory)
    ? profile.directory
    : path.resolve(serverRoot, profile.directory || `logs/${name}`);
  const filePrefix = String(profile.filePrefix || name).trim();
  const minimumLevel = String(profile.minimumLevel || "info").toLowerCase();

  if (!/^[a-zA-Z0-9_-]+$/.test(filePrefix)) {
    throw new Error(
      `Logging config "loggers.${name}.filePrefix" may only contain letters, numbers, underscores, and hyphens`
    );
  }

  if (!LOG_LEVELS.includes(minimumLevel)) {
    throw new Error(
      `Logging config "loggers.${name}.minimumLevel" is invalid: ${minimumLevel}`
    );
  }

  return Object.freeze({
    enabled: profile.enabled !== false,
    directory,
    filePrefix,
    retentionDays: positiveNumber(
      profile.retentionDays ?? 30,
      `loggers.${name}.retentionDays`
    ),
    cleanupIntervalHours: positiveNumber(
      profile.cleanupIntervalHours ?? 24,
      `loggers.${name}.cleanupIntervalHours`
    ),
    maxFileSizeBytes: positiveNumber(
      profile.maxFileSizeBytes ?? 10485760,
      `loggers.${name}.maxFileSizeBytes`
    ),
    minimumLevel,
    redactedFields: Array.isArray(profile.redactedFields)
      ? Object.freeze(profile.redactedFields.map(String))
      : Object.freeze([])
  });
}

export function normalizeLoggingConfig(source) {
  const config = requirePlainObject(source, "logging config");
  const sourceLoggers = requirePlainObject(config.loggers, "logging.loggers");
  const entries = Object.entries(sourceLoggers);

  if (entries.length === 0) {
    throw new Error("Logging config must define at least one logger");
  }

  const loggers = {};

  for (const [name, sourceProfile] of entries) {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name)) {
      throw new Error(`Logging config logger name is invalid: ${name}`);
    }

    loggers[name] = normalizeLoggerConfig(sourceProfile, name);
  }

  if (!loggers.request) {
    throw new Error('Logging config must define the default "request" logger');
  }

  if (!loggers.system) {
    throw new Error('Logging config must define the default "system" logger');
  }

  return Object.freeze({ loggers: Object.freeze(loggers) });
}

export { LOG_LEVELS };
