import { AuthenticationError } from "../../framework/auth/AuthenticationError.js";
import { BaseAuthStrategy } from "../../framework/auth/BaseAuthStrategy.js";

export class JwtAuthStrategy extends BaseAuthStrategy {
  static authType = "jwt";

  // 完全一般的 service metadata：簽發與驗證都交給 jwt service，這個策略只
  // 負責把 token 從 HTTP header 裡取出來。
  static service = Object.freeze({
    name: "auth.jwt",
    lifecycle: "singleton",
    dependencies: ["jwt", "logging"],
    eager: true
  });

  constructor({ config, services, options } = {}) {
    super({ config, services, options });
    this.jwt = services.require("jwt");
  }

  async authenticate(req) {
    const authorization = req.get(this.jwt.headerName);
    const [scheme, token, extra] = String(authorization || "").trim().split(/\s+/);

    if (
      !token ||
      extra ||
      scheme.toLowerCase() !== this.jwt.authScheme.toLowerCase()
    ) {
      throw new AuthenticationError(
        "JWT_REQUIRED",
        `A valid ${this.jwt.authScheme} token is required`
      );
    }

    try {
      const claims = this.jwt.verify(token);
      return { type: this.authType, claims };
    } catch (error) {
      // 客戶端只會收到籠統的 JWT_INVALID——「簽章錯誤」與「已過期」的差別
      // 會告訴攻擊者他離成功還差多遠。但這個差別對防守方極重要：過期是日常，
      // 簽章錯誤代表有人在偽造 token。原因只寫進日誌，不進回應。
      void this.logger?.warn?.("auth.jwt.rejected", "JWT verification failed", {
        requestId: req.requestId || null,
        // jsonwebtoken 用 name 區分 TokenExpiredError／JsonWebTokenError／
        // NotBeforeError，message 則載明是 issuer、audience 還是簽章不符。
        error: { name: error.name, message: error.message }
      });
      throw new AuthenticationError("JWT_INVALID", "JWT is invalid or expired");
    }
  }
}
