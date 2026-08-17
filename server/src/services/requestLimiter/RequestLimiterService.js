import { reportInternalFailure } from "../../framework/diagnostics/reportInternalFailure.js";
import { sendError } from "../../framework/http/apiResponse.js";
import {
  markRequestProcessingCompleted,
  markRequestResponseEnded,
  onRequestAbandoned,
  onRequestProcessingComplete
} from "../../framework/http/requestProcessingLifecycle.js";
import { clientQuotaKey } from "./clientKey.js";
import { normalizeRequestLimiterConfig } from "./normalizeRequestLimiterConfig.js";
import { MemoryRateLimitStore, RateLimitStore } from "./RateLimitStore.js";
import { redactUrl } from "../logging/redactUrl.js";

const TOO_MANY_REQUESTS = "Too Many Requests";
const STORE_TIMEOUT = Symbol("requestLimiterStoreTimeout");

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
    // 被放棄且已經過了寬限期的 handler。寬限期以內的不計數——客戶端中途按取消
    // 是家常便飯，handler 幾毫秒後就正常返回，那不是洩漏。沒有寬限期的話這個
    // 數字會不停跳動，真正的洩漏就埋在雜訊裡。
    this.abandonedRequests = 0;
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

    // 洩漏的 handler 到達上限：這個行程有真的問題，一個永不返回的 handler 是
    // bug，N 個代表這個 bug 是系統性的。回 503 讓負載平衡把這個實例換掉——被
    // 摘出輪替，好過安靜地一路洩漏下去。
    if (this.abandonedRequests >= this.config.maxAbandonedRequests) {
      this.writeSystemLog(
        "error",
        "request.limit.abandoned_ceiling",
        "Refusing requests because too many handlers never settled",
        {
          requestId: req.requestId || null,
          abandonedRequests: this.abandonedRequests,
          maxAbandonedRequests: this.config.maxAbandonedRequests
        }
      );
      this.rejectUnavailable(res);
      return;
    }

    const clientIp = req.ip || req.socket?.remoteAddress || "unknown";
    const requestId = req.requestId || null;
    // IPv6 聚合到前綴再算配額：一整段 /64 通常是同一個客戶，逐個位址計算等於
    // 讓他有 1.8×10^19 份配額，順便在 store 裡留下同樣多的桶。
    const quotaKey = clientQuotaKey(clientIp, this.config.ipv6PrefixLength);

    let rateLimit;
    let timeoutHandle;
    // 逾時的計時器獨立於 consume()——這是唯一能讓這個 await 有上限的辦法，
    // consume() 本身可能永遠不 resolve（見 store_timeout 分支）。
    const timedOut = new Promise((resolve) => {
      timeoutHandle = setTimeout(() => resolve(STORE_TIMEOUT), this.config.storeOperationTimeoutMs);
      timeoutHandle.unref?.();
    });

    try {
      const consumePromise = this.store.consume(
        `${this.config.storeKeyPrefix}:ip:${quotaKey}`,
        {
          limit: this.config.maxRequestsPerIpPerWindow,
          windowMs: this.config.ipWindowMs
        }
      );
      // 逾時之後這個 promise 可能還在背景跑，沒有人會再 await 它——不接住的話
      // 它遲早 reject 成一個 unhandled rejection。
      consumePromise.catch(() => {});

      const result = await Promise.race([consumePromise, timedOut]);
      clearTimeout(timeoutHandle);

      if (result === STORE_TIMEOUT) {
        this.writeSystemLog(
          "error",
          "request.limit.store_timeout",
          "Rate limit store did not respond in time",
          {
            requestId,
            clientIp,
            storeAdapter: this.config.storeAdapter,
            storeOperationTimeoutMs: this.config.storeOperationTimeoutMs,
            failureMode: this.config.storeFailureMode
          }
        );

        if (this.config.storeFailureMode === "closed") {
          this.rejectUnavailable(res);
          return;
        }

        // open：store 壞了不該連帶讓並行/佇列這兩層本來就與 store 無關的保護
        // 也跟著失效，所以只放行 IP 配額這一項判斷，其餘照舊往下走。
        rateLimit = { allowed: true, remaining: 0, retryAfterMs: 0 };
      } else {
        rateLimit = result;
      }
    } catch (error) {
      clearTimeout(timeoutHandle);
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
        url: redactUrl(req.originalUrl || req.url, (field) => this.logger.isSensitiveField(field)),
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
      closeListener: null,
      abandonedAt: null,
      graceTimer: null,
      leaked: false
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
        url: redactUrl(req.originalUrl || req.url, (field) => this.logger.isSensitiveField(field)),
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
            url: redactUrl(
              ticket.req.originalUrl || ticket.req.url,
              (field) => this.logger.isSensitiveField(field)
            ),
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
      url: redactUrl(
        ticket.req.originalUrl || ticket.req.url,
        (field) => this.logger.isSensitiveField(field)
      ),
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
    // 三態，不是一個布林旗標。被放棄的請求已經從 activeRequests 扣掉了，之後
    // handler 真的 settle 時要扣的是另一個桶——扣錯邊就是同一筆扣兩次，而
    // Math.max(0, …) 會把它藏成「憑空多出來的槽位」。
    let state = "active";

    const abandon = () => {
      if (state !== "active") {
        return;
      }

      state = "abandoned";
      this.activeRequests = Math.max(0, this.activeRequests - 1);
      this.startAbandonGrace(ticket);
      // 槽位立刻還回去：這個請求已經結束了，繼續向活著的流量收費沒有道理。
      this.drainQueue();
      this.notifyIdle();
    };

    const release = () => {
      if (state === "done") {
        return;
      }

      if (state === "abandoned") {
        this.endAbandonGrace(ticket);
      } else {
        this.activeRequests = Math.max(0, this.activeRequests - 1);
      }

      state = "done";
      this.drainQueue();
      this.notifyIdle();
    };

    onRequestAbandoned(ticket.req, abandon);
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

  /**
   * 開始寬限計時。期限內 handler 回來就當作沒事發生過，過了才算洩漏。
   *
   * 這裡不是在等 handler——槽位已經還回去了。等的只是「要不要為這一筆發警報」。
   */
  startAbandonGrace(ticket) {
    ticket.abandonedAt = this.time.nowMs();
    ticket.leaked = false;
    ticket.graceTimer = setTimeout(() => {
      ticket.graceTimer = null;
      ticket.leaked = true;
      this.abandonedRequests += 1;

      // error 而不是 warn：一個永遠不返回的 handler 是 bug，而它先前唯一的
      // 症狀是別人開始收到 429，沒有任何線索指回這條 route。
      this.writeSystemLog(
        "error",
        "request.handler_leaked",
        "Handler never settled after its request was abandoned",
        {
          requestId: ticket.requestId,
          clientIp: ticket.clientIp,
          method: ticket.req.method,
          url: redactUrl(
            ticket.req.originalUrl || ticket.req.url,
            (field) => this.logger.isSensitiveField(field)
          ),
          api: ticket.req.apiRoute || null,
          graceMs: this.config.abandonGraceMs,
          abandonedRequests: this.abandonedRequests,
          maxAbandonedRequests: this.config.maxAbandonedRequests
        }
      );
    }, this.config.abandonGraceMs);
    ticket.graceTimer.unref?.();
  }

  /** handler 終於回來了。期限內就靜靜結束，過了期限的要把計數扣回去。 */
  endAbandonGrace(ticket) {
    if (ticket.graceTimer) {
      clearTimeout(ticket.graceTimer);
      ticket.graceTimer = null;
    }

    if (ticket.leaked) {
      ticket.leaked = false;
      this.abandonedRequests = Math.max(0, this.abandonedRequests - 1);
      this.writeSystemLog(
        "info",
        "request.handler_recovered",
        "A leaked handler finally settled",
        {
          requestId: ticket.requestId,
          api: ticket.req.apiRoute || null,
          abandonedMs: this.time.nowMs() - ticket.abandonedAt,
          abandonedRequests: this.abandonedRequests
        }
      );
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
