import applicationConfig from "../../../config/application.js";
import apiConfig from "../../../config/api.js";
import databaseConfig from "../../../config/database.js";
import idempotencyConfig from "../../../config/idempotency.js";
import jwtConfig from "../../../config/jwt.js";
import loggingConfig from "../../../config/logging.js";
import requestConfig from "../../../config/request.js";
import requestLimiterConfig from "../../../config/requestLimiter.js";
import schedulerConfig from "../../../config/scheduler.js";
import securityConfig from "../../../config/security.js";
import tokenRevocationConfig from "../../../config/tokenRevocation.js";
import { normalizeLoggingConfig } from "../../services/logging/normalizeLoggingConfig.js";
import { normalizeSecurityConfig } from "../security/normalizeSecurityConfig.js";
import { normalizeApiConfig } from "../api/normalizeApiConfig.js";
import { ConfigurationError } from "./ConfigurationError.js";
import { normalizeApplicationConfig } from "./normalizeApplicationConfig.js";
import { normalizeDatabaseConfig } from "./normalizeDatabaseConfig.js";
import { normalizeIdempotencyConfig } from "../../services/idempotency/normalizeIdempotencyConfig.js";
import { normalizeJwtConfig } from "./normalizeJwtConfig.js";
import { normalizeRequestConfig } from "./normalizeRequestConfig.js";
import { normalizeRequestLimiterConfig } from "../../services/requestLimiter/normalizeRequestLimiterConfig.js";
import { normalizeSchedulerConfig } from "../../services/scheduler/normalizeSchedulerConfig.js";
import { normalizeTokenRevocationConfig } from "../../services/tokenRevocation/normalizeTokenRevocationConfig.js";

export function defaultConfigurationSource() {
  return {
    application: applicationConfig,
    api: apiConfig,
    database: databaseConfig,
    idempotency: idempotencyConfig,
    jwt: jwtConfig,
    logging: loggingConfig,
    request: requestConfig,
    requestLimiter: requestLimiterConfig,
    scheduler: schedulerConfig,
    security: securityConfig,
    tokenRevocation: tokenRevocationConfig
  };
}

export function validateApplicationConfiguration(
  source = defaultConfigurationSource(),
  { environment = process.env.NODE_ENV || "development" } = {}
) {
  const details = [];
  const normalized = {};
  const validateSection = (section, validator) => {
    try {
      normalized[section] = validator();
    } catch (error) {
      details.push({ section, message: error.message });
    }
  };

  validateSection("application", () =>
    normalizeApplicationConfig(source?.application)
  );
  validateSection("api", () => normalizeApiConfig(source?.api));
  validateSection("database", () => normalizeDatabaseConfig(source?.database));
  validateSection("idempotency", () =>
    normalizeIdempotencyConfig(source?.idempotency)
  );
  validateSection("jwt", () => normalizeJwtConfig(source?.jwt));
  validateSection("logging", () => normalizeLoggingConfig(source?.logging));
  validateSection("request", () =>
    normalizeRequestConfig(source?.request, { environment })
  );
  validateSection("requestLimiter", () =>
    normalizeRequestLimiterConfig(source?.requestLimiter)
  );
  validateSection("scheduler", () => normalizeSchedulerConfig(source?.scheduler));
  validateSection("security", () => normalizeSecurityConfig(source?.security));
  validateSection("tokenRevocation", () =>
    normalizeTokenRevocationConfig(source?.tokenRevocation)
  );

  if (details.length > 0) {
    throw new ConfigurationError(details);
  }

  return Object.freeze(normalized);
}
