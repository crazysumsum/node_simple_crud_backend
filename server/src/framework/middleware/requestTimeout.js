import { ApplicationError } from "../errors/ApplicationError.js";
import { sendError } from "../http/apiResponse.js";
import {
  maybeMarkRequestAbandoned,
  onRequestProcessingComplete
} from "../http/requestProcessingLifecycle.js";

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

    const removeListeners = () => {
      res.removeListener("finish", onFinish);
      res.removeListener("close", onClose);
    };
    const cleanup = () => {
      clearTimeout(timer);
      removeListeners();
    };
    // 兩個事件的先後順序不固定：逾時是 abort 先、回應後結束；客戶端斷線是 close
    // 先、abort 在 onClose 裡面。所以兩邊都重跑一次完整的判定式，順序就不重要了。
    // 借用既有的監聽器而不是另外掛兩個——res 上的監聽器已經有八個了。
    const checkAbandoned = () =>
      maybeMarkRequestAbandoned(req, res, controller.signal);
    // 回應結束不代表期限失效：handler 可能送完回應才卡住。計時器要留到 handler
    // 真的 settle 才清（下面的 onRequestProcessingComplete），否則那種 handler
    // 沒有任何東西會發現——finish 那一刻 signal 還沒 aborted。
    const onFinish = () => {
      removeListeners();
      checkAbandoned();
    };
    const onClose = () => {
      removeListeners();

      if (!controller.signal.aborted && !res.writableFinished) {
        controller.abort(new Error("Client disconnected"));
      }

      checkAbandoned();
    };

    res.once("finish", onFinish);
    res.once("close", onClose);

    // cleanup 與 finish/close 監聽器都只會在這一行之後才執行，可安全宣告為 const。
    const timer = setTimeout(() => {
      if (res.writableEnded || res.destroyed) {
        removeListeners();
        // 回應早就結束了，但 handler 還沒回來——期限仍然到了，這一筆就是被放棄的。
        controller.abort(new RequestTimeoutError(normalizedTimeoutMs));
        checkAbandoned();
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
    // handler settle 了，期限才真正失效。這也是計時器唯一被清掉的地方——少了它，
    // 每一筆正常完成的請求都會把 req／res 一路吊到 timeoutMs 之後。
    onRequestProcessingComplete(req, cleanup);

    next();
  };
}
