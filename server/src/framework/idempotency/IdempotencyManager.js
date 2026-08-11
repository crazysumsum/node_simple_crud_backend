import { createHash } from "node:crypto";
import { ApplicationError } from "../errors/ApplicationError.js";
import {
  IdempotencyStore,
  MemoryIdempotencyStore
} from "./IdempotencyStore.js";

function canonicalValue(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalValue);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalValue(value[key])])
    );
  }

  return value;
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function identityScope(req) {
  if (req.auth?.type === "jwt") {
    const claims = req.auth.claims || {};
    return `jwt:${claims.sub || claims.jti || hash(JSON.stringify(canonicalValue(claims)))}`;
  }

  return `public:${req.ip || req.socket?.remoteAddress || "unknown"}`;
}

function uploadFingerprint(req) {
  if (!Array.isArray(req.files) || req.files.length === 0) {
    return [];
  }

  return req.files.map((file) => ({
    field: file.field,
    mimeType: file.mimeType,
    size: file.size,
    // contentHash 由上傳中間件在 buffer 還在記憶體時算好。落盤後的路徑每次
    // 都是新的 UUID，拿它做指紋等於每個請求都不同。
    contentHash: file.contentHash ?? null
  }));
}

export class IdempotencyError extends ApplicationError {
  constructor(code, message, statusCode) {
    super(message, { code, statusCode, publicMessage: message });
  }
}

export class IdempotencyManager {
  constructor({ config, store, logger, context } = {}) {
    this.config = config;
    this.store =
      store ||
      new MemoryIdempotencyStore({ maxEntries: config.memoryMaxEntries });
    this.logger = logger;
    this.context = context;

    if (!context || typeof context.get !== "function") {
      throw new TypeError("IdempotencyManager requires a request context service");
    }

    if (
      !(this.store instanceof IdempotencyStore) &&
      ["begin", "complete", "fail"].some(
        (method) => typeof this.store?.[method] !== "function"
      )
    ) {
      throw new TypeError(
        "Idempotency store must implement begin(), complete() and fail()"
      );
    }
  }

  routeOptions(source, routeKey) {
    const routeConfig = source || { enabled: false };
    const enabled = this.config.enabled && routeConfig.enabled === true;
    const ttlMs = Number(routeConfig.ttlMs ?? this.config.defaultTtlMs);

    if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
      throw new Error(`Idempotency ttlMs must be a positive integer for ${routeKey}`);
    }

    return Object.freeze({ enabled, ttlMs });
  }

  async execute(req, res, routeOptions, work) {
    if (!routeOptions.enabled) {
      return work();
    }

    const idempotencyKey = String(req.get(this.config.headerName) || "").trim();

    if (!idempotencyKey) {
      throw new IdempotencyError(
        "IDEMPOTENCY_KEY_REQUIRED",
        `${this.config.headerName} header is required`,
        400
      );
    }

    if (idempotencyKey.length > this.config.maxKeyLength) {
      throw new IdempotencyError(
        "IDEMPOTENCY_KEY_INVALID",
        "Idempotency key is invalid",
        400
      );
    }

    const route = req.apiRoute;
    const storeKey = `${this.config.storeKeyPrefix}:${hash(
      `${identityScope(req)}:${route.method}:${route.path}:${idempotencyKey}`
    )}`;
    const fingerprint = hash(
      JSON.stringify(
        canonicalValue({
          method: req.method,
          path: route.path,
          input: req.input,
          // 上傳的檔案不在 req.input 裡。少了這一段，同一個 key 配上同樣的
          // 文字欄位但換一個檔案會被當成重播：新檔案靜默丟棄，客戶端拿回上
          // 一次的成功回應，而它以為第二份檔案已經存下來了。
          files: uploadFingerprint(req)
        })
      )
    );
    let begin;

    try {
      begin = await this.store.begin(storeKey, {
        fingerprint,
        ttlMs: routeOptions.ttlMs
      });
    } catch (error) {
      throw new IdempotencyError(
        "IDEMPOTENCY_STORE_FAILED",
        "Idempotency service is unavailable",
        503
      );
    }

    if (begin.state === "conflict") {
      throw new IdempotencyError(
        "IDEMPOTENCY_CONFLICT",
        "Idempotency key was already used with different input",
        409
      );
    }

    if (begin.state === "inProgress") {
      res.setHeader("Retry-After", "1");
      throw new IdempotencyError(
        "IDEMPOTENCY_IN_PROGRESS",
        "A request with this idempotency key is still processing",
        409
      );
    }

    if (begin.state === "capacityExceeded") {
      res.setHeader("Retry-After", "1");
      throw new IdempotencyError(
        "IDEMPOTENCY_CAPACITY_EXCEEDED",
        "Idempotency service is busy",
        503
      );
    }

    if (begin.state === "replay") {
      // dispatcher 靠這個旗標知道 handler 沒有跑過，得清掉這次上傳的檔案。
      req.idempotentReplay = true;
      res.setHeader("Idempotency-Replayed", "true");
      void this.logger?.info?.("idempotency.response.replayed", "Idempotent response replayed", {
        requestId:
          req.requestId ||
          this.context.get()?.requestId ||
          null,
        method: req.method,
        path: route.path
      });
      return res.status(begin.response.statusCode).json(begin.response.body);
    }

    if (begin.state !== "started") {
      throw new IdempotencyError(
        "IDEMPOTENCY_STORE_FAILED",
        "Idempotency service is unavailable",
        503
      );
    }

    const originalJson = res.json;
    let responseBody;
    res.json = function captureIdempotentResponse(body) {
      responseBody = body;
      return originalJson.call(this, body);
    };

    try {
      const result = await work();

      if (
        responseBody !== undefined &&
        this.config.cacheableStatusCodes.includes(res.statusCode)
      ) {
        try {
          await this.store.complete(
            storeKey,
            { statusCode: res.statusCode, body: responseBody },
            { ttlMs: routeOptions.ttlMs }
          );
        } catch (error) {
          void this.logger?.error?.("idempotency.store.complete_failed", "Failed to save idempotent response", {
            requestId: req.requestId || null,
            error: { name: error.name, message: error.message }
          });
        }
      } else {
        await this.store.fail(storeKey);
      }

      return result;
    } catch (error) {
      // 釋放失敗的後果是 key 卡在 inProgress 直到 TTL 到期，客戶端拿著同一個
      // key 重試會一路收到 409。原本的錯誤仍要往上拋，但這件事必須看得見，
      // 否則現場只會看到「重試莫名其妙全部 409」而找不到原因。
      await this.store.fail(storeKey).catch((releaseError) => {
        void this.logger?.error?.(
          "idempotency.store.release_failed",
          "Failed to release an idempotency key after a failed request",
          {
            requestId: req.requestId || null,
            path: route.path,
            ttlMs: routeOptions.ttlMs,
            error: { name: releaseError.name, message: releaseError.message }
          }
        );
      });
      throw error;
    } finally {
      res.json = originalJson;
    }
  }

  close() {
    return this.store.close?.();
  }
}
