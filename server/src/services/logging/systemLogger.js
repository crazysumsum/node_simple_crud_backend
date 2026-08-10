import { reportInternalFailure } from "../../framework/diagnostics/reportInternalFailure.js";

export class SystemLogger {
  constructor({ logger } = {}) {
    if (!logger || typeof logger.write !== "function") {
      throw new TypeError("SystemLogger requires a Logger");
    }

    this.logger = logger;
  }

  async log(level, event, message, context = {}) {
    const normalizedLevel = String(level).toLowerCase();

    if (!this.logger.enabled) {
      return;
    }

    const entry = {
      level: normalizedLevel,
      event: String(event || "system.event"),
      message: String(message || ""),
      context
    };

    try {
      await this.logger.write(entry);
    } catch (error) {
      // 寫系統日誌失敗不能再走系統日誌，只能落到 stderr 的最後手段。
      reportInternalFailure("logging.system_write_failed", error, {
        droppedEvent: entry.event,
        droppedLevel: entry.level
      });
    }
  }

  debug(event, message, context) {
    return this.log("debug", event, message, context);
  }

  info(event, message, context) {
    return this.log("info", event, message, context);
  }

  warn(event, message, context) {
    return this.log("warn", event, message, context);
  }

  error(event, message, context) {
    return this.log("error", event, message, context);
  }

  async flush() {
    await this.logger.flush();
  }
}
