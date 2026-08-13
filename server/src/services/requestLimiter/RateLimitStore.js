/**
 * IP 配額的儲存介面。
 *
 * 演算法是 token bucket：每個 key 一個桶，容量 limit 個 token，以
 * limit / windowMs 的速率持續回填，一個請求扣一個。穩態速率與突發容量都跟
 * 先前的滑動窗口相同，差別只在恢復方式從階梯變成平滑。
 *
 * 框架只提供記憶體實作，配額因此是**每個實例各自計算**的：N 個實例等於 N 倍
 * 速率。這是刻意的取捨——跨實例的精確配額需要每個請求都讀寫共享儲存，而
 * IP 限流在應用層本來就只是最後一道便宜的防線，真正要擋大量流量該在 CDN／WAF
 * 那一層。啟動日誌會把這件事講出來，避免有人部署四個實例卻以為配額是全域的。
 *
 * 需要跨實例精確配額的人自己實作這個介面，並用
 * serviceOptions.requestLimiter.store 注入。storeAdapter 設成非 memory 而沒有
 * 注入時，RequestLimiterService 會在啟動時拋錯，不會靜默退回記憶體。
 *
 * 實作共享 adapter 的四條契約：
 *
 * 1. consume() 的「判斷 + 扣減」必須是一個原子操作——一句 Lua、或一句帶條件的
 *    UPDATE。讀出來、在應用層判斷、再寫回去，在併發下會超額放行。
 *
 * 2. **被拒絕時不可以改動桶。** 一旦推進了「上次回填時間」，已經累積的回填就
 *    沒了，於是持續重試的客戶端永遠回不到一個 token——症狀是「被擋住的 IP 再
 *    也解不開」，而且看起來就像限流很嚴格而已。
 *
 * 3. 清理只能刪**已經完全回滿**的桶（閒置達 windowMs）。刪掉一個沒回滿的桶
 *    等於免費送出它剩下的配額。
 *
 * 4. SQL 後端要把 token 放大成整數（例如千分之一個 token）再運算。回填量是
 *    「經過毫秒 × limit / windowMs」，20/1000 的設定下每毫秒 0.02 個 token，
 *    整數運算會全部歸零。JS 不需要這樣做，因為回填是從 refilledAt 重算而不是
 *    逐次累加，浮點誤差不會累積。
 */
export class RateLimitStore {
  /**
   * 扣一個 token。
   *
   * @param {string} _key
   * @param {{ limit: number, windowMs: number }} _options
   *   limit 是桶容量，windowMs 是從空桶回滿所需的時間。
   * @returns {Promise<{ allowed: boolean, remaining: number, retryAfterMs: number }>}
   */
  async consume(_key, _options) {
    throw new Error(`${this.constructor.name} must implement consume()`);
  }

  /**
   * 主動刪除 before 之前就沒再動過的桶，由 RateLimitPurgeJob 定時呼叫。
   *
   * 共享 adapter 通常靠儲存層自己的 TTL 過期，不需要覆寫；記憶體 adapter 沒有
   * TTL，不掃就會一直長。回傳被刪掉的 key 數量供排程日誌記錄。
   */
  async purge(_options) {
    return 0;
  }

  async close() {}
}

/**
 * 記憶體 token bucket。
 *
 * 一個桶就是兩個數字，所以狀態是 O(1)——先前的滑動窗口日誌是 O(limit)，每個
 * key 存一個時間戳陣列，而且每個請求都要 filter() 出一個新陣列。這裡的熱路徑
 * 不配置任何物件（既有的桶就地改兩個欄位），佔用也不再隨 limit 成長。
 */
export class MemoryRateLimitStore extends RateLimitStore {
  constructor({ now = Date.now } = {}) {
    super();
    this.now = now;
    this.buckets = new Map();
    this.lastCleanupAt = 0;
  }

  async consume(key, { limit, windowMs }) {
    const now = this.now();
    const ratePerMs = limit / windowMs;
    const bucket = this.buckets.get(key);
    // 沒有桶就是滿桶。不必先建立再扣，第一次請求少一次配置。
    //
    // Math.max(0, ...) 擋時鐘回撥：NTP 往回調時 elapsed 會是負的，少了這層
    // 會反過來倒扣 token。
    const tokens = bucket
      ? Math.min(limit, bucket.tokens + Math.max(0, now - bucket.refilledAt) * ratePerMs)
      : limit;

    // 這一輪的清理有可能刪掉的正是這個 key 的桶（閒置夠久就會）。tokens 已經
    // 先算好了，而下面是無條件 set() 而不是就地改 bucket，所以刪掉也會補回來。
    // 拒絕的那條路不寫回，但那條路不可能被影響到：刪除條件是「已完全回滿」，
    // 回滿就代表 tokens === limit >= 1，一定走放行。
    this.cleanup(now, windowMs);

    if (tokens < 1) {
      // 拒絕不改動桶。推進 refilledAt 會把已累積的回填抹掉，持續重試的客戶端
      // 就永遠湊不滿一個 token。
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: Math.ceil((1 - tokens) / ratePerMs)
      };
    }

    // 既有的桶就地改兩個欄位，只有第一次見到這個 key 才配置物件。
    const next = bucket ?? { tokens: 0, refilledAt: 0 };
    next.tokens = tokens - 1;
    next.refilledAt = now;
    this.buckets.set(key, next);

    return { allowed: true, remaining: Math.floor(tokens - 1), retryAfterMs: 0 };
  }

  /**
   * 流量觸發的清理。刻意保留：排程器或 purge job 被停用時，清理能力不該跟著
   * 消失，只是退回「有流量才清」。
   */
  cleanup(now, windowMs) {
    if (now - this.lastCleanupAt < Math.max(windowMs, 60000)) {
      return;
    }

    this.removeRefilled(now - windowMs);
    this.lastCleanupAt = now;
  }

  /**
   * 排程觸發的清理，不受 cleanup() 的節流限制。一台沒有流量的實例先前永遠不會
   * 走到 consume()，於是最後一波訪客的桶會一直留在記憶體裡。
   */
  async purge({ before } = {}) {
    const cutoff = Number.isFinite(before) ? before : this.now();
    const removedKeys = this.removeRefilled(cutoff);
    this.lastCleanupAt = this.now();
    return removedKeys;
  }

  /**
   * 刪除 cutoff 之前就沒再動過的桶。
   *
   * 呼叫端傳進來的 cutoff 是 now - windowMs，而從空桶回滿正好需要 windowMs
   * （容量 limit ÷ 速率 limit/windowMs），所以「閒置到 cutoff 之前」與「已經
   * 回滿」是同一件事。刪一個回滿的桶不損失任何資訊——下次請求重建時本來就是
   * 滿的；刪一個沒回滿的桶則是把它剩下的配額免費送出去。
   */
  removeRefilled(cutoff) {
    let removedKeys = 0;

    for (const [key, bucket] of this.buckets) {
      if (bucket.refilledAt <= cutoff) {
        this.buckets.delete(key);
        removedKeys += 1;
      }
    }

    return removedKeys;
  }

  async close() {
    this.buckets.clear();
  }
}
