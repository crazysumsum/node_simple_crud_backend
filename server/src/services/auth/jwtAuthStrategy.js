import { AuthenticationError } from "../../framework/auth/AuthenticationError.js";
import { BaseAuthStrategy } from "../../framework/auth/BaseAuthStrategy.js";

export class JwtAuthStrategy extends BaseAuthStrategy {
  static authType = "jwt";

  // 完全一般的 service metadata：簽發與驗證都交給 jwt service，這個策略只
  // 負責把 token 從 HTTP header 裡取出來，再問一次它有沒有被撤銷。
  static service = Object.freeze({
    name: "auth.jwt",
    lifecycle: "singleton",
    dependencies: ["jwt", "tokenRevocation", "logging"],
    eager: true
  });

  constructor({ config, services, options } = {}) {
    super({ config, services, options });
    this.jwt = services.require("jwt");
    this.tokenRevocation = services.require("tokenRevocation");
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

      // 撤銷檢查刻意放在這裡而不是 JwtService.verify() 裡：jwt service 沒有
      // 任何依賴，是純粹的簽發與驗證。讓它依賴資料庫，會把整個 auth 堆疊——
      // 連 issue() 都算在內——綁死在 MySQL 上。
      //
      // 代價是任何直接呼叫 jwt.verify() 的地方都會繞過撤銷。目前只有這裡在
      // 呼叫，新增呼叫端時必須自己想清楚這一點。
      if (this.tokenRevocation.isRevoked(claims)) {
        // 撤銷後仍被使用，通常代表對方還不知道自己已經被踢掉，也可能是被盜的
        // token 正在被使用。這個區別靠 subject 與頻率去看，所以兩者都要記。
        void this.logger?.warn?.("auth.jwt.revoked", "JWT was revoked", {
          requestId: req.requestId || null,
          subject: claims.sub ?? null,
          issuedAt: claims.iat ?? null,
          snapshotAgeSeconds: this.tokenRevocation.snapshotAgeSeconds()
        });
        throw new AuthenticationError("JWT_INVALID", "JWT is invalid or expired");
      }

      return { type: this.authType, claims };
    } catch (error) {
      // 撤銷判定已經是最終結論，不該被下面的 catch 重新包裝成「驗證失敗」，
      // 那會多記一筆誤導的 auth.jwt.rejected。
      if (error instanceof AuthenticationError) {
        throw error;
      }

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
