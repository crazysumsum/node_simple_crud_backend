import {
  optionalService,
  systemLoggerFromServices
} from "../services/serviceAccess.js";
import { ApplicationError } from "../errors/ApplicationError.js";
import { sendSuccess } from "../http/apiResponse.js";

const HANDLER_RESPONSE = Symbol("handlerResponse");
const RESPONSE_WRITE_METHODS = new Set([
  "download",
  "end",
  "flushHeaders",
  "format",
  "jsonp",
  "json",
  "redirect",
  "render",
  "send",
  "sendFile",
  "sendStatus",
  "write",
  "writeContinue",
  "writeHead"
]);

function directResponseError(handlerName, operation) {
  return new ApplicationError(
    `Handler "${handlerName}" attempted direct response operation: ${operation}`,
    {
      code: "HANDLER_DIRECT_RESPONSE_FORBIDDEN",
      statusCode: 500,
      publicCode: "INTERNAL_SERVER_ERROR",
      publicMessage: "Internal server error"
    }
  );
}

function handlerResponseView(res, handlerName) {
  let proxy;

  proxy = new Proxy(res, {
    get(target, property) {
      if (RESPONSE_WRITE_METHODS.has(property)) {
        return () => {
          throw directResponseError(handlerName, property);
        };
      }

      const value = Reflect.get(target, property, target);

      if (typeof value !== "function") {
        return value;
      }

      return (...args) => {
        const result = value.apply(target, args);
        return result === target ? proxy : result;
      };
    },
    set(target, property, value) {
      return Reflect.set(target, property, value, target);
    }
  });

  return proxy;
}

export class BaseRequestHandler {
  constructor(handlerNameOrServices, serviceOverrides) {
    const usesExplicitName = typeof handlerNameOrServices === "string";
    const handlerName = usesExplicitName
      ? handlerNameOrServices
      : new.target.handlerName;
    const services = usesExplicitName
      ? serviceOverrides || {}
      : handlerNameOrServices || {};

    if (typeof handlerName !== "string" || !handlerName.trim()) {
      throw new TypeError(
        `${new.target.name} must declare a non-empty static handlerName`
      );
    }

    if (services === null || typeof services !== "object" || Array.isArray(services)) {
      throw new TypeError("Request handler services must be an object");
    }

    this.handlerName = handlerName;
    this.services = services;
    this.logging = optionalService(services, "logging") || null;
    this.logger = systemLoggerFromServices(services);
    this.loggers = this.logging?.loggers || optionalService(services, "loggers") || null;
    this.mysqlDatabase = optionalService(services, "mysqldatabase") || null;
    this.context = optionalService(services, "context") || null;
  }

  async handle(req, res, next) {
    const startTime = new Date();
    const startedAt = process.hrtime.bigint();
    const requestId =
      req.requestId ||
      req.get?.("x-request-id") ||
      res.getHeader?.("x-request-id") ||
      null;
    let handlerError;

    await this.logger?.info?.(
      "request.handler.started",
      `Request handler started: ${this.handlerName}`,
      {
        requestId,
        handler: this.handlerName,
        method: req.method,
        url: req.originalUrl || req.url,
        startTime: startTime.toISOString()
      }
    );

    try {
      const responseView = handlerResponseView(res, this.handlerName);
      const originalRequestResponse = req.res;
      let result;

      req.res = responseView;

      try {
        result = await this.execute(req, responseView, () => {
          throw directResponseError(this.handlerName, "next");
        });
      } finally {
        req.res = originalRequestResponse;
      }

      if (res.writableEnded || res.destroyed) {
        return result;
      }

      if (result === undefined) {
        throw new ApplicationError(
          `Handler "${this.handlerName}" must return response data`,
          {
            code: "HANDLER_RESPONSE_REQUIRED",
            statusCode: 500,
            publicCode: "INTERNAL_SERVER_ERROR",
            publicMessage: "Internal server error"
          }
        );
      }

      if (res.headersSent) {
        throw directResponseError(this.handlerName, "headers");
      }

      const response = result?.[HANDLER_RESPONSE]
        ? result
        : this.response(result);

      req.validateResponse?.(response.statusCode, response.data);

      sendSuccess(res, response.data, {
        statusCode: response.statusCode,
        meta: response.meta
      });

      return result;
    } catch (error) {
      handlerError = error;
      throw error;
    } finally {
      const endTime = new Date();
      const durationNs = process.hrtime.bigint() - startedAt;
      const requestTimedOut =
        req.signal?.aborted && req.signal.reason?.code === "REQUEST_TIMEOUT";
      const context = {
        requestId,
        handler: this.handlerName,
        method: req.method,
        url: req.originalUrl || req.url,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        durationMs: Number(durationNs) / 1_000_000,
        responseCode: res.statusCode,
        outcome: handlerError ? "failed" : requestTimedOut ? "timed_out" : "completed"
      };

      if (handlerError) {
        context.error = {
          name: handlerError.name,
          message: handlerError.message,
          stack: handlerError.stack
        };

        await this.logger?.error?.(
          "request.handler.finished",
          `Request handler failed: ${this.handlerName}`,
          context
        );
      } else {
        await this.logger?.info?.(
          "request.handler.finished",
          `Request handler completed: ${this.handlerName}`,
          context
        );
      }
    }
  }

  async execute(_req, _res, _next) {
    throw new Error(`${this.constructor.name} must implement execute()`);
  }

  response(data, { statusCode = 200, meta = {} } = {}) {
    return {
      [HANDLER_RESPONSE]: true,
      data,
      statusCode,
      meta
    };
  }
}
