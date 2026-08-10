import { BaseRequestHandler } from "./BaseRequestHandler.js";
import {
  cloneData,
  deepFreeze,
  normalizeApiDefaultsConfig,
  plainObject
} from "./normalizeApiDefaultsConfig.js";

const REQUIRED_API_FIELDS = [
  "method",
  "path",
  "description",
  "requestSchema",
  "responseSchema"
];
const ALLOWED_API_FIELDS = new Set([
  ...REQUIRED_API_FIELDS,
  "version",
  "authType",
  "authorizationPolicies",
  "deprecation",
  "idempotency",
  "logging",
  "upload",
  "download",
  "timeoutMs"
]);

function mergeObject(defaultValue, overrideValue, label) {
  if (overrideValue === undefined) {
    return cloneData(defaultValue, label);
  }

  plainObject(overrideValue, label);
  return {
    ...cloneData(defaultValue, `${label} defaults`),
    ...cloneData(overrideValue, label)
  };
}

export function resolveApiDefinitions(handlers, defaults) {
  plainObject(handlers, "Handler registry");
  const normalizedDefaults = normalizeApiDefaultsConfig(defaults);
  const routes = [];

  for (const [handlerName, handler] of Object.entries(handlers)) {
    if (!(handler instanceof BaseRequestHandler)) {
      throw new TypeError(`Handler registry entry "${handlerName}" is invalid`);
    }

    const source = handler.constructor.api;
    plainObject(source, `${handler.constructor.name}.static api`);

    const unknownFields = Object.keys(source).filter(
      (field) => !ALLOWED_API_FIELDS.has(field)
    );

    if (unknownFields.length > 0) {
      throw new Error(
        `${handler.constructor.name}.static api contains unknown fields: ${unknownFields.join(", ")}`
      );
    }

    for (const field of REQUIRED_API_FIELDS) {
      if (!Object.hasOwn(source, field) || source[field] === undefined) {
        throw new Error(
          `${handler.constructor.name} must define static api.${field}`
        );
      }
    }

    for (const [field, value] of Object.entries(source)) {
      if (value === undefined) {
        throw new Error(`${handler.constructor.name}.static api.${field} is undefined`);
      }
    }

    const override = cloneData(source, `${handler.constructor.name}.static api`);
    const route = {
      ...cloneData(normalizedDefaults, "API defaults"),
      ...override,
      authorizationPolicies:
        override.authorizationPolicies === undefined
          ? cloneData(
              normalizedDefaults.authorizationPolicies,
              "API defaults authorizationPolicies"
            )
          : override.authorizationPolicies,
      deprecation: mergeObject(
        normalizedDefaults.deprecation,
        override.deprecation,
        `${handler.constructor.name}.static api.deprecation`
      ),
      idempotency: mergeObject(
        normalizedDefaults.idempotency,
        override.idempotency,
        `${handler.constructor.name}.static api.idempotency`
      ),
      logging: mergeObject(
        normalizedDefaults.logging,
        override.logging,
        `${handler.constructor.name}.static api.logging`
      ),
      upload: mergeObject(
        normalizedDefaults.upload,
        override.upload,
        `${handler.constructor.name}.static api.upload`
      ),
      download: mergeObject(
        normalizedDefaults.download,
        override.download,
        `${handler.constructor.name}.static api.download`
      ),
      requestSchema: override.requestSchema,
      responseSchema: override.responseSchema,
      handler: handlerName
    };

    routes.push(deepFreeze(route));
  }

  return Object.freeze(routes);
}
