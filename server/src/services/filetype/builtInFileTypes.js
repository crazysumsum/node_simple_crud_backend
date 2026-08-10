import {
  hasAsciiAt,
  isOle2WithStream,
  isOoxml,
  isProbablyText,
  isZipContainer,
  startsWith
} from "../../framework/upload/signatureMatchers.js";

/**
 * 框架預設提供的檔案型別。
 *
 * 專案自訂的型別不要加在這裡——請寫在 FileTypeService.registerCustomTypes()，
 * 那裡是預留給應用層的位置，也不會在框架更新時被覆蓋。
 *
 * 註冊在這裡不代表該型別預設可用：每條 route 的 allowedMimeTypes 才決定實際
 * 允許什麼，預設值在 config/api.js。
 */
export const BUILT_IN_FILE_TYPES = Object.freeze([
  // ---- 文件 ----------------------------------------------------------
  [
    "application/pdf",
    { extensions: [".pdf"], matches: (b) => startsWith(b, [0x25, 0x50, 0x44, 0x46, 0x2d]) }
  ],

  // ---- 影像 ----------------------------------------------------------
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
        startsWith(b, [
          0x52, 0x49, 0x46, 0x46, null, null, null, null, 0x57, 0x45, 0x42, 0x50
        ])
    }
  ],

  // ---- Office 2007 以後（OOXML）---------------------------------------
  // 三者都是 ZIP 容器，簽章比對只能確認它是 OOXML，無法彼此區分：
  // 一個 .xlsx 宣告成 .docx 會通過。
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

  // ---- Office 2003 以前（OLE2 複合文件）--------------------------------
  // OLE2 標頭同時屬於 .xls/.doc/.ppt 與 .msi 安裝檔，因此這裡不只比對容器，
  // 還要求內部存在對應的 CFB stream——MSI 沒有這些 stream，會被擋下。
  // 仍無法分辨 .xls 與同樣含 Workbook stream 的其他 Excel 變體。
  [
    "application/vnd.ms-excel",
    { extensions: [".xls"], matches: isOle2WithStream(["Workbook", "Book"]) }
  ],
  [
    "application/msword",
    { extensions: [".doc"], matches: isOle2WithStream(["WordDocument"]) }
  ],
  [
    "application/vnd.ms-powerpoint",
    {
      extensions: [".ppt"],
      matches: isOle2WithStream(["PowerPoint Document", "Current User"])
    }
  ],

  // ---- 壓縮格式 --------------------------------------------------------
  // 壓縮檔只校驗容器本身，不檢查內容物。允許上傳壓縮檔等於允許上傳其中的
  // 任何東西：解壓縮時要自行處理 zip bomb 與項目名稱的路徑穿越。
  ["application/zip", { extensions: [".zip"], matches: isZipContainer }],
  [
    "application/x-7z-compressed",
    { extensions: [".7z"], matches: (b) => startsWith(b, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]) }
  ],
  [
    "application/vnd.rar",
    {
      extensions: [".rar"],
      // RAR 4.x 以 07 00 結尾，RAR 5.0 以 07 01 00 結尾。
      matches: (b) =>
        startsWith(b, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]) ||
        startsWith(b, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00])
    }
  ],
  [
    "application/gzip",
    {
      // .tar.gz 的副檔名比對只會取到最後一段，所以列 .gz 即可涵蓋。
      extensions: [".gz", ".tgz"],
      matches: (b) => startsWith(b, [0x1f, 0x8b])
    }
  ],
  [
    "application/x-tar",
    // tar 沒有開頭簽章，magic "ustar" 位於位移 257。
    { extensions: [".tar"], matches: (b) => hasAsciiAt(b, 257, "ustar") }
  ],
  [
    "application/x-bzip2",
    { extensions: [".bz2"], matches: (b) => startsWith(b, [0x42, 0x5a, 0x68]) }
  ],
  [
    "application/x-xz",
    { extensions: [".xz"], matches: (b) => startsWith(b, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]) }
  ],

  // ---- 純文字 ----------------------------------------------------------
  // 無簽章可比對，只能排除二進位內容。
  ["text/csv", { extensions: [".csv"], matches: isProbablyText }],
  ["text/plain", { extensions: [".txt"], matches: isProbablyText }]
]);
