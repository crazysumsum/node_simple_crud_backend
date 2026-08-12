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

  /**
   * 主動刪除已過期的紀錄，由 IdempotencyPurgeJob 定時呼叫。
   *
   * 記憶體 adapter 靠自己的掃描回收，共享 adapter 則需要有人來收——沒有人來
   * 收的話，表的大小只會單調成長。
   *
   * 回傳 removed（刪除筆數）與 exhausted（是否因為撞到單輪上限才停手，而不是
   * 因為刪完了）。後者是「清理追不上」唯一的訊號。
   */
  async purge() {
    return { removed: 0, exhausted: false };
  }

  async close() {}
}

// 全域掃描的最小間隔。掃描只負責回收記憶體——過期的判斷是逐筆做的，所以這個
// 數字調錯不會影響正確性，只會影響「過期項目多久之後真的離開記憶體」。正因為
// 正確性不依賴它，它才不需要變成一個設定項。
const CLEANUP_INTERVAL_MS = 60000;

export class MemoryIdempotencyStore extends IdempotencyStore {
  constructor({ maxEntries = 10000, now = Date.now } = {}) {
    super();

    if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
      throw new TypeError("Memory idempotency maxEntries must be a positive integer");
    }

    this.maxEntries = maxEntries;
    this.now = now;
    this.entries = new Map();
    this.lastCleanupAt = null;
  }

  /**
   * 讀出一筆仍在有效期內的項目；過期的當作不存在，並順手刪掉。
   *
   * 這個 O(1) 的檢查是節流全域掃描的前提。少了它，被延後的掃描會讓過期項目
   * 繼續被讀到——一筆過期的 pending 會讓客戶端一直拿到 inProgress，一筆過期的
   * completed 會回放一個早該失效的回應，而 TTL 正是「回放能持續多久」的承諾。
   */
  liveEntry(key) {
    const entry = this.entries.get(key);

    if (!entry) {
      return undefined;
    }

    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }

    return entry;
  }

  async begin(key, { fingerprint, ttlMs, pendingLeaseMs = ttlMs }) {
    this.cleanup();
    const existing = this.liveEntry(key);

    if (!existing) {
      if (this.entries.size >= this.maxEntries) {
        // 容量邊界是唯一不能省掉掃描的地方：map 裡可能塞滿了還沒被回收的過期
        // 項目，照著這個數字回 capacityExceeded 會拒絕一個其實有空位的請求。
        this.cleanup({ force: true });
      }

      if (this.entries.size >= this.maxEntries && !this.evictCompletedEntry()) {
        return { state: "capacityExceeded" };
      }

      this.entries.set(key, {
        state: "pending",
        fingerprint,
        // 處理中的紀錄用租約，不用完整的 TTL：一個掛住的請求不該把 key 鎖到
        // 重播窗口結束。共享 adapter 靠同一個租約在實例崩潰後解鎖，兩邊的語意
        // 因此一致。
        expiresAt: this.now() + pendingLeaseMs,
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
    const existing = this.liveEntry(key);

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

  /**
   * 掃掉所有過期項目。這是 O(n)，而先前它掛在每一次 begin() 上——maxEntries
   * 預設 10000，等於每個 idempotent 請求都走一遍上萬筆。限流器的記憶體 store
   * 一直是節流的，這裡沒有，只是漏了。
   */
  cleanup({ force = false } = {}) {
    const now = this.now();

    if (
      !force &&
      this.lastCleanupAt !== null &&
      now - this.lastCleanupAt < CLEANUP_INTERVAL_MS
    ) {
      return;
    }

    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
      }
    }

    this.lastCleanupAt = now;
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
