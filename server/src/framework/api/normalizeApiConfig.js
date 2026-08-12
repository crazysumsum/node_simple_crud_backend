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
  if (!versioning.supportedVersions.includes(defaults.version)) {
    throw new Error("API defaults version must be listed in supportedVersions");
  }

  // idempotency 是一個 service，設定自己一個區塊、自己一個檔案。
  return Object.freeze({ defaults, versioning });
}
