// 撰寫檔案簽章比對時可重複使用的原語。
//
// 客戶端宣告的 Content-Type 與副檔名都是可任意偽造的字串：把 shell script 命名為
// invoice.pdf 並宣告 application/pdf 完全不需要技巧。允許清單若只比對這兩者，
// 等於沒有校驗，因此每一種型別都必須同時通過內容簽章比對。
//
// 型別清單本身不在這裡，而在 FileTypeService（server/src/services/filetype/）。
// 框架只提供比對工具，實際支援哪些型別由應用層決定。

const NUL = 0x00;

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
 * OLE2 複合文件。.xls、.doc、.ppt 與 .msi 安裝檔共用這個開頭，所以只憑它
 * 放行等於同時放行可執行的安裝程式——要真正分辨必須解析 CFB 目錄結構。
 */
export function isOle2Container(buffer) {
  return startsWith(buffer, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
}

/**
 * 文字格式沒有簽章可比對，只能反過來排除二進位內容。這比二進位型別弱得多：
 * 它擋得住偽裝成 CSV 的執行檔，擋不住 CSV 內的公式注入。
 */
export function isProbablyText(buffer) {
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

/** 交給 matches() 的檔案開頭位元組數。 */
export const SIGNATURE_SAMPLE_BYTES = 4096;
