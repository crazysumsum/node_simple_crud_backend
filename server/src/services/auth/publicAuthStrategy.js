import { BaseAuthStrategy } from "../../framework/auth/BaseAuthStrategy.js";

export class PublicAuthStrategy extends BaseAuthStrategy {
  static authType = "public";

  static service = Object.freeze({
    name: "auth.public",
    lifecycle: "singleton",
    dependencies: [],
    eager: true
  });

  async authenticate() {
    return { type: this.authType };
  }
}
