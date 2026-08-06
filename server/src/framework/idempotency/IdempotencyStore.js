export class IdempotencyStore {
  // begin() must atomically return started, conflict, inProgress, replay, or
  // capacityExceeded. Shared adapters must provide the same guarantee.
  async begin(_key, _options) {
    throw new Error(`${this.constructor.name} must implement begin()`);
  }

  async complete(_key, _response, _options) {
    throw new Error(`${this.constructor.name} must implement complete()`);
  }

  async fail(_key) {}

  async close() {}
}

export class MemoryIdempotencyStore extends IdempotencyStore {
  constructor({ maxEntries = 10000, now = Date.now } = {}) {
    super();

    if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
      throw new TypeError("Memory idempotency maxEntries must be a positive integer");
    }

    this.maxEntries = maxEntries;
    this.now = now;
    this.entries = new Map();
  }

  async begin(key, { fingerprint, ttlMs }) {
    this.cleanup();
    const existing = this.entries.get(key);

    if (!existing) {
      if (this.entries.size >= this.maxEntries && !this.evictCompletedEntry()) {
        return { state: "capacityExceeded" };
      }

      this.entries.set(key, {
        state: "pending",
        fingerprint,
        expiresAt: this.now() + ttlMs,
        response: null
      });
      return { state: "started" };
    }

    if (existing.fingerprint !== fingerprint) {
      return { state: "conflict" };
    }

    if (existing.state === "pending") {
      return { state: "inProgress" };
    }

    return { state: "replay", response: existing.response };
  }

  async complete(key, response, { ttlMs }) {
    const existing = this.entries.get(key);

    if (!existing) {
      return;
    }

    existing.state = "completed";
    existing.response = response;
    existing.expiresAt = this.now() + ttlMs;
  }

  async fail(key) {
    this.entries.delete(key);
  }

  cleanup() {
    const now = this.now();

    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
      }
    }
  }

  evictCompletedEntry() {
    const oldest = [...this.entries.entries()]
      .filter(([, entry]) => entry.state === "completed")
      .sort(
      (left, right) => left[1].expiresAt - right[1].expiresAt
    )[0];

    if (!oldest) {
      return false;
    }

    this.entries.delete(oldest[0]);
    return true;
  }

  async close() {
    this.entries.clear();
  }
}
