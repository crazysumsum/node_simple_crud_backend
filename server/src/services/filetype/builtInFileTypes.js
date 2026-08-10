import {
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
 */
export const BUILT_IN_FILE_TYPES = Object.freeze([
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
        startsWith(b, [
          0x52, 0x49, 0x46, 0x46, null, null, null, null, 0x57, 0x45, 0x42, 0x50
        ])
    }
  ],
  // 以下三種都是 ZIP 容器，簽章比對只能確認它是 OOXML，無法彼此區分。
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
  // 純文字格式無簽章可比對，只能排除二進位內容。
  ["text/csv", { extensions: [".csv"], matches: isProbablyText }],
  ["text/plain", { extensions: [".txt"], matches: isProbablyText }]
]);
