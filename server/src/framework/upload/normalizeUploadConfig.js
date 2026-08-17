import path from "node:path";
import { fileURLToPath } from "node:url";

const serverRoot = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * 記憶體緩衝式上傳的單檔上限。
 *
 * 校驗需要完整內容——OLE2 的目錄扇區與 OOXML 的 [Content_Types].xml 都可能落在
 * 檔案尾端——所以每個進行中的檔案都完整佔著記憶體。超過這個大小應該改成串流
 * 落盤，而那需要連比對器的介面一起改成分塊掃描，不是調大一個數字就行。
 */
const MAX_FILE_SIZE_CEILING_BYTES = 104857600;
/** 一個請求最多幾個檔案。上限存在的理由與單檔上限相同：它們相乘。 */
const MAX_FILES_CEILING = 20;

function positiveInteger(value, key, label, { maximum } = {}) {
  const number = Number(value);

  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${label} "${key}" must be a positive integer`);
  }

  // 先前這裡沒有上限，所以 maxFiles: 50 配 maxFileSizeBytes: 100MB 會通過驗證，
  // 而那是每個請求 5GB。設定驗證是唯一能在啟動時擋下它的地方。
  if (maximum !== undefined && number > maximum) {
    throw new Error(
      `${label} "${key}" must not exceed ${maximum}, because uploads are buffered in memory until they are verified`
    );
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

  const maxFileSizeBytes = positiveInteger(
    source.maxFileSizeBytes ?? 10485760,
    "maxFileSizeBytes",
    label,
    { maximum: MAX_FILE_SIZE_CEILING_BYTES }
  );
  const maxFiles = positiveInteger(source.maxFiles ?? 1, "maxFiles", label, {
    maximum: MAX_FILES_CEILING
  });
  const maxFieldCount = positiveInteger(
    source.maxFieldCount ?? 20,
    "maxFieldCount",
    label
  );
  const maxFieldSizeBytes = positiveInteger(
    source.maxFieldSizeBytes ?? 65536,
    "maxFieldSizeBytes",
    label
  );

  // 每個檔案各自受 maxFileSizeBytes 限制，但先前沒有任何東西限制它們的總和：
  // maxFiles 個都剛好貼著上限是完全合法的請求。這是這條 route 一個請求真正
  // 能佔用的記憶體。
  const maxTotalFileBytes = positiveInteger(
    source.maxTotalFileBytes ?? maxFiles * maxFileSizeBytes,
    "maxTotalFileBytes",
    label,
    { maximum: MAX_FILES_CEILING * MAX_FILE_SIZE_CEILING_BYTES }
  );

  if (maxTotalFileBytes < maxFileSizeBytes) {
    throw new Error(
      `${label} "maxTotalFileBytes" (${maxTotalFileBytes}) must be at least "maxFileSizeBytes" (${maxFileSizeBytes}), otherwise no single file can ever be accepted`
    );
  }

  // 整個請求的上限，檔案與文字欄位都算在內。這是唯一一個不必自己做乘法就能
  // 讀懂的數字，也是唯一能在 Content-Length 階段就擋下請求的一個。
  const maxRequestBytes = positiveInteger(
    source.maxRequestBytes ?? maxTotalFileBytes + maxFieldCount * maxFieldSizeBytes,
    "maxRequestBytes",
    label,
    { maximum: MAX_FILES_CEILING * MAX_FILE_SIZE_CEILING_BYTES }
  );

  if (maxRequestBytes < maxTotalFileBytes) {
    throw new Error(
      `${label} "maxRequestBytes" (${maxRequestBytes}) must be at least "maxTotalFileBytes" (${maxTotalFileBytes}); multipart framing alone makes a request larger than its files`
    );
  }

  return Object.freeze({
    enabled,
    directory: path.isAbsolute(directory)
      ? directory
      : path.resolve(serverRoot, directory),
    maxFileSizeBytes,
    maxFiles,
    maxFieldCount,
    maxFieldSizeBytes,
    maxTotalFileBytes,
    maxRequestBytes,
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

/**
 * 全域的上傳設定。這一節不屬於任何一條 route，因為它限制的是整個程序。
 *
 * 每條 route 的 maxRequestBytes 限制得住一個請求，但限制不住同時有幾個請求。
 * 記憶體是兩者的乘積，而被 OOM killer 殺掉的單位是程序，不是請求。
 */
export function normalizeApiUploadConfig(source, label = "API config upload") {
  if (source === null || typeof source !== "object" || Array.isArray(source)) {
    throw new Error(`${label} must be an object`);
  }

  return Object.freeze({
    maxConcurrentUploads: positiveInteger(
      source.maxConcurrentUploads ?? 10,
      "maxConcurrentUploads",
      label,
      { maximum: MAX_FILES_CEILING * 100 }
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

  const normalized = { enabled: source.enabled === true };

  if (source.root === undefined || source.root === null) {
    return Object.freeze(normalized);
  }

  if (typeof source.root !== "string" || !source.root.trim()) {
    throw new Error(`${label} "root" must be a non-empty string`);
  }

  const root = source.root.trim();
  normalized.root = path.isAbsolute(root) ? root : path.resolve(serverRoot, root);

  return Object.freeze(normalized);
}
