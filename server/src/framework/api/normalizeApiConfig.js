import { normalizeIdempotencyConfig } from "../idempotency/normalizeIdempotencyConfig.js";
import { normalizeApiVersioningConfig } from "../versioning/normalizeApiVersioningConfig.js";
import {
  normalizeApiDefaultsConfig,
  plainObject
} from "./normalizeApiDefaultsConfig.js";

export function normalizeApiConfig(source) {
  plainObject(source, "API config");
  const versioning = normalizeApiVersioningConfig(source.versioning);
  const defaults = normalizeApiDefaultsConfig(source.defaults, {
    defaultVersion: versioning.defaultVersion
  });
  const idempotency = normalizeIdempotencyConfig(source.idempotency);

  if (!versioning.supportedVersions.includes(defaults.version)) {
    throw new Error("API defaults version must be listed in supportedVersions");
  }

  return Object.freeze({ defaults, versioning, idempotency });
}
