export class RateLimitStore {
  // Shared adapters must perform this sliding-window decision atomically so all
  // application instances observe one quota for the same key.
  async consume(_key, _options) {
    throw new Error(`${this.constructor.name} must implement consume()`);
  }

  /**
   * 週期性清除過期項目，由排程器呼叫。共用 adapter（Redis 之類）多半有原生
   * TTL，不需要做任何事，所以預設是 no-op。
   */
  async purgeExpired(_options) {}

  async close() {}
}

export class MemoryRateLimitStore extends RateLimitStore {
  constructor({ now = Date.now } = {}) {
    super();
    this.now = now;
    this.entries = new Map();
    this.lastCleanupAt = 0;
  }

  async consume(key, { limit, windowMs }) {
    const now = this.now();
    const cutoff = now - windowMs;
    const timestamps = (this.entries.get(key) || []).filter(
      (timestamp) => timestamp > cutoff
    );

    this.cleanup(now, cutoff, windowMs);

    if (timestamps.length >= limit) {
      this.entries.set(key, timestamps);
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: Math.max(1, timestamps[0] + windowMs - now)
      };
    }

    timestamps.push(now);
    this.entries.set(key, timestamps);
    return {
      allowed: true,
      remaining: Math.max(0, limit - timestamps.length),
      retryAfterMs: 0
    };
  }

  cleanup(now, cutoff, windowMs) {
    if (now - this.lastCleanupAt < Math.max(windowMs, 60000)) {
      return;
    }

    this.purge(now, cutoff);
  }

  /**
   * 排程器驅動的清理，不看 lastCleanupAt。
   *
   * consume() 觸發的 cleanup() 只在有流量時才跑，所以閒置期間過期的項目會一直
   * 留在記憶體裡。這條路徑讓清理與流量脫鉤。
   */
  async purgeExpired({ windowMs }) {
    const now = this.now();
    this.purge(now, now - windowMs);
  }

  purge(now, cutoff) {
    for (const [key, timestamps] of this.entries) {
      const active = timestamps.filter((timestamp) => timestamp > cutoff);

      if (active.length === 0) {
        this.entries.delete(key);
      } else {
        this.entries.set(key, active);
      }
    }

    this.lastCleanupAt = now;
  }

  async close() {
    this.entries.clear();
  }
}
