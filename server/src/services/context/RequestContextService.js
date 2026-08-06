import { AsyncLocalStorage } from "node:async_hooks";
import { BaseService } from "../../framework/services/BaseService.js";

export class RequestContextService extends BaseService {
  static service = Object.freeze({
    name: "context",
    lifecycle: "singleton",
    dependencies: [],
    eager: true
  });

  constructor({ config, services, options = {} } = {}) {
    super({ config, services, options });
    this.storage = options.storage || new AsyncLocalStorage();
  }

  createMiddleware() {
    const storage = this.storage;

    return function requestContext(req, _res, next) {
      const context = {
        requestId: req.requestId || null,
        startedAt: new Date().toISOString(),
        method: req.method,
        url: req.originalUrl || req.url,
        clientIp: req.ip || req.socket?.remoteAddress || null,
        apiRoute: null,
        auth: null,
        authorizationPolicies: [],
        deadline: null,
        signal: null,
        databaseTransaction: null,
        serviceScope: null
      };

      req.context = context;
      storage.run(context, next);
    };
  }

  get() {
    return this.storage.getStore() || null;
  }

  require() {
    const context = this.get();

    if (!context) {
      throw new Error("Request context is not available in the current async scope");
    }

    return context;
  }

  update(values) {
    const context = this.get();

    if (context) {
      Object.assign(context, values);
    }

    return context;
  }
}
