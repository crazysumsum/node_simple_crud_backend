import { sendError } from "../http/apiResponse.js";

/**
 * 限制「請求已佔住限流槽位、但 body 還沒收完」那一段的時間。
 *
 * 這一段是框架裡唯一沒有上限的階段。限流槽位在請求進來的第一時間就被佔住，而
 * route 的 timeoutMs 要等 express.json() 解析完、進了 dispatcher 才開始計時。
 * 中間客戶端可以宣告一個大 body 然後幾乎不送——實測兩條這樣的連線、總共 12 個
 * 位元組，就能佔滿一個 maxConcurrentRequests 為 2 的實例，正常使用者排到
 * queueTimeoutMs 之後收到 429。handler 從未執行，所以 route 的逾時永遠不觸發。
 *
 * 為什麼不靠 Node 的 server.requestTimeout：那一個必須容得下最大的合法上傳
 * （50MB 走 1Mbps 要 400 秒），對只有 jsonBodyLimit 那麼大的 JSON body 太鬆。
 * 兩者是兜底與精確的關係，不是二選一。
 *
 * 為什麼不需要知道 route：這個中間件掛在 express.json() 之前，那時 req.apiRoute
 * 還不存在。但它也不需要——它守的是「取得槽位」到「dispatcher 接手」之間那一段，
 * 而不經過 express.json() 的請求（multipart 上傳）會瞬間走完這一段，計時器在
 * 到期前就被清掉了。上傳的 body 由 route timeout 負責。
 *
 * 逾時的處理是回 408 之後 destroy socket，不是只送回應：body 還在來，連線不斷
 * 掉的話對方可以繼續送，槽位也不會立刻還回來。
 */
export function createBodyReceiveTimeoutMiddleware({
  timeoutMs,
  logger,
  time
} = {}) {
  const normalizedTimeoutMs = Number(timeoutMs);

  if (!Number.isInteger(normalizedTimeoutMs) || normalizedTimeoutMs <= 0) {
    throw new TypeError("Body receive timeout must be a positive integer");
  }

  if (!logger || typeof logger.warn !== "function") {
    throw new TypeError("Body receive timeout middleware requires a system logger");
  }

  if (!time || typeof time.nowMs !== "function") {
    throw new TypeError("Body receive timeout middleware requires a time service");
  }

  return function bodyReceiveTimeout(req, res, next) {
    // 已經收完的請求沒有什麼好等的。Express 在 body 讀完後才會走到後面的
    // 中間件，但 GET 這類沒有 body 的請求在這裡就已經 complete 了。
    if (req.complete) {
      next();
      return;
    }

    const startedAt = time.nowMs();
    let receivedBytes = 0;

    const countBytes = (chunk) => {
      receivedBytes += chunk.length;
    };

    const cleanup = () => {
      clearTimeout(timer);
      req.removeListener("data", countBytes);
      req.removeListener("end", cleanup);
      res.removeListener("finish", cleanup);
      res.removeListener("close", cleanup);
    };

    const timer = setTimeout(() => {
      cleanup();

      if (res.writableEnded || res.destroyed) {
        return;
      }

      void logger.warn(
        "http.body_receive_timeout",
        "Request body did not arrive in time",
        {
          requestId: req.requestId || null,
          method: req.method,
          url: req.originalUrl || req.url,
          // 這兩個數字合起來就是攻擊的簽名：一分鐘一百筆、每筆幾個位元組，
          // 和「客戶端網路慢」長得完全不一樣。
          receivedBytes,
          declaredContentLength: Number(req.headers?.["content-length"]) || null,
          elapsedMs: time.nowMs() - startedAt,
          timeoutMs: normalizedTimeoutMs
        }
      );

      try {
        sendError(res, {
          statusCode: 408,
          code: "REQUEST_BODY_TIMEOUT",
          message: "Request body was not received in time",
          time
        });
      } finally {
        // body 還在來，只送回應不夠——不斷線的話對方可以繼續送，而槽位要等到
        // 連線真的結束才會還回來。
        res.destroy();
      }
    }, normalizedTimeoutMs);
    timer.unref?.();

    req.on("data", countBytes);
    req.once("end", cleanup);
    res.once("finish", cleanup);
    res.once("close", cleanup);

    next();
  };
}
