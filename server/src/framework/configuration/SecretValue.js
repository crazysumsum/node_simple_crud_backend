import { inspect } from "node:util";

/**
 * 設定裡的密鑰值。
 *
 * 每個 service 都會收到整份應用設定，所以 config.jwt.secret 與
 * config.database.password 從任何地方都讀得到。真正會出事的不是有人刻意去讀，
 * 而是有人把設定物件整包寫進日誌或錯誤 context——日誌保留 30 天，而錯誤狀態
 * 下連完整 body 都會落盤。
 *
 * 因此這裡把「序列化」與「取值」分開：
 *
 * - toJSON()、util.inspect、String 化的檢視路徑一律得到 [REDACTED]，
 *   意外記錄密鑰在結構上就不可能發生。
 * - 真的要用值必須明寫 reveal()。這擋不住刻意行為，也不打算擋——第一方程式碼
 *   之間沒有這種邊界。但它讓取用密鑰變成一個可以 grep、code review 看得見的
 *   動作，而不是一個屬性存取。
 *
 * Symbol.toPrimitive 刻意拋錯而不是回傳 [REDACTED]。若字串強制轉換會靜默給出
 * 佔位字串，`jwt.sign(payload, config.jwt.secret)` 這種漏寫 reveal() 的程式碼
 * 會拿字面上的 "[REDACTED]" 去簽章：token 全部簽錯、驗證全部失敗，而且沒有
 * 任何錯誤訊息指向原因。大聲失敗遠比那個好。
 */
const REDACTED = "[REDACTED]";

export class SecretValue {
  #value;

  constructor(value, label = "secret") {
    this.#value = String(value ?? "");
    this.label = String(label);
    Object.freeze(this);
  }

  /** 取出真正的值。這是唯一的出口，刻意寫得顯眼。 */
  reveal() {
    return this.#value;
  }

  get length() {
    return this.#value.length;
  }

  toJSON() {
    return REDACTED;
  }

  [inspect.custom]() {
    return `SecretValue(${this.label}) ${REDACTED}`;
  }

  [Symbol.toPrimitive]() {
    throw new TypeError(
      `${this.label} is a SecretValue and cannot be coerced to a string. Call reveal() where the value is genuinely needed.`
    );
  }
}

/** 已經是 SecretValue 就原樣返回，避免重複正規化時包了兩層。 */
export function secretValue(value, label) {
  return value instanceof SecretValue ? value : new SecretValue(value, label);
}

/**
 * 取出原始字串，不論拿到的是 SecretValue 還是還沒包裝的原始值。
 * 正規化器會被套用在已正規化的設定上（JwtService 就會再跑一次），所以每個
 * 讀取密鑰的地方都必須同時接受兩種形式，否則 Symbol.toPrimitive 會拋錯。
 */
export function revealSecret(value) {
  return value instanceof SecretValue ? value.reveal() : String(value ?? "");
}
