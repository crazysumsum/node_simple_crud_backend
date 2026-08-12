import { FileLogWriter } from "./fileLogWriter.js";
import { redactValue } from "./logValue.js";
import {
  LOG_LEVELS,
  normalizeLoggerConfig
} from "./normalizeLoggingConfig.js";

const ENTRY_FIELDS = new Set([
  "timestamp",
  "level",
  "event",
  "message",
  "context"
]);

export class Logger {
  constructor({ name, config, writer, time } = {}) {
    this.name = String(name || "logger");
    this.config = normalizeLoggerConfig(config, this.name);
    this.time = time;

    if (!time || typeof time.timestamp !== "function" || typeof time.fileDate !== "function") {
      throw new TypeError("Logger requires a time service");
    }

    this.writer =
      writer || (this.config.enabled ? new FileLogWriter({ config: this.config, time }) : null);
    this.sensitiveFields = new Set(
      this.config.redactedFields.map((field) => field.toLowerCase())
    );
  }

  get enabled() {
    return this.config.enabled;
  }

  isSensitiveField(fieldName) {
    return this.sensitiveFields.has(String(fieldName).toLowerCase());
  }

  sanitize(value) {
    return redactValue(value, this.sensitiveFields, (date) => this.time.timestamp(date));
  }

  formatTimestamp(value) {
    return this.time.timestamp(value);
  }

  async write(entry) {
    if (!this.enabled) {
      return;
    }

    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new TypeError("Logger entry must be an object");
    }

    const unsupportedFields = Object.keys(entry).filter(
      (field) => !ENTRY_FIELDS.has(field)
    );

    if (unsupportedFields.length > 0) {
      throw new Error(
        `Logger entry contains unsupported top-level fields: ${unsupportedFields.join(", ")}. Put logger-specific data in context.`
      );
    }

    const level = String(entry.level || "info").toLowerCase();

    if (!LOG_LEVELS.includes(level)) {
      throw new Error(`Logger entry level is invalid: ${level}`);
    }

    if (
      LOG_LEVELS.indexOf(level) <
      LOG_LEVELS.indexOf(this.config.minimumLevel)
    ) {
      return;
    }

    const timestamp = this.formatTimestamp(entry.timestamp);

    const context = entry.context ?? {};

    if (!context || typeof context !== "object" || Array.isArray(context)) {
      throw new TypeError("Logger entry context must be an object");
    }

    const normalizedEntry = {
      timestamp,
      level,
      event: String(entry.event || `${this.name}.event`),
      message: String(entry.message || ""),
      context
    };

    await this.writer.write(this.sanitize(normalizedEntry));
  }

  async flush() {
    await this.writer?.flush?.();
  }

  /** 清除過期檔案。停用的 logger 沒有 writer，什麼都不用做。 */
  async cleanup() {
    await this.writer?.runCleanup?.();
  }
}
