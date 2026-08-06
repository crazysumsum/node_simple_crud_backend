import { AuthenticationError } from "../framework/auth/AuthenticationError.js";
import { BaseAuthStrategy } from "../framework/auth/BaseAuthStrategy.js";
import { optionalService } from "../framework/services/serviceAccess.js";

export class JwtAuthStrategy extends BaseAuthStrategy {
  static authType = "jwt";

  constructor(services = {}) {
    super(services);

    if (!this.jwtConfig) {
      throw new TypeError("JwtAuthStrategy requires jwtConfig");
    }

    const verifyToken = optionalService(services, "verifyToken");

    if (typeof verifyToken !== "function") {
      throw new TypeError("JwtAuthStrategy requires verifyToken service");
    }

    this.verifyToken = verifyToken;
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
