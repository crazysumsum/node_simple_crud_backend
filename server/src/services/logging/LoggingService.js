import { BaseService } from "../../framework/services/BaseService.js";
import { createRequestLogger } from "../../framework/middleware/requestLogger.js";
import { LoggerRegistry } from "./LoggerRegistry.js";
import { SystemLogger } from "./systemLogger.js";

export class LoggingService extends BaseService {
  static service = Object.freeze({
    name: "logging",
    lifecycle: "singleton",
    dependencies: ["time"],
    eager: true
  });

  constructor({ config, services, options = {} } = {}) {
    super({ config, services, options });

    this.time = services.require("time");
    this.loggers =
      options.loggerRegistry ||
      new LoggerRegistry({ configs: config.logging.loggers, time: this.time });
    this.loggerManagedByRegistry = !options.logger;
    this.logger =
      options.logger ||
      new SystemLogger({ logger: this.loggers.require("system") });
    this.requestMiddleware =
      options.requestLogger ||
      createRequestLogger({ logger: this.loggers.require("request"), time: this.time });
  }

  require(name) {
    return this.loggers.require(name);
  }

  async shutdown() {
    if (!this.loggerManagedByRegistry) {
      await this.logger.flush?.();
    }

    await this.loggers.flush();
  }
}
