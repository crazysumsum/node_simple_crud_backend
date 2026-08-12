import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultConfigurationSource,
  validateApplicationConfiguration
} from "../src/framework/configuration/applicationConfiguration.js";
import { ConfigurationError } from "../src/framework/configuration/ConfigurationError.js";

test("global configuration validation normalizes every configuration section", () => {
  const configuration = validateApplicationConfiguration(
    defaultConfigurationSource()
  );

  assert.deepEqual(Object.keys(configuration).sort(), [
    "api",
    "application",
    "database",
    // idempotency 也是一個 service，設定自己一個區塊、自己一個檔案。
    "idempotency",
    "jwt",
    "logging",
    "request",
    // 限流器是一個 service，所以它的設定自己一個區塊、自己一個檔案。
    "requestLimiter",
    "scheduler",
    "security",
    // 撤銷也是一個 service，所以設定自己一個區塊、自己一個檔案。
    "tokenRevocation"
  ]);
  assert.equal(configuration.application.timeZone, "Asia/Hong_Kong");
  assert.equal(configuration.application.requestTimeoutMs, 30000);
  assert.equal(configuration.api.defaults.authType, "jwt");
  assert.equal(configuration.api.defaults.version, "v1");
  assert.equal(configuration.api.versioning.defaultVersion, "v1");
  assert.equal(configuration.idempotency.headerName, "Idempotency-Key");
  // 預設是 mysql：memory adapter 的狀態在各自的行程裡，多實例部署下同一個 key
  // 打到不同實例會各自執行一次，而那是負載平衡下的常態。
  assert.equal(configuration.idempotency.storeAdapter, "mysql");
  assert.equal(configuration.logging.loggers.request.filePrefix, "requests");
  assert.equal(configuration.logging.loggers.request.minimumLevel, "info");
  assert.equal(configuration.logging.loggers.system.filePrefix, "system");
  assert.equal(configuration.logging.loggers.system.minimumLevel, "info");
  assert.equal(configuration.requestLimiter.maxConcurrentRequests, 100);
  assert.equal(configuration.request.validation.input.enabled, true);
  assert.equal(configuration.request.validation.output.runtimeEnabled, true);
  assert.equal(Object.isFrozen(configuration), true);
  assert.equal(Object.isFrozen(configuration.database), true);
  assert.equal(Object.isFrozen(configuration.logging.loggers), true);
});

test("logging configuration accepts additional named logger profiles", () => {
  const source = defaultConfigurationSource();
  const configuration = validateApplicationConfiguration({
    ...source,
    logging: {
      ...source.logging,
      loggers: {
        ...source.logging.loggers,
        audit: {
          ...source.logging.loggers.system,
          directory: "logs/audit",
          filePrefix: "audit"
        }
      }
    }
  });

  assert.equal(configuration.logging.loggers.audit.filePrefix, "audit");
  assert.match(configuration.logging.loggers.audit.directory, /logs\/audit$/);
});

test("production response validation is secure by default and can be explicitly disabled", () => {
  const source = defaultConfigurationSource();
  const enabled = validateApplicationConfiguration(source, {
    environment: "production"
  });
  const disabled = validateApplicationConfiguration(
    {
      ...source,
      request: {
        ...source.request,
        validation: {
          ...source.request.validation,
          output: {
            ...source.request.validation.output,
            validateInProduction: false
          }
        }
      }
    },
    { environment: "production" }
  );

  assert.equal(enabled.request.validation.output.runtimeEnabled, true);
  assert.equal(disabled.request.validation.output.runtimeEnabled, false);
});

test("API defaults inherit the merged versioning default", () => {
  const source = defaultConfigurationSource();
  const configuration = validateApplicationConfiguration({
    ...source,
    api: {
      ...source.api,
      versioning: {
        ...source.api.versioning,
        defaultVersion: "v2",
        supportedVersions: ["v1", "v2"]
      }
    }
  });

  assert.equal(configuration.api.versioning.defaultVersion, "v2");
  assert.equal(configuration.api.defaults.version, "v2");
});

test("global configuration validation reports errors from multiple sections", () => {
  const source = defaultConfigurationSource();
  const invalidSource = {
    ...source,
    application: {
      ...source.application,
      port: 70000,
      timeZone: "Invalid/TimeZone",
      requestTimeoutMs: 0
    },
    api: {
      ...source.api,
      defaults: { ...source.api.defaults, timeoutMs: 0 }
    },
    database: { ...source.database, connectionLimit: 0 },
    requestLimiter: { ...source.requestLimiter, maxQueueSize: -1 }
  };

  assert.throws(
    () => validateApplicationConfiguration(invalidSource),
    (error) => {
      assert.ok(error instanceof ConfigurationError);
      assert.equal(error.code, "CONFIGURATION_INVALID");
      assert.deepEqual(
        error.details.map(({ section }) => section),
        ["application", "api", "database", "requestLimiter"]
      );
      return true;
    }
  );
});

test("every environment requires JWT_SECRET, not just production", () => {
  const source = defaultConfigurationSource();
  // 沒有 JWT_SECRET 時，config/jwt.js 的 secret 就是 undefined。
  const withoutSecret = { ...source, jwt: { ...source.jwt, secret: undefined } };

  // development 是 NODE_ENV 未設定時的預設值，正是舊實作會靜默放行的情況。
  for (const environment of ["development", "test", "staging", "production"]) {
    assert.throws(
      () => validateApplicationConfiguration(withoutSecret, { environment }),
      (error) => {
        assert.ok(error instanceof ConfigurationError);
        assert.equal(error.details[0].section, "jwt");
        assert.match(error.details[0].message, /JWT_SECRET is required/);
        return true;
      },
      `expected ${environment} to reject a missing JWT_SECRET`
    );
  }

  // 空白字元不算有效密鑰。
  assert.throws(
    () =>
      validateApplicationConfiguration({
        ...source,
        jwt: { ...source.jwt, secret: "   " }
      }),
    ConfigurationError
  );
});

test("configuration ships no fallback JWT secret", async () => {
  const { default: jwtConfig } = await import("../config/jwt.js");

  // 寫死的密鑰等同公開，任何人都能據此簽發任意 role 的 Token。
  assert.equal(jwtConfig.secret, process.env.JWT_SECRET);
  assert.ok(
    !Object.hasOwn(jwtConfig, "requireEnvironmentSecretInProduction"),
    "the NODE_ENV-gated opt-out must not come back"
  );
});
