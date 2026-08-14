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

/**
 * 最小的單筆上限。
 *
 * 截斷剪不動時會退回五欄骨架（timestamp、level、event、message 各留 200 字元，
 * 加一句原始大小）。那個骨架最壞情況約 1.4KB，所以上限低於它的話，連骨架都
 * 進不了佇列，這個 logger 從此一筆都寫不出去。
 */
const MIN_ENTRY_BYTES = 4096;

function byteCount(value, fieldName, minimum = 1) {
  const number = Number(value);

  if (!Number.isInteger(number) || number < minimum) {
    throw new Error(
      `Logging config "${fieldName}" must be a whole number of bytes, at least ${minimum}`
    );
  }

  return number;
}

const BODY_CAPTURE_MODES = Object.freeze(["none", "full"]);

function bodyCaptureMode(value, fieldName) {
  const mode = String(value ?? "none").toLowerCase();

  if (!BODY_CAPTURE_MODES.includes(mode)) {
    throw new Error(
      `Logging config "${fieldName}" must be one of: ${BODY_CAPTURE_MODES.join(", ")}`
    );
  }

  return mode;
}

function errorStatusThreshold(value, fieldName) {
  if (value === null || value === false) {
    return null;
  }

  const status = Number(value ?? 400);

  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw new Error(
      `Logging config "${fieldName}" must be an HTTP status code or null`
    );
  }

  return status;
}

/**
 * 檔案權限位元。設定檔可寫 0o600 這類八進位字面值，或 "0600" 字串；
 * 字串一律以八進位解讀，避免有人誤寫十進位 600（= 0o1130）。
 */
function permissionMode(value, fieldName, fallback) {
  if (value === undefined || value === null) {
    return fallback;
  }

  const mode = typeof value === "string" ? Number.parseInt(value, 8) : Number(value);

  if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) {
    throw new Error(
      `Logging config "${fieldName}" must be a file mode between 0o000 and 0o777`
    );
  }

  return mode;
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

  const maxEntryBytes = byteCount(
    profile.maxEntryBytes ?? 262144,
    `loggers.${name}.maxEntryBytes`,
    MIN_ENTRY_BYTES
  );
  const maxQueuedBytes = byteCount(
    profile.maxQueuedBytes ?? 8388608,
    `loggers.${name}.maxQueuedBytes`
  );

  // 佇列預算裝不下一筆最大的條目，就會出現「佇列是空的但仍然收不下」這種
  // 狀態——那不是背壓，是這個 logger 永遠寫不出東西。
  if (maxQueuedBytes < maxEntryBytes) {
    throw new Error(
      `Logging config "loggers.${name}.maxQueuedBytes" (${maxQueuedBytes}) must be at ` +
        `least "maxEntryBytes" (${maxEntryBytes}), or an empty queue still has no room ` +
        "for a single full-size entry and every log line is dropped."
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
    maxQueuedEntries: positiveNumber(
      profile.maxQueuedEntries ?? 10000,
      `loggers.${name}.maxQueuedEntries`
    ),
    maxQueuedBytes,
    maxEntryBytes,
    minimumLevel,
    bodyCapture: bodyCaptureMode(
      profile.bodyCapture,
      `loggers.${name}.bodyCapture`
    ),
    bodyCaptureErrorStatus: errorStatusThreshold(
      profile.bodyCaptureErrorStatus,
      `loggers.${name}.bodyCaptureErrorStatus`
    ),
    fileMode: permissionMode(
      profile.fileMode,
      `loggers.${name}.fileMode`,
      0o600
    ),
    directoryMode: permissionMode(
      profile.directoryMode,
      `loggers.${name}.directoryMode`,
      0o700
    ),
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

export { LOG_LEVELS, MIN_ENTRY_BYTES };
