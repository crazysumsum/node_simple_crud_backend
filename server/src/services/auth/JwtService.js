import jwt from "jsonwebtoken";
import { normalizeJwtConfig } from "../../framework/configuration/normalizeJwtConfig.js";
import { BaseService } from "../../framework/services/BaseService.js";

/**
 * 簽發與驗證 JWT 的服務。
 *
 * 這原本是 framework/auth/jwtService.js 的一組模組層級函式，靠 `config = jwtConfig`
 * 的預設參數直接讀設定檔，再由 Application Factory 手動註冊成 `jwtConfig` 與
 * `verifyToken` 兩個 container value。那是框架裡的特例：它是不折不扣的 service
 * ——持有設定、提供操作、單例——卻沒有走 service 的任何一條路。
 *
 * 正規化後的設定放在私有欄位：呼叫端要的是 issue()／verify() 與 header 怎麼讀，
 * 沒有任何一個需要 secret。這只收窄這個 service 自己的介面——每個 service 都會
 * 收到整份應用設定，所以 config.jwt.secret 本來就到處讀得到，那是另一件事。
 */
export class JwtService extends BaseService {
  static service = Object.freeze({
    name: "jwt",
    lifecycle: "singleton",
    dependencies: [],
    eager: true
  });

  #jwt;

  constructor({ config, services, options = {} } = {}) {
    super({ config, services, options });
    // 容器傳入的是整份設定，與其他 service 一致取自己那一節。啟動時已經正規化
    // 過一次，這裡再跑一次是冪等的，換來的是直接建構時也不會拿到半套設定。
    this.#jwt = normalizeJwtConfig(config?.jwt);
  }

  /** 攜帶 token 的 header 名稱，例如 authorization。 */
  get headerName() {
    return this.#jwt.headerName;
  }

  /** header 值的認證 scheme，例如 Bearer。 */
  get authScheme() {
    return this.#jwt.authScheme;
  }

  /** token 的有效期設定，供簽發端顯示給客戶端。 */
  get expiresIn() {
    return this.#jwt.expiresIn;
  }

  issue(payload, { subject } = {}) {
    const options = {
      algorithm: this.#jwt.algorithm,
      expiresIn: this.#jwt.expiresIn,
      issuer: this.#jwt.issuer,
      audience: this.#jwt.audience
    };

    if (subject !== undefined && subject !== null) {
      options.subject = String(subject);
    }

    return jwt.sign(payload, this.#jwt.secret, options);
  }

  /**
   * 驗證失敗時直接拋出 jsonwebtoken 的錯誤，由呼叫端決定如何對外呈現——
   * JwtAuthStrategy 會把原因記進日誌，但只回傳籠統的 JWT_INVALID。
   */
  verify(token) {
    return jwt.verify(token, this.#jwt.secret, {
      algorithms: [this.#jwt.algorithm],
      issuer: this.#jwt.issuer,
      audience: this.#jwt.audience,
      clockTolerance: this.#jwt.clockToleranceSeconds
    });
  }
}
