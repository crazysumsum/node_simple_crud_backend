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
    } catch {
      throw new AuthenticationError("JWT_INVALID", "JWT is invalid or expired");
    }
  }
}
