import { Logger } from "./Logger.js";

export class LoggerRegistry {
  constructor({ configs, loggerFactory, time } = {}) {
    if (!configs || typeof configs !== "object" || Array.isArray(configs)) {
      throw new TypeError("LoggerRegistry configs must be an object");
    }

    const createLogger =
      loggerFactory ||
      ((name, config) => new Logger({ name, config, time }));

    if (typeof createLogger !== "function") {
      throw new TypeError("LoggerRegistry loggerFactory must be a function");
    }

    this.loggers = new Map(
      Object.entries(configs).map(([name, config]) => [
        name,
        createLogger(name, config)
      ])
    );
  }

  get(name) {
    return this.loggers.get(name);
  }

  require(name) {
    const logger = this.get(name);

    if (!logger) {
      throw new Error(`Logger is not registered: ${name}`);
    }

    return logger;
  }

  names() {
    return [...this.loggers.keys()];
  }

  async flush() {
    await Promise.all([...this.loggers.values()].map((logger) => logger.flush()));
  }

  async cleanup() {
    await Promise.all([...this.loggers.values()].map((logger) => logger.cleanup?.()));
  }
}
