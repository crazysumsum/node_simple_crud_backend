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
          input: req.input
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
      await this.store.fail(storeKey).catch(() => {});
      throw error;
    } finally {
      res.json = originalJson;
    }
  }

  close() {
    return this.store.close?.();
  }
}
