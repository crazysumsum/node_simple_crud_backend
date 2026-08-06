import jwtConfig from "../../../config/jwt.js";
import { ServiceContainer } from "../services/ServiceContainer.js";
import { verifyAccessToken } from "./jwtService.js";

export function createAuthStrategyServices({
  logger,
  loggers,
  config = jwtConfig,
  verifyToken = (token) => verifyAccessToken(token, { config }),
  custom = {}
} = {}) {
  if (custom === null || typeof custom !== "object" || Array.isArray(custom)) {
    throw new TypeError("Custom authentication strategy services must be an object");
  }

  if (typeof verifyToken !== "function") {
    throw new TypeError("Authentication verifyToken service must be a function");
  }

  return new ServiceContainer({
    values: {
      ...custom,
      logger,
      loggers,
      jwtConfig: config,
      verifyToken
    }
  });
}
