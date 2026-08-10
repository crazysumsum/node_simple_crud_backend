import path from "node:path";
import { fileURLToPath } from "node:url";
import { isSupportedMimeType, supportedMimeTypes } from "./fileSignatures.js";

const serverRoot = fileURLToPath(new URL("../../../", import.meta.url));

function positiveInteger(value, key, label) {
  const number = Number(value);

  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${label} "${key}" must be a positive integer`);
  }

  return number;
}

function permissionMode(value, key, label, fallback) {
  if (value === undefined || value === null) {
    return fallback;
  }

  const mode = typeof value === "string" ? Number.parseInt(value, 8) : Number(value);

  if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) {
    throw new Error(`${label} "${key}" must be a file mode between 0o000 and 0o777`);
  }

  return mode;
}

/**
 * 上傳設定的正規化。allowedMimeTypes 只接受框架能做內容簽章比對的型別——
 * 若允許任意字串，開發者會以為加進清單就等於受到校驗，實際上只是比對了
 * 客戶端自己宣告的值。
 */
export function normalizeUploadConfig(source, label = "API defaults config upload") {
  if (source === null || typeof source !== "object" || Array.isArray(source)) {
    throw new Error(`${label} must be an object`);
  }

  const enabled = source.enabled === true;
  const allowedMimeTypes = Array.isArray(source.allowedMimeTypes)
    ? [...new Set(source.allowedMimeTypes.map((type) => String(type).toLowerCase().trim()))]
    : null;

  if (!allowedMimeTypes || allowedMimeTypes.length === 0) {
    throw new Error(`${label} "allowedMimeTypes" must be a non-empty array`);
  }

  const unsupported = allowedMimeTypes.filter((type) => !isSupportedMimeType(type));

  if (unsupported.length > 0) {
    throw new Error(
      `${label} "allowedMimeTypes" contains types the framework cannot verify by content: ${unsupported.join(", ")}. Supported: ${supportedMimeTypes().join(", ")}`
    );
  }

  const directory = String(source.directory || "").trim();

  if (!directory) {
    throw new Error(`${label} "directory" must be a non-empty string`);
  }

  return Object.freeze({
    enabled,
    directory: path.isAbsolute(directory)
      ? directory
      : path.resolve(serverRoot, directory),
    maxFileSizeBytes: positiveInteger(
      source.maxFileSizeBytes ?? 10485760,
      "maxFileSizeBytes",
      label
    ),
    maxFiles: positiveInteger(source.maxFiles ?? 1, "maxFiles", label),
    maxFieldCount: positiveInteger(
      source.maxFieldCount ?? 20,
      "maxFieldCount",
      label
    ),
    allowedMimeTypes: Object.freeze(allowedMimeTypes),
    fileMode: permissionMode(source.fileMode, "fileMode", label, 0o600),
    directoryMode: permissionMode(
      source.directoryMode,
      "directoryMode",
      label,
      0o700
    )
  });
}

export function normalizeDownloadConfig(
  source,
  label = "API defaults config download"
) {
  if (source === null || typeof source !== "object" || Array.isArray(source)) {
    throw new Error(`${label} must be an object`);
  }

  return Object.freeze({ enabled: source.enabled === true });
}
