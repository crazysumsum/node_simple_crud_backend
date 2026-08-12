import { createHash } from "node:crypto";
import { ApplicationError } from "../../framework/errors/ApplicationError.js";
import {
  IdempotencyStore,
  MemoryIdempotencyStore
} from "./IdempotencyStore.js";
import { MySqlIdempotencyStore } from "./MySqlIdempotencyStore.js";
import { normalizeIdempotencyConfig } from "./normalizeIdempotencyConfig.js";

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

/** route 沒有 idempotency service 可用時的固定結果。 */
export const DISABLED_ROUTE_IDEMPOTENCY = Object.freeze({
  enabled: false,
  ttlMs: 0
});

/**
 * Idempotency：同一個 key 的請求只執行一次，之後重播第一次的回應。
 *
 * 它是 service 而不是由 Factory 手工組裝的物件，因為共享 store 需要注入
 * mysqldatabase——那正是當初讓限流器變成 service 的同一個理由。
 *
 * 框架用 services.get() 取它，所以停用之後應用仍然啟動；但任何仍宣告
 * idempotency 的 route 會讓啟動失敗。這兩件事不衝突：框架本身不依賴它，
 * 而「以為有 idempotency 但其實沒有」不能是一個安靜的狀態。
 */
export class IdempotencyService {
  static service = Object.freeze({
    name: "idempotency",
    lifecycle: "singleton",
    dependencies: ["mysqldatabase", "logging", "context", "time"],
    // Factory 用 get() 取，而 get() 只回傳已建立的實例。改成 lazy 會讓
    // idempotency 靜默地不生效。
    eager: true
  });

  constructor({ config, store, logger, context, services, options = {} } = {}) {
    const managed = services && typeof services.require === "function";

    this.config = managed
      ? normalizeIdempotencyConfig(config?.idempotency)
      : config;
    this.logger = managed ? services.require("logging").logger : logger;
    this.context = managed ? services.require("context") : context;
    this.time = managed ? services.require("time") : options.time;
    this.store = store || options.store || this.createStore(managed, services);

    if (!this.context || typeof this.context.get !== "function") {
      throw new TypeError("IdempotencyService requires a request context service");
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

  createStore(managed, services) {
    if (this.config.storeAdapter === "memory") {
      return new MemoryIdempotencyStore({
        maxEntries: this.config.memoryMaxEntries,
        now: this.time ? () => this.time.nowMs() : undefined
      });
    }

    if (!managed) {
      throw new TypeError(
        `The ${this.config.storeAdapter} idempotency adapter needs the service container; inject a store instead.`
      );
    }

    return new MySqlIdempotencyStore({
      database: services.require("mysqldatabase"),
      time: this.time,
      maxResponseBytes: this.config.maxResponseBytes
    });
  }

  /** 處理中的 key 最多鎖多久。啟動時的交叉檢查會讀它。 */
  get pendingLeaseMs() {
    return this.config.pendingLeaseMs;
  }

  routeOptions(source, routeKey) {
    const routeConfig = source || { enabled: false };
    const enabled = routeConfig.enabled === true;
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
        ttlMs: routeOptions.ttlMs,
        pendingLeaseMs: this.config.pendingLeaseMs
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

  /** 刪除過期紀錄。由 IdempotencyPurgeJob 以 cluster scope 排程。 */
  async purge() {
    const removed = (await this.store.purge?.()) ?? 0;

    if (removed > 0) {
      await this.logger?.info?.(
        "idempotency.purged",
        "Expired idempotency records were removed",
        { removedRecords: removed, storeAdapter: this.config.storeAdapter }
      );
    }

    return removed;
  }

  async shutdown() {
    await this.store.close?.();
  }
}
