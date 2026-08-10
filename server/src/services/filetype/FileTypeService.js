import { BaseService } from "../../framework/services/BaseService.js";
import {
  isOoxml,
  isProbablyText,
  isZipContainer,
  startsWith
} from "../../framework/upload/signatureMatchers.js";
import { BUILT_IN_FILE_TYPES } from "./builtInFileTypes.js";

/**
 * 上傳檔案型別的登錄處。
 *
 * 上傳中間件靠這個 service 判斷「客戶端宣告的型別是否存在、副檔名是否相符、
 * 檔案內容的簽章是否相符」。三者缺一不可——只比對前兩者等於沒有校驗，因為
 * MIME 與副檔名都是呼叫方自己填的字串。
 *
 * 這是一個一般的 application service，由框架的 service discovery 自動載入，
 * 名稱為 "filetypes"。新增型別請往下看 registerCustomTypes()。
 */
export class FileTypeService extends BaseService {
  static service = Object.freeze({
    name: "filetypes",
    lifecycle: "singleton",
    dependencies: [],
    eager: true
  });

  constructor({ config, services, options = {} } = {}) {
    super({ config, services, options });
    this.types = new Map();

    for (const [mimeType, definition] of BUILT_IN_FILE_TYPES) {
      this.register(mimeType, definition);
    }

    this.registerCustomTypes();

    // 測試或組裝時可直接注入，不必改動下面的方法。
    for (const [mimeType, definition] of Object.entries(options.types || {})) {
      this.register(mimeType, definition, { override: true });
    }
  }

  // ---------------------------------------------------------------------
  // 開發者自訂型別
  // ---------------------------------------------------------------------
  /**
   * 在這個方法內新增專案需要、但框架沒有內建的檔案型別。
   * 這裡是預留給應用層的位置，改動不會被框架更新覆蓋。
   *
   * 一個型別由三部分組成：
   *   - MIME type：必須與客戶端宣告的值完全相符，小寫。
   *   - extensions：允許的副檔名，含點號、小寫。第一個會成為落盤時的副檔名。
   *   - matches(buffer)：收到檔案開頭 4096 bytes，回傳 boolean。
   *
   * 可用的比對原語從 framework/upload/signatureMatchers.js 匯入：
   * startsWith、isZipContainer、isOoxml、isOle2Container、isProbablyText。
   *
   * 範例——加入舊版 Excel：
   *
   *   import { isOle2Container } from "../../framework/upload/signatureMatchers.js";
   *
   *   this.register("application/vnd.ms-excel", {
   *     extensions: [".xls"],
   *     matches: isOle2Container
   *   });
   *
   * 加入型別前請先確認兩件事：
   *
   * 1. 這個簽章是否被其他格式共用？OLE2 的開頭同時屬於 .xls、.doc、.ppt 與
   *    .msi 安裝檔，ZIP 的開頭同時屬於 .zip 與所有 OOXML。放行一個等於放行
   *    一整類，要精確分辨得解析容器內部結構。
   * 2. 這是純文字格式嗎？CSV、JSON、XML、SVG 都沒有簽章，isProbablyText 只能
   *    排除二進位內容。SVG 尤其危險，它是 XML 且可以內嵌 <script>——若要允許，
   *    下載時務必強制 attachment 而非 inline。
   */
  registerCustomTypes() {
    // 在此新增專案自訂的檔案型別，例如：
    //
    // this.register("application/vnd.ms-excel", {
    //   extensions: [".xls"],
    //   matches: isOle2Container
    // });
  }

  // ---------------------------------------------------------------------
  // 登錄與查詢
  // ---------------------------------------------------------------------
  /**
   * 註冊一個型別。預設不允許覆蓋既有型別——放寬一個內建型別的校驗規則應該
   * 是明確的決定，不該因為名稱撞號而悄悄發生。
   */
  register(mimeType, definition, { override = false } = {}) {
    const type = String(mimeType || "").toLowerCase().trim();

    if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(type)) {
      throw new Error(`File type MIME type is invalid: ${mimeType}`);
    }

    if (this.types.has(type) && !override) {
      throw new Error(
        `File type is already registered: ${type}. Pass { override: true } to replace it.`
      );
    }

    if (
      !definition ||
      typeof definition !== "object" ||
      typeof definition.matches !== "function"
    ) {
      throw new TypeError(`File type "${type}" must provide a matches(buffer) function`);
    }

    const extensions = Array.isArray(definition.extensions)
      ? definition.extensions.map((extension) => String(extension).toLowerCase())
      : [];

    if (extensions.length === 0 || extensions.some((extension) => !extension.startsWith("."))) {
      throw new Error(
        `File type "${type}" must list at least one extension, each starting with a dot`
      );
    }

    this.types.set(
      type,
      Object.freeze({ extensions: Object.freeze(extensions), matches: definition.matches })
    );
    return this;
  }

  has(mimeType) {
    return this.types.has(String(mimeType || "").toLowerCase());
  }

  supported() {
    return [...this.types.keys()];
  }

  extensionsFor(mimeType) {
    return this.types.get(String(mimeType || "").toLowerCase())?.extensions ?? [];
  }

  /**
   * 宣告型別、副檔名與實際內容三者必須一致。
   * 回傳 null 代表通過，否則回傳可直接對外顯示的原因。
   */
  rejectionReason({ mimeType, fileName, sample }) {
    const type = String(mimeType || "").toLowerCase();
    const definition = this.types.get(type);

    if (!definition) {
      return `unsupported media type: ${type || "unknown"}`;
    }

    const name = String(fileName || "");
    const extension = name.slice(name.lastIndexOf(".")).toLowerCase();

    if (!definition.extensions.includes(extension)) {
      return `file extension does not match ${type}`;
    }

    if (!definition.matches(sample)) {
      return `file content does not match ${type}`;
    }

    return null;
  }
}

// 讓自訂型別能直接從 service 檔案取用原語，不必再回頭找 framework 路徑。
export { isOoxml, isProbablyText, isZipContainer, startsWith };
