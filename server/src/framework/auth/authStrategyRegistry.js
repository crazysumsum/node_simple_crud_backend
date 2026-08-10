import { AuthenticationError } from "./AuthenticationError.js";
import { BaseAuthStrategy } from "./BaseAuthStrategy.js";
import { systemLoggerFromServices } from "../services/serviceAccess.js";

const AUTH_TYPE_PATTERN = /^[A-Za-z][A-Za-z0-9._-]*$/;

export class AuthStrategyRegistry {
  // 策略的建立與關閉都由 service container 負責，這裡只做索引與呼叫。
  constructor() {
    this.strategies = new Map();
  }

  register(type, strategy) {
    if (typeof type !== "string" || !AUTH_TYPE_PATTERN.test(type)) {
      throw new TypeError("Authentication type is invalid");
    }

    const authenticate =
      strategy instanceof BaseAuthStrategy
        ? strategy.authenticate.bind(strategy)
        : strategy;

    if (typeof authenticate !== "function") {
      throw new TypeError(
        `Authentication strategy "${type}" must implement authenticate()`
      );
    }

    if (this.strategies.has(type)) {
      throw new Error(`Duplicate authentication strategy: ${type}`);
    }

    this.strategies.set(type, { authenticate, strategy });
    return this;
  }

  has(type) {
    return this.strategies.has(type);
  }

  types() {
    return [...this.strategies.keys()];
  }

  async authenticate(type, req) {
    const entry = this.strategies.get(type);

    if (!entry) {
      throw new Error(`Unsupported authentication type: ${type}`);
    }

    const result = await entry.authenticate(req);

    if (result === null || typeof result !== "object" || Array.isArray(result)) {
      throw new TypeError(
        `Authentication strategy "${type}" must return an auth object`
      );
    }

    if (result.type !== type) {
      throw new TypeError(
        `Authentication strategy "${type}" must return type "${type}"`
      );
    }

    const auth = Object.freeze({ ...result });
    req.auth = auth;

    if (auth.claims !== undefined) {
      req.user = auth.claims;
    }

    return auth;
  }

}

/**
 * 從 service container 收集認證策略。
 *
 * 策略是一般的 service，由 service discovery 載入、由 container 建立與關閉，
 * 所以這裡不需要掃目錄，也不負責生命週期——只是把已存在的 instance 依 authType
 * 建立索引，供 dispatcher 查找。
 */
export function createAuthStrategyRegistry({ services, logger } = {}) {
  if (!services || typeof services.names !== "function") {
    throw new TypeError("Authentication strategy registry requires a service container");
  }

  const registry = new AuthStrategyRegistry();
  const activeLogger = logger || systemLoggerFromServices(services);

  for (const name of services.names()) {
    const instance = services.get(name);

    if (!(instance instanceof BaseAuthStrategy)) {
      continue;
    }

    const authType = instance.constructor.authType;

    if (typeof authType !== "string" || !AUTH_TYPE_PATTERN.test(authType)) {
      throw new Error(
        `${instance.constructor.name} (service "${name}") has an invalid static authType`
      );
    }

    if (instance.authType !== authType) {
      throw new Error(
        `${instance.constructor.name} instance authType must match its static authType`
      );
    }

    registry.register(authType, instance);
    void activeLogger?.info?.(
      "auth.strategy.registered",
      "Authentication strategy registered",
      { authType, className: instance.constructor.name, service: name }
    );
  }

  void activeLogger?.info?.(
    "auth.strategy.registration.completed",
    "Authentication strategy collection completed",
    { strategyCount: registry.types().length, authTypes: registry.types() }
  );

  return registry;
}

export { AuthenticationError };
