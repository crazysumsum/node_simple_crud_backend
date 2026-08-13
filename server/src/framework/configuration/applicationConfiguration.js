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

  crossSectionChecks(normalized, details);

  if (details.length > 0) {
    throw new ConfigurationError(details);
  }

  return Object.freeze(normalized);
}

/**
 * 跨設定檔的關係。每個 section 自己都合法，湊在一起卻不成立的那些。
 *
 * 這些關係沒有執行期症狀，所以只能擋在啟動：值排錯了不會報錯，只會讓某一段
 * 沒有上限、或讓某個設定值從此是一句空話。
 */
function crossSectionChecks(normalized, details) {
  const { application, database, requestLimiter } = normalized;

  if (!application || !database) {
    return;
  }

  // DB 那一側必須先於 route 逾時放棄，而且是帶著清理動作放棄的。反過來的話
  // route 逾時先到，回了 504 也釋放了限流槽位，但被放棄的連線等待者還在
  // mysql2 的隊列裡，吊著整個已經回應完畢的請求——這正是隊列會無上限累積的
  // 原因。
  const databaseBudgetMs = database.acquireTimeoutMs + database.queryTimeoutMs;

  if (databaseBudgetMs >= application.requestTimeoutMs) {
    details.push({
      section: "database",
      message:
        `"acquireTimeoutMs" (${database.acquireTimeoutMs}ms) plus "queryTimeoutMs" ` +
        `(${database.queryTimeoutMs}ms) must be shorter than application.requestTimeoutMs ` +
        `(${application.requestTimeoutMs}ms), so the database gives up first and cleans up ` +
        "its connection instead of leaving an abandoned waiter in the pool queue."
    });
  }

  if (!requestLimiter) {
    return;
  }

  // 一個請求同一時間最多佔一個連線等待者。隊列容不下滿載的並行請求數，正常
  // 滿載時就會開始回 503——那不是背壓，是設定錯誤。
  const worstCaseWaiters =
    requestLimiter.maxConcurrentRequests - database.connectionLimit;

  if (database.queueLimit < worstCaseWaiters) {
    details.push({
      section: "database",
      message:
        `"queueLimit" (${database.queueLimit}) must be at least ` +
        `requestLimiter.maxConcurrentRequests (${requestLimiter.maxConcurrentRequests}) ` +
        `minus "connectionLimit" (${database.connectionLimit}) = ${worstCaseWaiters}, ` +
        "or the pool starts rejecting queries at ordinary full load."
    });
  }
}
