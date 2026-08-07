import { ApplicationError } from "../errors/ApplicationError.js";
import { sendError } from "../http/apiResponse.js";

export class RequestTimeoutError extends ApplicationError {
  constructor(timeoutMs) {
    super(`Request processing exceeded ${timeoutMs}ms`, {
      code: "REQUEST_TIMEOUT",
      statusCode: 504,
      publicMessage: "Request timed out"
    });
  }
}

export function createRequestTimeoutMiddleware({
  timeoutMs,
  logger,
  context,
  time
} = {}) {
  const normalizedTimeoutMs = Number(timeoutMs);

  if (!Number.isInteger(normalizedTimeoutMs) || normalizedTimeoutMs <= 0) {
    throw new TypeError("Request timeout must be a positive integer");
  }

  if (!logger || typeof logger.warn !== "function") {
    throw new TypeError("Request timeout middleware requires a system logger");
  }

  if (!context || typeof context.update !== "function") {
    throw new TypeError("Request timeout middleware requires a request context service");
  }

  if (!time || typeof time.nowMs !== "function" || typeof time.at !== "function" || typeof time.timestamp !== "function") {
    throw new TypeError("Request timeout middleware requires a time service");
  }

  return function requestTimeout(req, res, next) {
    const controller = new AbortController();
    const startedAt = time.nowMs();
    const deadline = time.timestamp(time.at(startedAt + normalizedTimeoutMs));
    let timer;

    req.requestTimeout = Object.freeze({
      timeoutMs: normalizedTimeoutMs,
      deadline,
      signal: controller.signal
    });
    const contextValues = {
      deadline,
      signal: controller.signal
    };
    context.update(contextValues);

    const cleanup = () => {
      clearTimeout(timer);
      res.removeListener("finish", onFinish);
      res.removeListener("close", onClose);
    };
    const onFinish = () => cleanup();
    const onClose = () => {
      cleanup();

      if (!controller.signal.aborted && !res.writableFinished) {
        controller.abort(new Error("Client disconnected"));
      }
    };

    res.once("finish", onFinish);
    res.once("close", onClose);

    timer = setTimeout(() => {
      if (res.writableEnded || res.destroyed) {
        cleanup();
        return;
      }

      const error = new RequestTimeoutError(normalizedTimeoutMs);
      controller.abort(error);

      void logger.warn("http.request_timeout", "HTTP request timed out", {
        requestId: req.requestId || null,
        method: req.method,
        url: req.originalUrl || req.url,
        api: req.apiRoute || null,
        timeoutMs: normalizedTimeoutMs,
        elapsedMs: time.nowMs() - startedAt
      });

      sendError(res, {
        statusCode: error.statusCode,
        code: error.publicCode,
        message: error.publicMessage,
        time
      });
    }, normalizedTimeoutMs);
    timer.unref?.();

    next();
  };
}
