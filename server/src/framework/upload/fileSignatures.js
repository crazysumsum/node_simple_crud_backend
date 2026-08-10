// 依檔案實際內容判斷型別。
//
// 客戶端宣告的 Content-Type 與副檔名都是可任意偽造的字串：把 shell script 命名為
// invoice.pdf 並宣告 application/pdf 完全不需要技巧。允許清單若只比對這兩者，
// 等於沒有校驗。因此每一種型別都必須同時通過簽章比對。

const NUL = 0x00;

/**
 * OOXML（xlsx/docx/pptx）都是 ZIP 容器，僅靠 PK 簽章無法分辨彼此，也無法與
 * 一般 ZIP 區分。這裡額外要求開頭附近出現 [Content_Types].xml——那是 OOXML
 * 規範要求存在的項目，且慣例上是第一個 entry。
 */
const OOXML_MARKER = Buffer.from("[Content_Types].xml", "ascii");

function startsWith(buffer, bytes) {
  if (buffer.length < bytes.length) {
    return false;
  }

  return bytes.every((byte, index) => byte === null || buffer[index] === byte);
}

function isZipContainer(buffer) {
  // 本機檔案標頭 PK\x03\x04；空壓縮檔為 PK\x05\x06。
  return (
    startsWith(buffer, [0x50, 0x4b, 0x03, 0x04]) ||
    startsWith(buffer, [0x50, 0x4b, 0x05, 0x06])
  );
}

function isOoxml(buffer) {
  return isZipContainer(buffer) && buffer.includes(OOXML_MARKER);
}

/**
 * 文字格式沒有簽章可比對，只能反過來排除二進位內容：拒絕 NUL 位元組，並要求
 * 開頭能以 UTF-8 解碼。這比二進位型別弱，README 有說明這個限制。
 */
function isProbablyText(buffer) {
  if (buffer.includes(NUL)) {
    return false;
  }

  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return true;
  } catch {
    // 取樣可能切在多位元組字元中間，退一步只檢查控制字元。
    return !buffer.some(
      (byte) => byte < 0x09 || (byte > 0x0d && byte < 0x20 && byte !== 0x1b)
    );
  }
}

// MIME type -> { extensions, matches(buffer) }
const SIGNATURES = new Map([
  [
    "application/pdf",
    { extensions: [".pdf"], matches: (b) => startsWith(b, [0x25, 0x50, 0x44, 0x46, 0x2d]) }
  ],
  [
    "image/png",
    {
      extensions: [".png"],
      matches: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    }
  ],
  [
    "image/jpeg",
    { extensions: [".jpg", ".jpeg"], matches: (b) => startsWith(b, [0xff, 0xd8, 0xff]) }
  ],
  [
    "image/gif",
    {
      extensions: [".gif"],
      matches: (b) =>
        startsWith(b, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
        startsWith(b, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
    }
  ],
  [
    "image/webp",
    {
      extensions: [".webp"],
      matches: (b) =>
        startsWith(b, [0x52, 0x49, 0x46, 0x46, null, null, null, null, 0x57, 0x45, 0x42, 0x50])
    }
  ],
  [
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    { extensions: [".xlsx"], matches: isOoxml }
  ],
  [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    { extensions: [".docx"], matches: isOoxml }
  ],
  [
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    { extensions: [".pptx"], matches: isOoxml }
  ],
  ["application/zip", { extensions: [".zip"], matches: isZipContainer }],
  ["text/csv", { extensions: [".csv"], matches: isProbablyText }],
  ["text/plain", { extensions: [".txt"], matches: isProbablyText }]
]);

// 判斷型別所需的前導位元組數。OOXML 的 marker 不在最前面，所以要多取一些。
export const SIGNATURE_SAMPLE_BYTES = 4096;

export function isSupportedMimeType(mimeType) {
  return SIGNATURES.has(mimeType);
}

export function supportedMimeTypes() {
  return [...SIGNATURES.keys()];
}

export function extensionsFor(mimeType) {
  return SIGNATURES.get(mimeType)?.extensions ?? [];
}

/**
 * 宣告型別、副檔名與實際內容三者必須一致，任何一項不符即拒絕。
 * 回傳 null 代表通過，否則回傳可直接對外顯示的原因。
 */
export function rejectionReason({ mimeType, fileName, sample }) {
  const signature = SIGNATURES.get(mimeType);

  if (!signature) {
    return `unsupported media type: ${mimeType}`;
  }

  const extension = String(fileName || "")
    .slice(String(fileName || "").lastIndexOf("."))
    .toLowerCase();

  if (!signature.extensions.includes(extension)) {
    return `file extension does not match ${mimeType}`;
  }

  if (!signature.matches(sample)) {
    return `file content does not match ${mimeType}`;
  }

  return null;
}
