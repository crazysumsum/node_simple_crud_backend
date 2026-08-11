import { BaseAuthStrategy } from "../../framework/auth/BaseAuthStrategy.js";

export class PublicAuthStrategy extends BaseAuthStrategy {
  static authType = "public";

  static service = Object.freeze({
    name: "auth.public",
    lifecycle: "singleton",
    // 這個策略自己不記錄任何東西，但 BaseAuthStrategy 會取用 logging，
    // 所以它是這個類別真正的依賴，必須宣告出來。
    dependencies: ["logging"],
    eager: true
  });

  async authenticate() {
    return { type: this.authType };
  }
}
