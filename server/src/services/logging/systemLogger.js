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
      console.error(`Failed to write system log: ${error.message}`);
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
