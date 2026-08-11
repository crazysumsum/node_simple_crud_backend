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

    // 基底類別自己用了 logging，所以每個策略都必須宣告它。以前沒有這個檢查時
    // auth.public 靠運氣運作：它宣告 dependencies: []，而 logging 之所以已經
    // 初始化，只是因為 auth.jwt 剛好宣告了它、且字母排序在前。移除 JWT 策略
    // （只用 API key 的服務就會這麼做）就會讓這裡拿到 null，而所有日誌呼叫都
    // 是可選鏈——不會爆，只是安靜地不再記錄認證事件。
    if (!this.logger) {
      throw new TypeError(
        `${new.target.name} could not resolve the system logger. Add "logging" to its static service.dependencies.`
      );
    }
  }

  async authenticate(_req) {
    throw new Error(`${this.constructor.name} must implement authenticate()`);
  }
}
