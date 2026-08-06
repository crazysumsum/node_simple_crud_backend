export class RateLimitStore {
  // Shared adapters must perform this sliding-window decision atomically so all
  // application instances observe one quota for the same key.
  async consume(_key, _options) {
    throw new Error(`${this.constructor.name} must implement consume()`);
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

  async close() {
    this.entries.clear();
  }
}
