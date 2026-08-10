import path from "node:path";
import { fileURLToPath } from "node:url";

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
 * 上傳設定的正規化。
 *
 * allowedMimeTypes 只接受能做內容簽章比對的型別——若允許任意字串，開發者會
 * 以為加進清單就等於受到校驗，實際上只是比對了客戶端自己宣告的值。這項檢查
 * 需要 FileTypeService，而設定正規化早於 service 容器建立，因此 fileTypes
 * 為選填：dispatcher 在註冊每條 route 時一定會帶入，仍然是啟動期就失敗。
 */
export function normalizeUploadConfig(
  source,
  label = "API defaults config upload",
  fileTypes = null
) {
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

  if (fileTypes) {
    const unsupported = allowedMimeTypes.filter((type) => !fileTypes.has(type));

    if (unsupported.length > 0) {
      throw new Error(
        `${label} "allowedMimeTypes" contains types that cannot be verified by content: ${unsupported.join(", ")}. Register them in FileTypeService.registerCustomTypes(). Currently registered: ${fileTypes.supported().join(", ")}`
      );
    }
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
