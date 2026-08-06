import {
  optionalService,
  systemLoggerFromServices
} from "../services/serviceAccess.js";

export class BaseAuthStrategy {
  constructor(services = {}) {
    const authType = new.target.authType;

    if (typeof authType !== "string" || !authType.trim()) {
      throw new TypeError(
        `${new.target.name} must declare a non-empty static authType`
      );
    }

    if (services === null || typeof services !== "object" || Array.isArray(services)) {
      throw new TypeError("Authentication strategy services must be an object");
    }

    this.authType = authType;
    this.services = services;
    this.logger = systemLoggerFromServices(services);
    this.jwtConfig = optionalService(services, "jwtConfig") || null;
  }

  async authenticate(_req) {
    throw new Error(`${this.constructor.name} must implement authenticate()`);
  }

  async close() {}
}
