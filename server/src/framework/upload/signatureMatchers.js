// 撰寫檔案簽章比對時可重複使用的原語。
//
// 客戶端宣告的 Content-Type 與副檔名都是可任意偽造的字串：把 shell script 命名為
// invoice.pdf 並宣告 application/pdf 完全不需要技巧。允許清單若只比對這兩者，
// 等於沒有校驗，因此每一種型別都必須同時通過內容簽章比對。
//
// 型別清單本身不在這裡，而在 FileTypeService（server/src/services/filetype/）。
// 框架只提供比對工具，實際支援哪些型別由應用層決定。
//
// matches(buffer) 收到的是完整檔案內容。上傳中間件在校驗前就把整個檔案讀進
// 記憶體（受 maxFileSizeBytes 限制），所以像 OLE2 那種特徵不在開頭的格式，
// 比對器可以掃描整份內容而不必猜取樣長度。

const NUL = 0x00;
// 需要逐位元組解碼時只看開頭這麼多，避免對 10MB 檔案做完整 UTF-8 解碼。
const TEXT_DECODE_SAMPLE_BYTES = 65536;

/**
 * 比對開頭位元組。陣列中的 null 代表該位置不比對，用於 RIFF 這類中間夾著
 * 長度欄位的格式。
 */
export function startsWith(buffer, bytes) {
  if (buffer.length < bytes.length) {
    return false;
  }

  return bytes.every((byte, index) => byte === null || buffer[index] === byte);
}

/** 比對檔案中固定位移處的 ASCII 字串，例如 tar 在 257 的 "ustar"。 */
export function hasAsciiAt(buffer, offset, text) {
  return buffer.subarray(offset, offset + text.length).toString("latin1") === text;
}

/** ZIP 本機檔案標頭 PK\x03\x04，或空壓縮檔 PK\x05\x06。 */
export function isZipContainer(buffer) {
  return (
    startsWith(buffer, [0x50, 0x4b, 0x03, 0x04]) ||
    startsWith(buffer, [0x50, 0x4b, 0x05, 0x06])
  );
}

const OOXML_MARKER = Buffer.from("[Content_Types].xml", "ascii");

/**
 * OOXML（xlsx/docx/pptx）都是 ZIP 容器，僅靠 PK 簽章無法分辨彼此，也無法與
 * 一般 ZIP 區分。這裡額外要求出現 [Content_Types].xml——OOXML 規範要求它存在，
 * 慣例上也是第一個 entry。注意它仍然無法區分 xlsx 與 docx。
 */
export function isOoxml(buffer) {
  return isZipContainer(buffer) && buffer.includes(OOXML_MARKER);
}

/**
 * OLE2 複合文件的容器標頭。.xls、.doc、.ppt 與 .msi 安裝檔共用這個開頭，
 * 所以單獨使用它等於同時放行可執行的安裝程式。要分辨實際格式請用
 * isOle2WithStream()。
 */
export function isOle2Container(buffer) {
  return startsWith(buffer, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
}

/**
 * OLE2 容器，且內部存在指定名稱的 stream。
 *
 * CFB 的目錄項目名稱以 UTF-16LE 儲存，Excel 活頁簿帶 "Workbook"、Word 帶
 * "WordDocument"、PowerPoint 帶 "PowerPoint Document"，MSI 安裝檔都沒有。
 * 這讓「舊版 Office」與「任何 OLE2 檔案」得以區分。
 *
 * 目錄扇區的位置由標頭決定，大檔案時可能落在檔案尾端，因此必須掃描完整內容。
 */
export function isOle2WithStream(streamNames) {
  const markers = streamNames.map((name) => Buffer.from(name, "utf16le"));

  return (buffer) =>
    isOle2Container(buffer) && markers.some((marker) => buffer.includes(marker));
}

/**
 * 文字格式沒有簽章可比對，只能反過來排除二進位內容。這比二進位型別弱得多：
 * 它擋得住偽裝成 CSV 的執行檔，擋不住 CSV 內的公式注入。
 */
export function isProbablyText(buffer) {
  // NUL 檢查掃描整份內容——只有開頭是文字、後段塞二進位的檔案要擋下來。
  if (buffer.includes(NUL)) {
    return false;
  }

  const sample = buffer.subarray(0, TEXT_DECODE_SAMPLE_BYTES);

  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample);
    return true;
  } catch {
    // 取樣可能切在多位元組字元中間，退一步只檢查控制字元。
    return !sample.some(
      (byte) => byte < 0x09 || (byte > 0x0d && byte < 0x20 && byte !== 0x1b)
    );
  }
}
