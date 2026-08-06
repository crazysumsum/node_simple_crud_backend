import { randomUUID } from "node:crypto";

/**
 * 將 response body 轉成適合記錄的格式。
 * JSON 字串會還原成物件，讓後續流程仍可按欄位名稱遮蔽敏感值；
 * Buffer 則只記錄類型和大小，不把二進位內容寫入日誌。
 */
function normalizeResponseBody(body, contentType) {
  if (Buffer.isBuffer(body)) {
    return { type: "buffer", length: body.length };
  }

  if (typeof body === "string" && contentType?.includes("application/json")) {
    try {
      return JSON.parse(body);
    } catch {
      return body;
    }
  }

  return body ?? null;
}

/**
 * 優先沿用上游傳入的 request ID，沒有時才建立新的 UUID，方便跨服務追蹤。
 */
function requestIdFrom(req) {
  const incomingId = req.headers?.["x-request-id"];

  if (typeof incomingId === "string" && incomingId.trim()) {
    return incomingId.trim().slice(0, 128);
  }

  return randomUUID();
}

/**
 * 直接清理原始 URL 的 query string，避免完整 URL 欄位留下敏感參數。
 */
function redactUrl(url, isSensitiveField) {
  const value = String(url || "");
  const queryIndex = value.indexOf("?");

  if (queryIndex === -1) {
    return value;
  }

  const pathname = value.slice(0, queryIndex);
  const searchParams = new URLSearchParams(value.slice(queryIndex + 1));

  for (const key of new Set(searchParams.keys())) {
    if (isSensitiveField(key)) {
      searchParams.set(key, "[REDACTED]");
    }
  }

  const query = searchParams.toString();
  return query ? `${pathname}?${query}` : pathname;
}

/**
 * 建立請求日誌中間件。中間件只收集 request／response 資料並產生日誌事件，
 * 寫入、遮蔽及 flush 由注入的通用 Logger 負責。
 */
export function createRequestLogger({ logger } = {}) {
  if (!logger || typeof logger.write !== "function") {
    throw new TypeError("Request logger middleware requires a Logger");
  }

  if (!logger.enabled) {
    return (_req, _res, next) => next();
  }

  if (typeof logger.formatTimestamp !== "function") {
    throw new TypeError("Request logger middleware requires timestamp formatting");
  }

  const middleware = function requestLogger(req, res, next) {
    const requestTimestamp = new Date();
    // hrtime 使用單調時鐘，計算回應時間時不會受系統時間校正影響。
    const startedAt = process.hrtime.bigint();
    const requestId = requestIdFrom(req);
    let responseBody;
    let logged = false;

    req.requestId = requestId;
    res.setHeader("X-Request-Id", requestId);

    const originalSend = res.send;
    const originalEnd = res.end;

    // 包裝 Express 的輸出方法以取得 response body，並保留原有 this 與參數行為。
    res.send = function sendWithLogging(body) {
      responseBody = body;

      return originalSend.call(this, body);
    };

    res.end = function endWithLogging(chunk, encoding, callback) {
      if (responseBody === undefined && chunk !== undefined) {
        responseBody = chunk;
      }

      return originalEnd.call(this, chunk, encoding, callback);
    };

    const writeLog = (completion) => {
      // finish 和 close 在部分情況可能相繼觸發，每個請求只可寫入一次。
      if (logged) {
        return;
      }

      logged = true;
      const durationNs = process.hrtime.bigint() - startedAt;
      const responseContentType = res.getHeader("content-type");
      const responseTime = new Date();
      const completed = completion === "finished";
      const entry = {
        timestamp: logger.formatTimestamp(responseTime),
        level: completed ? "info" : "warn",
        event: completed
          ? "http.request.completed"
          : "http.request.client_disconnected",
        message: completed
          ? "HTTP request completed"
          : "HTTP request ended before completion",
        context: {
          requestId,
          requestTime: logger.formatTimestamp(requestTimestamp),
          responseTime: logger.formatTimestamp(responseTime),
          durationMs: Number(durationNs) / 1_000_000,
          method: req.method,
          url: redactUrl(
            req.originalUrl || req.url,
            (fieldName) => logger.isSensitiveField(fieldName)
          ),
          clientIp: req.ip || req.socket?.remoteAddress || null,
          input: {
            query: req.query || {},
            params: req.params || {},
            body: req.body ?? null
          },
          output: {
            statusCode: res.statusCode,
            body: normalizeResponseBody(
              responseBody,
              String(responseContentType || "")
            )
          },
          completion
        }
      };

      // 非同步落盤不阻塞 HTTP 回應；寫入失敗亦不應令原本的請求失敗。
      logger.write(entry).catch((error) => {
        console.error(`Failed to write request log: ${error.message}`);
      });
    };

    // finish 表示正常完成；未完成便 close 則代表客戶端提前中斷連線。
    res.once("finish", () => writeLog("finished"));
    res.once("close", () => {
      if (!res.writableFinished) {
        writeLog("client_disconnected");
      }
    });

    next();
  };

  return middleware;
}

export { redactUrl };
