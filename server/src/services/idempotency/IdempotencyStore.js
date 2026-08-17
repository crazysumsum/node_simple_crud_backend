export class IdempotencyStore {
  // begin() must atomically return started, conflict, inProgress, replay,
  // completedWithoutResponse, or capacityExceeded. Shared adapters must
  // provide the same guarantee.
  //
  // options.owner is a fencing token: a random value the caller generates for
  // this one begin() attempt. Shared adapters must persist it alongside the
  // claimed row and require the same value back on complete()/fail()/
  // markUnavailable() before writing — otherwise a caller whose lease expired
  // mid-request can still overwrite or delete the row a different owner has
  // since claimed. Adapters that don't share state across callers (e.g. an
  // in-process map with no cross-instance races) may ignore it.
  async begin(_key, _options) {
    throw new Error(`${this.constructor.name} must implement begin()`);
  }

  // Returns true if the write was applied, false if it was rejected because
  // options.owner no longer matches the row's current lease (someone else
  // already took over the key). Callers should treat false as a signal worth
  // logging, not an error to throw.
  async complete(_key, _response, _options) {
    throw new Error(`${this.constructor.name} must implement complete()`);
  }

  /**
   * 記下「這個 key 已經成功執行完，但回應沒有保存」。
   *
   * 這是這個介面裡唯一為了「不執行第二次」而存在的方法，也是三條路徑共用的
   * 落點：complete() 寫入失敗、回應大於 maxResponseBytes、以及回應根本沒有經過
   * res.json()（檔案下載）。
   *
   * 這三種情況先前都走 fail()，也就是把 key 釋放掉。那讓客戶端可以重試並拿到
   * 一個回應——代價是已經成功的業務操作再執行一次，而客戶端兩次都看到成功。
   * Idempotency 的保證是「只執行一次」，重播回應只是附帶的便利；兩者衝突時
   * 不能放棄前者。
   *
   * 用完整的 ttlMs 而不是 pending 租約：租約的作用是讓崩潰的實例解鎖，而這裡
   * 已經確定執行完了，這一列要活到重播窗口結束為止。
   *
   * 回傳值意義同 complete()：options.owner 沒對上就是 false。
   */
  async markUnavailable(_key, _options) {}

  /**
   * 釋放一個沒有成功的 key，讓重試可以重新執行。
   * 回傳值意義同 complete()：owner 沒對上就是 false。
   */
  async fail(_key, _owner) {}

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

  async begin(key, { fingerprint, ttlMs, pendingLeaseMs = ttlMs, owner = "" }) {
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
        // owner 是這次 begin() 的憑證，理由與 MySqlIdempotencyStore 相同：
        // 單一行程內兩個請求輪流搶同一個 key 時，晚到的 complete／fail 只帶著
        // 呼叫端記得的 key，查表拿到的卻是新持有者的那個物件——沒有 owner
        // 可比，就沒有東西能分辨「這是我的租約」還是「這是接手者的」。
        owner,
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

    if (existing.state === "unavailable") {
      return { state: "completedWithoutResponse" };
    }

    return { state: "replay", response: existing.response };
  }

  async complete(key, response, { ttlMs, owner = "" }) {
    const existing = this.liveEntry(key);

    // state 與 fail() 晚到的删除是同一組理由：只有仍在處理中、且仍是自己的
    // 那一列該被改寫。owner 不對代表這個 key 已經被接手了。
    if (!existing || existing.state !== "pending" || existing.owner !== owner) {
      return false;
    }

    existing.state = "completed";
    existing.response = response;
    existing.expiresAt = this.now() + ttlMs;
    return true;
  }

  async markUnavailable(key, { ttlMs, owner = "" }) {
    const existing = this.liveEntry(key);

    // 只有仍在處理中、且仍是自己的那一列該被改寫。已經 completed 的列被降級成
    // completedWithoutResponse，等於把一個還能重播的回應丟掉；owner 不對代表
    // 這一列已經是別人的租約。
    if (!existing || existing.state !== "pending" || existing.owner !== owner) {
      return false;
    }

    existing.state = "unavailable";
    existing.response = null;
    existing.expiresAt = this.now() + ttlMs;
    return true;
  }

  async fail(key, owner = "") {
    const existing = this.entries.get(key);

    // 不用 liveEntry：一列剛好在這一刻過期但還沒被回收，仍然是它真正持有者
    // 唯一能釋放的對象，語意不該因為掃描的節流時機而改變。owner 不對代表這個
    // key 已經被接手，刪的話會把接手者仍在使用的租約砍掉。
    if (!existing || existing.owner !== owner) {
      return false;
    }

    this.entries.delete(key);
    return true;
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

  /**
   * 只淘汰 completed 的項目。unavailable 不在此列：淘汰一筆 completed 只是讓
   * 重播失效，淘汰一筆 unavailable 卻是把「不重複執行」的保證丟掉。map 被
   * unavailable 塞滿時會回 capacityExceeded，也就是 503——那是安全的方向。
   */
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
