import { ServiceContainer } from "../services/ServiceContainer.js";

export function createHandlerServices({
  logger,
  loggers,
  mysqlDatabase,
  context,
  custom = {}
} = {}) {
  if (custom === null || typeof custom !== "object" || Array.isArray(custom)) {
    throw new TypeError("Custom handler services must be an object");
  }

  if (!context || typeof context.get !== "function") {
    throw new TypeError("Handler services require a request context service");
  }

  return new ServiceContainer({
    values: {
      ...custom,
      logger,
      loggers,
      mysqldatabase: mysqlDatabase,
      context
    }
  });
}
