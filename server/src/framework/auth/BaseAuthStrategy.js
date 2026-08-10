import { BaseService } from "../services/BaseService.js";
import { systemLoggerFromServices } from "../services/serviceAccess.js";

/**
 * 認證策略的基底類別。
 *
 * 策略就是一般的 application service：放在 server/src/services 底下任何位置，
 * 由 service discovery 自動載入，並照常宣告 static service 的名稱與依賴。
 * 額外要求只有一個——static authType，dispatcher 以它對應 route 的 authType。
 *
 * 因此框架只有兩套自動發現機制：handler 與 service。
 */
export class BaseAuthStrategy extends BaseService {
  constructor({ config, services, options = {} } = {}) {
    super({ config, services, options });
    const authType = new.target.authType;

    if (typeof authType !== "string" || !authType.trim()) {
      throw new TypeError(
        `${new.target.name} must declare a non-empty static authType`
      );
    }

    this.authType = authType;
    this.logger = systemLoggerFromServices(services);
  }

  async authenticate(_req) {
    throw new Error(`${this.constructor.name} must implement authenticate()`);
  }
}
