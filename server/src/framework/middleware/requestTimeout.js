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

    // cleanup 與 finish/close 監聽器都只會在這一行之後才執行，可安全宣告為 const。
    const timer = setTimeout(() => {
      if (res.writableEnded || res.destroyed) {
        cleanup();
        return;
      }

      const error = new RequestTimeoutError(normalizedTimeoutMs);
      controller.abort(error);

      // 回應已經開始送出時（檔案下載會先送 header 再串流內容）不可能再改成
      // 504：res.setHeader 會直接拋 ERR_HTTP_HEADERS_SENT。這裡是計時器
      // callback，拋出的例外沒有任何 try 接得到，會變成 uncaughtException
      // 並讓整個程序結束。這種情況只能中斷連線，讓客戶端看到截斷的傳輸。
      const responseAlreadyStarted = res.headersSent;

      void logger.warn("http.request_timeout", "HTTP request timed out", {
        requestId: req.requestId || null,
        method: req.method,
        url: req.originalUrl || req.url,
        api: req.apiRoute || null,
        timeoutMs: normalizedTimeoutMs,
        elapsedMs: time.nowMs() - startedAt,
        responseAlreadyStarted
      });

      if (responseAlreadyStarted) {
        res.destroy(error);
        return;
      }

      try {
        sendError(res, {
          statusCode: error.statusCode,
          code: error.publicCode,
          message: error.publicMessage,
          time
        });
      } catch (responseError) {
        // 同上：計時器內任何未捕捉的例外都會終止程序，所以連「送出逾時回應
        // 本身失敗」也要兜住，寧可放棄回應只斷線。
        void logger.error?.(
          "http.request_timeout.response_failed",
          "Failed to send the timeout response",
          {
            requestId: req.requestId || null,
            error: { name: responseError.name, message: responseError.message }
          }
        );
        res.destroy(error);
      }
    }, normalizedTimeoutMs);
    timer.unref?.();

    next();
  };
}
