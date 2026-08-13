import { reportInternalFailure } from "../../framework/diagnostics/reportInternalFailure.js";
import { sendError } from "../../framework/http/apiResponse.js";
import {
  markRequestProcessingCompleted,
  markRequestResponseEnded,
  onRequestProcessingComplete
} from "../../framework/http/requestProcessingLifecycle.js";
import { clientQuotaKey } from "./clientKey.js";
import { normalizeRequestLimiterConfig } from "./normalizeRequestLimiterConfig.js";
import { MemoryRateLimitStore, RateLimitStore } from "./RateLimitStore.js";

const TOO_MANY_REQUESTS = "Too Many Requests";

function requestPath(req) {
  return req.path || String(req.originalUrl || req.url || "").split("?")[0];
}

/**
 * 系統層請求限流：IP token bucket、並行上限、以及滿載時的 FIFO 佇列。
 *
 * 三層的範圍不一樣，這個區分是設計的前提：
 *   IP 配額    是「這個客戶能打多快」，狀態在 store（見 RateLimitStore 的註解，
 *              框架只提供記憶體實作，所以配額是每個實例各自算的）
 *   並行上限   是「這個行程同時能跑幾個請求」，本來就該是每個實例自己的
 *   佇列       裡面躺的是本機的 res 物件，跨實例共享沒有意義
 *
 * 中間件是這個 service 的產出，不是它的替代品——狀態（activeRequests、queue、
 * store、idleWaiters）由 service 持有，middleware() 只是一個閉包。LoggingService
 * 的 requestMiddleware 已經是同一個形狀。
 *
 * 框架不要求它存在：Factory 用 services.get() 取，停用之後應用照常啟動，只是
 * 不掛限流中間件。這是它與排程器同屬的那一類——框架安排它的生命週期先後，但
 * 不依賴它。
 *
 * 關機有三個必須分開的時刻，而容器只給一個：
 *   1. stopAccepting()  停收、拒絕排隊——必須在 HTTP server 關閉之前
 *   2. waitForIdle()    排空在途請求——必須在任何 service 被拆掉之前
 *   3. shutdown()       關閉限流 store——必須在排空之後
 * 前兩步由 Factory 編排，第三步是容器認得的那個名字。shutdown() 冪等，且會補
 * 做第 1 步，讓「不經 Factory 直接用容器」最壞只是排隊拒得晚，而不是 store 洩漏。
 */
export class RequestLimiterService {
  static service = Object.freeze({
    name: "requestLimiter",
    lifecycle: "singleton",
    dependencies: ["logging", "time"],
    // eager 是承重的：Factory 用 services.get() 取，而 get() 只回傳已建立的
    // 實例。改成 lazy 會讓限流器靜默地不掛載——比啟動失敗糟得多。
    eager: true
  });

  constructor({ config, logger, time, store, services, options = {} } = {}) {
    const managed = services && typeof services.require === "function";

    this.config = normalizeRequestLimiterConfig(
      managed ? config?.requestLimiter : config
    );
    this.logger = managed ? services.require("logging").logger : logger;
    this.time = managed ? services.require("time") : time;

    if (
      !this.logger ||
      ["debug", "info", "warn", "error"].some(
        (method) => typeof this.logger[method] !== "function"
      )
    ) {
      throw new TypeError("RequestLimiterService requires a system logger");
    }

    if (
      !this.time ||
      typeof this.time.nowMs !== "function" ||
      typeof this.time.timestamp !== "function"
    ) {
      throw new TypeError("RequestLimiterService requires a time service");
    }

    const injectedStore = store || options.store || null;

    // 非 memory 的 adapter 沒有內建實作。不在這裡擋，設定會靜默退回 memory，
    // 於是多實例部署各自算各自的配額——一個看不出來的限流失效。
    if (!injectedStore && this.config.storeAdapter !== "memory") {
      throw new Error(
        `RateLimitStore adapter must be injected for ${this.config.storeAdapter}`
      );
    }

    this.store =
      injectedStore ||
      new MemoryRateLimitStore({
        now: () => this.time.nowMs(),
        maxTrackedKeys: this.config.maxTrackedKeys,
        onKeysExhausted: (details) => this.reportKeysExhausted(details)
      });
    // 淘汰在攻擊下是每個請求一次，日誌不能跟著跑。節流成每分鐘一則，並帶上
    // 這段期間累計淘汰了幾個——那個數字才是強度。
    this.lastKeysExhaustedLogAt = 0;
    this.keysExhaustedSinceLastLog = 0;

    if (
      !(this.store instanceof RateLimitStore) &&
      typeof this.store.consume !== "function"
    ) {
      throw new TypeError("RequestLimiterService store must implement consume()");
    }

    this.activeRequests = 0;
    this.queue = [];
    this.shuttingDown = false;
    this.closed = false;
    this.idleWaiters = new Set();
  }

  /**
   * 宣告限流是怎麼算的，特別是「配額是每個實例各自算」這一件。
   *
   * 沒有這一筆日誌的話，部署四個實例的人看到設定寫 20，會相信全域是 20/s，
   * 實際上是 80/s——而這個誤解不會有任何徵兆。這跟 scheduler.disabled 是同一個
   * 原則：行為與預期不同時，答案不該要翻原始碼才找得到。
   */
  async initialize() {
    await this.logger.info("request.limit.started", "Request limiting is active", {
      storeAdapter: this.config.storeAdapter,
      // 這個字是重點。
      quotaScope: "instance",
      maxRequestsPerIpPerWindow: this.config.maxRequestsPerIpPerWindow,
      ipWindowMs: this.config.ipWindowMs,
      maxConcurrentRequests: this.config.maxConcurrentRequests,
      maxQueueSize: this.config.maxQueueSize,
      maxTrackedKeys: this.config.maxTrackedKeys,
      ipv6PrefixLength: this.config.ipv6PrefixLength,
      note: "The IP quota is a token bucket counted per instance; N instances allow N times this rate."
    });
  }

  /**
   * key 空間滿了，有人的配額被無償重置。
   *
   * error 而不是 warn：淘汰本身是正確的處理，但它代表限流的保證在這一刻已經
   * 不成立了。這跟「某個 IP 被擋下來」是完全不同的事件，不該混在同一個級別裡。
   */
  reportKeysExhausted({ trackedKeys, maxTrackedKeys, evictedKeys }) {
    this.keysExhaustedSinceLastLog += 1;
    const now = this.time.nowMs();

    if (now - this.lastKeysExhaustedLogAt < 60000) {
      return;
    }

    const evictedSinceLastLog = this.keysExhaustedSinceLastLog;
    this.lastKeysExhaustedLogAt = now;
    this.keysExhaustedSinceLastLog = 0;

    this.writeSystemLog(
      "error",
      "request.limit.keys_exhausted",
      "Rate limit key space is full; quotas are being reset by eviction",
      {
        trackedKeys,
        maxTrackedKeys,
        evictedKeys,
        evictedSinceLastLog,
        note: "A source is minting unseen keys. Check trustProxy, or raise maxTrackedKeys."
      }
    );
  }

  middleware() {
    return (req, res, next) => {
      void this.handle(req, res, next).catch(next);
    };
  }

  async handle(req, res, next) {
    if (!this.isLimitedPath(req)) {
      next();
      return;
    }

    if (this.shuttingDown) {
      this.rejectUnavailable(res);
      return;
    }

    const clientIp = req.ip || req.socket?.remoteAddress || "unknown";
    const requestId = req.requestId || null;
    // IPv6 聚合到前綴再算配額：一整段 /64 通常是同一個客戶，逐個位址計算等於
    // 讓他有 1.8×10^19 份配額，順便在 store 裡留下同樣多的桶。
    const quotaKey = clientQuotaKey(clientIp, this.config.ipv6PrefixLength);

    let rateLimit;

    try {
      rateLimit = await this.store.consume(
        `${this.config.storeKeyPrefix}:ip:${quotaKey}`,
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

  /**
   * 停止接受新請求並拒絕所有排隊中的請求，回傳被拒絕的筆數。
   *
   * 這不是關機——在途請求還在跑，store 也還開著。名字刻意與 shutdown() 分開：
   * 容器只會呼叫 shutdown||close 其中一個，兩者同名會讓 store 永遠關不掉。
   */
  stopAccepting() {
    if (this.shuttingDown) {
      return 0;
    }

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

  /** 清除過期的限流記錄。由 RateLimitPurgeJob 排程，也可以手動觸發。 */
  async purge() {
    return (
      (await this.store.purge?.({
        before: this.time.nowMs() - this.config.ipWindowMs
      })) ?? 0
    );
  }

  /** 容器認得的關閉方法。冪等，且會補做 stopAccepting()。 */
  async shutdown() {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.stopAccepting();
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
