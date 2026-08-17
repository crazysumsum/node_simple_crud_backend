import { ApplicationError } from "../../framework/errors/ApplicationError.js";
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
          // 判定的依據。缺 ver 的 token 也走這條路（部署切換前簽的、或手工造
          // 的），而 null 與一個落後的數字要分得出來——前者是相容性，後者是
          // 真的被撤銷了。
          tokenVersion: claims.ver ?? null,
          snapshotAgeSeconds: this.tokenRevocation.snapshotAgeSeconds()
        });
        throw new AuthenticationError("JWT_INVALID", "JWT is invalid or expired");
      }

      // 快照過期的檢查排在撤銷判定之後：舊快照仍然可能已經記著這個 subject，
      // 那時「已撤銷」是比「無法判斷」更準確的答案。
      if (!this.tokenRevocation.snapshotUsable()) {
        // 401 是錯的答案。token 本身沒問題，是伺服器沒辦法判斷它有沒有被撤銷。
        // 回 401 會讓客戶端丟掉憑證去重新登入，把一次撤銷故障放大成一場登入
        // 風暴；503 說的是「這是伺服器的問題，稍後再試」，憑證留著。
        //
        // 只有 authType 是 jwt 的 route 受影響。public route——登入、/health
        // ——照常運作，恢復手段不會被一起鎖掉。
        void this.logger?.error?.(
          "auth.revocation.circuit_open",
          "Rejecting authenticated requests: the revocation snapshot is too stale to trust",
          {
            requestId: req.requestId || null,
            snapshotAgeSeconds: this.tokenRevocation.snapshotAgeSeconds()
          }
        );
        throw new ApplicationError(
          "Token revocation snapshot is too stale to trust",
          {
            code: "REVOCATION_UNAVAILABLE",
            statusCode: 503,
            publicCode: "SERVICE_UNAVAILABLE",
            publicMessage: "Service unavailable"
          }
        );
      }

      return { type: this.authType, claims };
    } catch (error) {
      // 上面刻意丟出來的錯誤都已經是最終結論，不該被重新包裝成「驗證失敗」，
      // 那會多記一筆誤導的 auth.jwt.rejected。
      //
      // 這裡認的是 ApplicationError 而不是 AuthenticationError：熔斷丟的是
      // 503，繼承關係上它不是 AuthenticationError，只認後者的話 503 會在這裡
      // 被降級成 401——正好是熔斷要避免的那個後果。
      if (error instanceof ApplicationError) {
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
