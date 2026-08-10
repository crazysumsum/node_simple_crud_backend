import { randomUUID } from "node:crypto";

// 未記錄的 body 會留下標記，讓日誌讀者分得出「政策決定不記」與「本來就沒有」。
const NOT_LOGGED = "[NOT_LOGGED]";
const FILE_TRANSFER = "[FILE_TRANSFER]";

// 檔案上傳的 content type。上傳內容不是結構化欄位，記進 JSONL 只會塞爆日誌，
// 而且附件本身往往就是最敏感的資料。
const FILE_UPLOAD_TYPE = /^(multipart\/|application\/octet-stream)/i;
// 只有結構化的文字回應值得記錄；其餘一律視為檔案下載。
const TEXTUAL_RESPONSE_TYPE = /^(application\/json|application\/[\w.+-]*\+json|text\/)/i;

function contentTypeOf(value) {
  return String(value || "").split(";")[0].trim();
}

function isFileUpload(req) {
  return FILE_UPLOAD_TYPE.test(contentTypeOf(req.get?.("content-type")));
}

function isFileDownload(responseContentType, body) {
  if (Buffer.isBuffer(body)) {
    return true;
  }

  const contentType = contentTypeOf(responseContentType);
  return contentType !== "" && !TEXTUAL_RESPONSE_TYPE.test(contentType);
}

/**
 * 決定這次請求要不要完整記錄 body。
 *
 * 優先序：檔案傳輸永不記錄，其次是錯誤狀態碼強制記錄，最後才看 route 或
 * 全域設定。錯誤覆寫刻意排在 route 設定之前——出錯時重現問題的價值高於
 * 節省日誌，這是專案明確選擇的取捨。
 */
function shouldCaptureBody({ mode, statusCode, errorStatus }) {
  if (errorStatus !== null && statusCode >= errorStatus) {
    return true;
  }

  return mode === "full";
}

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
export function createRequestLogger({ logger, time } = {}) {
  if (!logger || typeof logger.write !== "function") {
    throw new TypeError("Request logger middleware requires a Logger");
  }

  if (!logger.enabled) {
    return (_req, _res, next) => next();
  }

  if (typeof logger.formatTimestamp !== "function") {
    throw new TypeError("Request logger middleware requires timestamp formatting");
  }

  if (!time || typeof time.now !== "function" || typeof time.timestamp !== "function") {
    throw new TypeError("Request logger middleware requires a time service");
  }

  const defaultMode = logger.config?.bodyCapture ?? "none";
  const errorStatus = logger.config?.bodyCaptureErrorStatus ?? null;

  // req.apiRoute 由 apiDispatcher 設定，而日誌在 response 的 finish 事件才寫出，
  // 所以這裡讀得到。未匹配任何 route 的請求（404、429）沿用全域預設。
  const captureModeFor = (req) => req.apiRoute?.logging?.bodyCapture || defaultMode;

  const requestBodyFor = (req, statusCode) => {
    if (isFileUpload(req)) {
      return FILE_TRANSFER;
    }

    if (
      !shouldCaptureBody({ mode: captureModeFor(req), statusCode, errorStatus })
    ) {
      return NOT_LOGGED;
    }

    return req.body ?? null;
  };

  const responseBodyFor = (req, res, responseBody, responseContentType) => {
    if (isFileDownload(responseContentType, responseBody)) {
      return FILE_TRANSFER;
    }

    if (
      !shouldCaptureBody({
        mode: captureModeFor(req),
        statusCode: res.statusCode,
        errorStatus
      })
    ) {
      return NOT_LOGGED;
    }

    return normalizeResponseBody(responseBody, String(responseContentType || ""));
  };

  const middleware = function requestLogger(req, res, next) {
    const requestTimestamp = time.now();
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
      const responseTime = time.now();
      const completed = completion === "finished";
      const entry = {
        timestamp: time.timestamp(responseTime),
        level: completed ? "info" : "warn",
        event: completed
          ? "http.request.completed"
          : "http.request.client_disconnected",
        message: completed
          ? "HTTP request completed"
          : "HTTP request ended before completion",
        context: {
          requestId,
          requestTime: time.timestamp(requestTimestamp),
          responseTime: time.timestamp(responseTime),
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
            body: requestBodyFor(req, res.statusCode)
          },
          output: {
            statusCode: res.statusCode,
            body: responseBodyFor(req, res, responseBody, responseContentType)
          },
          bodyCapture: captureModeFor(req),
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
