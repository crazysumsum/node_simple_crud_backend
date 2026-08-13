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
      maxResponseBytes: this.config.maxResponseBytes,
      purgeMaxBatches: this.config.purgeMaxBatches
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

    if (begin.state === "completedWithoutResponse") {
      // 這個 key 已經成功執行過了，只是回應沒能保存下來。重試不能重新執行——
      // 那正是這個狀態存在的理由——也不能假裝重播一個空回應。唯一誠實的答案是
      // 告訴客戶端「做完了，但結果拿不回來，別再送這個 key」。
      void this.logger?.warn?.(
        "idempotency.response.unavailable",
        "An idempotency key completed successfully but its response was not stored",
        {
          requestId:
            req.requestId || this.context.get()?.requestId || null,
          method: req.method,
          path: route.path
        }
      );
      throw new IdempotencyError(
        "IDEMPOTENCY_RESULT_UNAVAILABLE",
        "This request already completed successfully, but its response was not stored. Do not retry it; query the resource instead.",
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
      const succeeded = this.config.cacheableStatusCodes.includes(res.statusCode);

      // handler 回了不可快取的狀態碼——這次沒有成功，釋放 key 讓重試重新執行。
      // 這是 fail() 唯一還該出現在成功路徑上的地方。
      if (!succeeded) {
        await this.store.fail(storeKey);
        return result;
      }

      // 成功了，但沒有經過 res.json()——檔案下載走 res.end()，就是這一種。
      // 沒有可重播的回應，但業務操作確實做完了。
      if (responseBody === undefined) {
        await this.markUnavailable(storeKey, req, routeOptions, "no_response_body");
        return result;
      }

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
        // 回應存不下來（資料庫故障，或大於 maxResponseBytes）。先前這裡只記
        // 一筆日誌就回傳成功，於是那一列留在 pending：租約到期之後重試會重新
        // 執行一個已經成功的操作，而客戶端兩次都看到成功。
        await this.markUnavailable(storeKey, req, routeOptions, "store_failed");
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

  /**
   * 把 key 標成「成功執行完，但回應沒有保存」，讓重試拿到 409 而不是重新執行。
   *
   * 這一步自己也可能失敗。失敗的話那一列會留在 pending，於是重試在租約到期前
   * 拿到 409、之後可以重新執行——也就是修正前的行為。這是唯一無法再往下收斂的
   * 殘餘情況（要救它得在同一個交易裡完成業務操作與 idempotency 寫入，而框架
   * 管不到 handler 的交易邊界），所以它必須是一筆 error 而不是 warn。
   */
  async markUnavailable(storeKey, req, routeOptions, reason) {
    try {
      await this.store.markUnavailable(storeKey, { ttlMs: routeOptions.ttlMs });
    } catch (error) {
      void this.logger?.error?.(
        "idempotency.store.mark_unavailable_failed",
        "An idempotency key could not be closed after its work succeeded; a retry may execute it again",
        {
          requestId: req.requestId || null,
          path: req.apiRoute?.path ?? null,
          reason,
          pendingLeaseMs: this.config.pendingLeaseMs,
          error: { name: error.name, message: error.message }
        }
      );
    }
  }

  /** 刪除過期紀錄。由 IdempotencyPurgeJob 以 cluster scope 排程。 */
  async purge() {
    const { removed, exhausted } = (await this.store.purge?.()) ?? {
      removed: 0,
      exhausted: false
    };

    if (removed > 0) {
      await this.logger?.info?.(
        "idempotency.purged",
        "Expired idempotency records were removed",
        { removedRecords: removed, storeAdapter: this.config.storeAdapter }
      );
    }

    if (exhausted) {
      // 清理追不上產生速度，表會單調成長。這件事沒有其他徵兆——過期判斷是
      // 逐筆做的，所以行為完全正常，只是表越來越大。
      await this.logger?.warn?.(
        "idempotency.purge_incomplete",
        "Idempotency purge hit its batch limit; expired records are outpacing cleanup",
        {
          removedRecords: removed,
          purgeMaxBatches: this.config.purgeMaxBatches,
          remedy: "Raise idempotency.purgeMaxBatches, or shorten defaultTtlMs."
        }
      );
    }

    return removed;
  }

  async shutdown() {
    await this.store.close?.();
  }
}
