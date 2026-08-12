export class RateLimitStore {
  // Shared adapters must perform this sliding-window decision atomically so all
  // application instances observe one quota for the same key.
  async consume(_key, _options) {
    throw new Error(`${this.constructor.name} must implement consume()`);
  }

  /**
   * 主動清除 before 之前的所有記錄，由 RateLimitPurgeJob 定時呼叫。
   *
   * 共享 adapter 通常靠儲存層自己的 TTL 過期，不需要覆寫；記憶體 adapter 沒有
   * TTL，不掃就會一直長。回傳被刪掉的 key 數量供排程日誌記錄。
   */
  async purge(_options) {
    return 0;
  }

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

  /**
   * 流量觸發的清理。刻意保留：排程器或 purge job 被停用時，清理能力不該跟著
   * 消失，只是退回「有流量才清」。
   */
  cleanup(now, cutoff, windowMs) {
    if (now - this.lastCleanupAt < Math.max(windowMs, 60000)) {
      return;
    }

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

  /**
   * 排程觸發的清理，不受 cleanup() 的節流限制。一台沒有流量的實例先前永遠不會
   * 走到 consume()，於是最後一波訪客的記錄會一直留在記憶體裡。
   */
  async purge({ before } = {}) {
    const cutoff = Number.isFinite(before) ? before : this.now();
    let removedKeys = 0;

    for (const [key, timestamps] of this.entries) {
      const active = timestamps.filter((timestamp) => timestamp > cutoff);

      if (active.length === 0) {
        this.entries.delete(key);
        removedKeys += 1;
      } else {
        this.entries.set(key, active);
      }
    }

    this.lastCleanupAt = this.now();
    return removedKeys;
  }

  async close() {
    this.entries.clear();
  }
}
