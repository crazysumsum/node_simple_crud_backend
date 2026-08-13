import { normalizeApiUploadConfig } from "../upload/normalizeUploadConfig.js";
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

  // upload 在這裡而不是在 defaults 底下：defaults 是每條 route 的預設值，而
  // 同時解析數限制的是整個程序，沒有 per-route 的意義。
  const upload = normalizeApiUploadConfig(source.upload ?? {});

  // idempotency 是一個 service，設定自己一個區塊、自己一個檔案。
  return Object.freeze({ defaults, versioning, upload });
}
