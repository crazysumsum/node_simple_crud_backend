import requestConfig from "../../../config/request.js";
import { reportInternalFailure } from "../diagnostics/reportInternalFailure.js";
import { sendError } from "../http/apiResponse.js";
import {
  markRequestProcessingCompleted,
  markRequestResponseEnded,
  onRequestProcessingComplete
} from "../http/requestProcessingLifecycle.js";
import { normalizeRequestLimitsConfig } from "../limiting/normalizeRequestLimitsConfig.js";
import {
  MemoryRateLimitStore,
  RateLimitStore
} from "../limiting/RateLimitStore.js";

const TOO_MANY_REQUESTS = "Too Many Requests";

function requestPath(req) {
  return req.path || String(req.originalUrl || req.url || "").split("?")[0];
}

export class RequestLimiter {
  // 排程器讀這裡來排定工作，與 service 上的 static jobs 是同一份契約。
  static jobs = Object.freeze([
    {
      name: "requestLimits.purgeExpired",
      method: "purgeExpired",
      intervalMs: 60_000,
      timeoutMs: 10_000
    }
  ]);

  constructor({
    config = requestConfig.limits,
    logger,
    time,
    store,
    scheduler = null
  } = {}) {
    this.config = normalizeRequestLimitsConfig(config);
    this.logger = logger;
    this.time = time;

    if (
      !logger ||
      ["debug", "info", "warn", "error"].some(
        (method) => typeof logger[method] !== "function"
      )
    ) {
      throw new TypeError("RequestLimiter requires a system logger");
    }

    if (!time || typeof time.nowMs !== "function" || typeof time.timestamp !== "function") {
      throw new TypeError("RequestLimiter requires a time service");
    }

    this.store = store || new MemoryRateLimitStore({ now: () => time.nowMs() });

    if (
      !(this.store instanceof RateLimitStore) &&
      typeof this.store.consume !== "function"
    ) {
      throw new TypeError("RequestLimiter store must implement consume()");
    }

    this.activeRequests = 0;
    this.queue = [];
    this.shuttingDown = false;
    this.idleWaiters = new Set();

    // 限流器不是 service（它在容器建立之後才由 Application Factory 組出來），
    // 所以排程器是以協作者的身分傳進來的，和 logger、time 一樣。它自己把工作
    // 送出去，維持 push 模式。沒有排程器時仍會走 consume() 觸發的清理。
    scheduler?.register(this);
  }

  /** 由排程器呼叫，讓過期項目的清除不再依賴有沒有流量。 */
  async purgeExpired() {
    await this.store.purgeExpired?.({ windowMs: this.config.ipWindowMs });
  }

  middleware() {
    return (req, res, next) => {
      void this.handle(req, res, next).catch(next);
    };
  }

  async handle(req, res, next) {
    if (!this.config.enabled || !this.isLimitedPath(req)) {
      next();
      return;
    }

    if (this.shuttingDown) {
      this.rejectUnavailable(res);
      return;
    }

    const clientIp = req.ip || req.socket?.remoteAddress || "unknown";
    const requestId = req.requestId || null;

    let rateLimit;

    try {
      rateLimit = await this.store.consume(
        `${this.config.storeKeyPrefix}:ip:${clientIp}`,
        {
          limit: this.config.maxRequestsPerIpPerWindow,
          windowMs: this.config.ipWindowMs
        }
      );
    } catch (error) {
      this.writeSystemLog(
        "error",
        "request.limit.store_failed",
        "Request limit store operation failed",
        {
          requestId,
          storeAdapter: this.config.storeAdapter,
          error: { name: error.name, message: error.message }
        }
      );
      throw error;
    }

    if (this.shuttingDown) {
      this.rejectUnavailable(res);
      return;
    }

    if (!rateLimit.allowed) {
      this.writeSystemLog("warn", "request.limit.ip_exceeded", "IP rate limit exceeded", {
        requestId,
        clientIp,
        method: req.method,
        url: req.originalUrl || req.url,
        maxRequests: this.config.maxRequestsPerIpPerWindow,
        windowMs: this.config.ipWindowMs
      });
      this.reject(
        res,
        Math.max(
          this.config.retryAfterSeconds,
          Math.ceil(rateLimit.retryAfterMs / 1000)
        )
      );
      return;
    }

    const ticket = {
      req,
      res,
      next,
      clientIp,
      requestId,
      queuedAt: null,
      timeout: null,
      closeListener: null
    };

    if (this.activeRequests < this.config.maxConcurrentRequests) {
      this.start(ticket);
      return;
    }

    if (this.queue.length >= this.config.maxQueueSize) {
      this.writeSystemLog("warn", "request.limit.queue_full", "Request queue is full", {
        requestId,
        clientIp,
        method: req.method,
        url: req.originalUrl || req.url,
        activeRequests: this.activeRequests,
        queuedRequests: this.queue.length,
        maxQueueSize: this.config.maxQueueSize
      });
      this.reject(res);
      return;
    }

    this.enqueue(ticket);
  }

  isLimitedPath(req) {
    const path = requestPath(req);
    return (
      path === this.config.apiPathPrefix ||
      path.startsWith(`${this.config.apiPathPrefix}/`)
    );
  }

  enqueue(ticket) {
    ticket.queuedAt = this.time.nowMs();
    ticket.closeListener = () => this.cancelQueuedTicket(ticket, "client_disconnected");
    ticket.res.once("close", ticket.closeListener);
    ticket.timeout = setTimeout(() => {
      if (this.cancelQueuedTicket(ticket, "queue_timeout")) {
        this.writeSystemLog(
          "warn",
          "request.limit.queue_timeout",
          "Queued request timed out",
          {
            requestId: ticket.requestId,
            clientIp: ticket.clientIp,
            method: ticket.req.method,
            url: ticket.req.originalUrl || ticket.req.url,
            queueTimeoutMs: this.config.queueTimeoutMs
          }
        );
        this.reject(ticket.res);
      }
    }, this.config.queueTimeoutMs);
    ticket.timeout.unref?.();
    this.queue.push(ticket);

    this.writeSystemLog("info", "request.limit.queued", "Request added to queue", {
      requestId: ticket.requestId,
      clientIp: ticket.clientIp,
      method: ticket.req.method,
      url: ticket.req.originalUrl || ticket.req.url,
      activeRequests: this.activeRequests,
      queuedRequests: this.queue.length
    });
  }

  cancelQueuedTicket(ticket, reason) {
    const index = this.queue.indexOf(ticket);

    if (index === -1) {
      return false;
    }

    this.queue.splice(index, 1);
    this.clearQueuedTicket(ticket);

    if (reason === "client_disconnected") {
      this.writeSystemLog(
        "info",
        "request.limit.queue_cancelled",
        "Queued request cancelled after client disconnected",
        {
          requestId: ticket.requestId,
          clientIp: ticket.clientIp,
          queuedRequests: this.queue.length
        }
      );
    }

    return true;
  }

  clearQueuedTicket(ticket) {
    if (ticket.timeout) {
      clearTimeout(ticket.timeout);
      ticket.timeout = null;
    }

    if (ticket.closeListener) {
      ticket.res.removeListener("close", ticket.closeListener);
      ticket.closeListener = null;
    }
  }

  start(ticket) {
    const queueWaitMs = ticket.queuedAt === null
      ? 0
      : this.time.nowMs() - ticket.queuedAt;
    this.clearQueuedTicket(ticket);
    this.activeRequests += 1;
    let released = false;

    const release = () => {
      if (released) {
        return;
      }

      released = true;
      this.activeRequests = Math.max(0, this.activeRequests - 1);
      this.drainQueue();
      this.notifyIdle();
    };

    onRequestProcessingComplete(ticket.req, release);
    ticket.res.once("finish", () => markRequestResponseEnded(ticket.req));
    ticket.res.once("close", () => markRequestResponseEnded(ticket.req));

    if (ticket.queuedAt !== null) {
      this.writeSystemLog(
        "info",
        "request.limit.dequeued",
        "Queued request acquired a processing slot",
        {
          requestId: ticket.requestId,
          clientIp: ticket.clientIp,
          queueWaitMs,
          activeRequests: this.activeRequests,
          queuedRequests: this.queue.length
        }
      );
    }

    try {
      ticket.next();
    } catch (error) {
      markRequestProcessingCompleted(ticket.req);
      throw error;
    }
  }

  drainQueue() {
    while (
      this.activeRequests < this.config.maxConcurrentRequests &&
      this.queue.length > 0
    ) {
      const ticket = this.queue.shift();

      if (ticket.res.destroyed || ticket.res.writableEnded) {
        this.clearQueuedTicket(ticket);
        continue;
      }

      this.start(ticket);
    }
  }

  reject(res, retryAfterSeconds = this.config.retryAfterSeconds) {
    if (res.headersSent || res.writableEnded || res.destroyed) {
      return;
    }

    res.setHeader("Retry-After", String(retryAfterSeconds));
    sendError(res, {
      statusCode: 429,
      code: TOO_MANY_REQUESTS,
      message: TOO_MANY_REQUESTS,
      time: this.time
    });
  }

  rejectUnavailable(res) {
    if (res.headersSent || res.writableEnded || res.destroyed) {
      return;
    }

    sendError(res, {
      statusCode: 503,
      code: "SERVICE_UNAVAILABLE",
      message: "Service unavailable",
      time: this.time
    });
  }

  shutdown() {
    this.shuttingDown = true;
    const queuedTickets = this.queue.splice(0);

    for (const ticket of queuedTickets) {
      this.clearQueuedTicket(ticket);
      this.rejectUnavailable(ticket.res);
    }

    this.writeSystemLog(
      "info",
      "request.limit.shutdown",
      "Request limiter stopped accepting new requests",
      {
        activeRequests: this.activeRequests,
        rejectedQueuedRequests: queuedTickets.length
      }
    );

    this.notifyIdle();
    return queuedTickets.length;
  }

  async close() {
    await this.store.close?.();
  }

  waitForIdle(timeoutMs) {
    if (this.activeRequests === 0) {
      return Promise.resolve(true);
    }

    return new Promise((resolve) => {
      const waiter = () => {
        clearTimeout(timeout);
        this.idleWaiters.delete(waiter);
        resolve(true);
      };
      const timeout = setTimeout(() => {
        this.idleWaiters.delete(waiter);
        resolve(false);
      }, timeoutMs);

      this.idleWaiters.add(waiter);
    });
  }

  notifyIdle() {
    if (this.activeRequests !== 0) {
      return;
    }

    for (const waiter of this.idleWaiters) {
      waiter();
    }
  }

  writeSystemLog(level, event, message, context) {
    Promise.resolve(this.logger[level](event, message, context)).catch((error) => {
      reportInternalFailure("logging.limiter_write_failed", error, {
        droppedEvent: event,
        droppedLevel: level
      });
    });
  }
}

export function createRequestLimiter(options) {
  const limiter = new RequestLimiter(options);
  return limiter.middleware();
}
