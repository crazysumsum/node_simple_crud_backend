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

  /**
   * 簽發一個 token。subject 與 version 都是必填。
   *
   * 這個 service 沒有依賴，也不該有——讓它依賴資料庫會把整個 auth 堆疊綁死在
   * MySQL 上。所以 version 由呼叫端從 tokenRevocation.currentVersion() 取來再
   * 傳進來，登入 handler 同時持有兩個 service，那一步很自然。
   */
  issue(payload, { subject, version } = {}) {
    // sub 是撤銷的 key，ver 是撤銷的判準。少了任何一個，這個 token 都天然免疫
    // 於所有撤銷——登出、改密碼、強制下線對它全部無效，而且沒有任何症狀。
    // 兩者都是必填：簽不出來遠比簽出一個永遠撤銷不掉的 token 好。
    const sub = String(subject ?? "").trim();

    if (!sub) {
      throw new TypeError(
        "JWT issue requires a subject: a token without sub cannot be revoked per user"
      );
    }

    if (!Number.isInteger(version) || version < 0) {
      throw new TypeError(
        "JWT issue requires a version: read it from tokenRevocation.currentVersion(subject), " +
          "or the token cannot be revoked"
      );
    }

    return jwt.sign({ ...payload, ver: version }, this.#jwt.secret.reveal(), {
      algorithm: this.#jwt.algorithm,
      expiresIn: this.#jwt.expiresIn,
      issuer: this.#jwt.issuer,
      audience: this.#jwt.audience,
      subject: sub
    });
  }

  /**
   * 驗證失敗時直接拋出 jsonwebtoken 的錯誤，由呼叫端決定如何對外呈現——
   * JwtAuthStrategy 會把原因記進日誌，但只回傳籠統的 JWT_INVALID。
   */
  verify(token) {
    const claims = jwt.verify(token, this.#jwt.secret.reveal(), {
      algorithms: [this.#jwt.algorithm],
      issuer: this.#jwt.issuer,
      audience: this.#jwt.audience,
      clockTolerance: this.#jwt.clockToleranceSeconds
    });

    // issue() 已經強制帶 sub，所以到了這裡還缺 sub 的 token，要嘛是舊版簽的，
    // 要嘛是拿著密鑰手工造的——後者正是攻擊者會造的那一種，因為它撤銷不掉。
    //
    // 擋在這裡而不是 isRevoked()：這是「不是一個合法 token」的結論，不是「這個
    // 版本號算不算舊」。丟 JsonWebTokenError 讓 JwtAuthStrategy 現有的 catch
    // 原樣接住，原因進日誌，對外仍然只有籠統的 JWT_INVALID。
    if (typeof claims.sub !== "string" || claims.sub.trim() === "") {
      throw new jwt.JsonWebTokenError("jwt subject is required");
    }

    return claims;
  }
}
