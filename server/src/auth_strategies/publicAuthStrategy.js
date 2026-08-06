import { BaseAuthStrategy } from "../framework/auth/BaseAuthStrategy.js";

export class PublicAuthStrategy extends BaseAuthStrategy {
  static authType = "public";

  async authenticate() {
    return { type: this.authType };
  }
}
