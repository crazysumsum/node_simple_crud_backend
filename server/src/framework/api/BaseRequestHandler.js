import {
  optionalService,
  systemLoggerFromServices
} from "../services/serviceAccess.js";
import { ApplicationError } from "../errors/ApplicationError.js";
import { sendSuccess } from "../http/apiResponse.js";
import { sendFileResponse } from "../http/fileResponse.js";

const HANDLER_RESPONSE = Symbol("handlerResponse");
const HANDLER_FILE_RESPONSE = Symbol("handlerFileResponse");
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
  // get trap 只會在 proxy 初始化之後才被呼叫，所以在 trap 內引用 proxy 是安全的。
  const proxy = new Proxy(res, {
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
    this.time = optionalService(services, "time") || null;
  }

  // dispatcher 仍以 (req, res, next) 呼叫，但 handler 不得自行呼叫 next——
  // 它收到的是一個會拋錯的替身，因此這裡刻意不使用第三個參數。
  async handle(req, res, _next) {
    if (!this.time || typeof this.time.now !== "function" || typeof this.time.timestamp !== "function") {
      throw new TypeError("Request handler requires a time service");
    }

    const startTime = this.time.now();
    const startedAt = process.hrtime.bigint();
    const requestId =
      req.requestId ||
      req.get?.("x-request-id") ||
      res.getHeader?.("x-request-id") ||
      null;
    let handlerError;

    // 日誌落盤不應擋在請求路徑上。框架其他地方（dispatcher、限流、生命週期）
    // 都用 void 送出，這裡先前的 await 會讓每個請求多等兩次檔案寫入。
    this.writeLog(
      "info",
      "request.handler.started",
      `Request handler started: ${this.handlerName}`,
      {
        requestId,
        handler: this.handlerName,
        method: req.method,
        url: req.originalUrl || req.url,
        startTime: this.time.timestamp(startTime)
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

      if (result?.[HANDLER_FILE_RESPONSE]) {
        if (!req.apiRoute?.download?.enabled) {
          throw new ApplicationError(
            `Handler "${this.handlerName}" returned a file response without declaring download.enabled`,
            {
              code: "HANDLER_DOWNLOAD_NOT_DECLARED",
              statusCode: 500,
              publicCode: "INTERNAL_SERVER_ERROR",
              publicMessage: "Internal server error"
            }
          );
        }

        // 檔案回應不套用統一信封，因此也沒有 responseSchema 可驗證。
        await sendFileResponse(res, result);
        return result;
      }

      const response = result?.[HANDLER_RESPONSE]
        ? result
        : this.response(result);

      req.validateResponse?.(response.statusCode, response.data);

      sendSuccess(res, response.data, {
        statusCode: response.statusCode,
        meta: response.meta,
        time: this.time
      });

      return result;
    } catch (error) {
      handlerError = error;
      throw error;
    } finally {
      const endTime = this.time.now();
      const durationNs = process.hrtime.bigint() - startedAt;
      const requestTimedOut =
        req.requestTimeout?.signal?.aborted &&
        req.requestTimeout.signal.reason?.code === "REQUEST_TIMEOUT";
      const context = {
        requestId,
        handler: this.handlerName,
        method: req.method,
        url: req.originalUrl || req.url,
        startTime: this.time.timestamp(startTime),
        endTime: this.time.timestamp(endTime),
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

        this.writeLog(
          "error",
          "request.handler.finished",
          `Request handler failed: ${this.handlerName}`,
          context
        );
      } else {
        this.writeLog(
          "info",
          "request.handler.finished",
          `Request handler completed: ${this.handlerName}`,
          context
        );
      }
    }
  }

  // 送出日誌但不等待落盤。寫入失敗只記在 console，不可讓原本成功的請求失敗。
  writeLog(level, event, message, context) {
    const write = this.logger?.[level];

    if (typeof write !== "function") {
      return;
    }

    Promise.resolve(write.call(this.logger, event, message, context)).catch(
      (error) => {
        console.error(`Failed to record handler event: ${error.message}`);
      }
    );
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

  /**
   * 回傳一個檔案下載。只有在 static api.download.enabled 為 true 的 route 可用。
   *
   * 三選一：`path` 送出磁碟上的檔案，`buffer` 送出記憶體內容，`stream` 串流
   * 產生中的內容（例如即時產出的 Excel）。框架負責 Content-Type、
   * Content-Disposition 與 Content-Length，handler 不需要、也不允許直接寫回應。
   *
   * `path` 一律要先經過 resolveWithinDirectory 檢查，避免請求參數決定讀取位置。
   */
  file({ path: filePath, buffer, stream, fileName, contentType, statusCode = 200 } = {}) {
    const sources = [filePath, buffer, stream].filter(
      (value) => value !== undefined && value !== null
    );

    if (sources.length !== 1) {
      throw new TypeError(
        `Handler "${this.handlerName}" file response requires exactly one of path, buffer or stream`
      );
    }

    if (!fileName) {
      throw new TypeError(
        `Handler "${this.handlerName}" file response requires a fileName`
      );
    }

    return {
      [HANDLER_FILE_RESPONSE]: true,
      path: filePath,
      buffer,
      stream,
      fileName,
      contentType,
      statusCode
    };
  }
}
