import { AuthenticationError } from "../../framework/auth/AuthenticationError.js";
import { BaseAuthStrategy } from "../../framework/auth/BaseAuthStrategy.js";

export class JwtAuthStrategy extends BaseAuthStrategy {
  static authType = "jwt";

  // 一般的 service metadata。jwtConfig 與 verifyToken 由 Application Factory
  // 註冊成 container value，所以這裡照常宣告成依賴即可。
  static service = Object.freeze({
    name: "auth.jwt",
    lifecycle: "singleton",
    dependencies: ["jwtConfig", "verifyToken", "logging"],
    eager: true
  });

  constructor({ config, services, options } = {}) {
    super({ config, services, options });
    this.jwtConfig = services.require("jwtConfig");
    this.verifyToken = services.require("verifyToken");

    if (typeof this.verifyToken !== "function") {
      throw new TypeError("JwtAuthStrategy requires a verifyToken function");
    }
  }

  async authenticate(req) {
    const authorization = req.get(this.jwtConfig.headerName);
    const [scheme, token, extra] = String(authorization || "").trim().split(/\s+/);

    if (
      !token ||
      extra ||
      scheme.toLowerCase() !== this.jwtConfig.authScheme.toLowerCase()
    ) {
      throw new AuthenticationError(
        "JWT_REQUIRED",
        `A valid ${this.jwtConfig.authScheme} token is required`
      );
    }

    try {
      const claims = this.verifyToken(token);
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
