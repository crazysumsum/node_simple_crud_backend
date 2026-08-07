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
    "jwt",
    "logging",
    "request",
    "security"
  ]);
  assert.equal(configuration.application.timeZone, "Asia/Hong_Kong");
  assert.equal(configuration.application.requestTimeoutMs, 30000);
  assert.equal(configuration.api.defaults.authType, "jwt");
  assert.equal(configuration.api.defaults.version, "v1");
  assert.equal(configuration.api.versioning.defaultVersion, "v1");
  assert.equal(configuration.api.idempotency.headerName, "Idempotency-Key");
  assert.equal(configuration.api.idempotency.storeAdapter, "memory");
  assert.equal(configuration.logging.loggers.request.filePrefix, "requests");
  assert.equal(configuration.logging.loggers.request.minimumLevel, "info");
  assert.equal(configuration.logging.loggers.system.filePrefix, "system");
  assert.equal(configuration.logging.loggers.system.minimumLevel, "info");
  assert.equal(configuration.request.limits.maxConcurrentRequests, 100);
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
    environment: "production",
    environmentSecret: "production-secret-with-more-than-32-characters"
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
    {
      environment: "production",
      environmentSecret: "production-secret-with-more-than-32-characters"
    }
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
    request: {
      ...source.request,
      limits: { ...source.request.limits, maxQueueSize: -1 }
    }
  };

  assert.throws(
    () => validateApplicationConfiguration(invalidSource),
    (error) => {
      assert.ok(error instanceof ConfigurationError);
      assert.equal(error.code, "CONFIGURATION_INVALID");
      assert.deepEqual(
        error.details.map(({ section }) => section),
        ["application", "api", "database", "request"]
      );
      return true;
    }
  );
});

test("production configuration requires JWT_SECRET from the environment", () => {
  assert.throws(
    () =>
      validateApplicationConfiguration(defaultConfigurationSource(), {
        environment: "production",
        environmentSecret: ""
      }),
    (error) => {
      assert.ok(error instanceof ConfigurationError);
      assert.equal(error.details[0].section, "jwt");
      assert.match(error.details[0].message, /JWT_SECRET is required/);
      return true;
    }
  );
});
