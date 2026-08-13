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
 *
 * 5. key 的數量要有上界。限流器為每個沒見過的來源分配狀態，而「沒見過」的
 *    判斷由對方控制——偽造來源永遠是新桶，新桶永遠是滿的，一個都擋不下來，
 *    所以限流器本身就是這個攻擊的放大器。共享後端通常靠 TTL 與記憶體上限
 *    政策（例如 Redis 的 maxmemory-policy）處理；記憶體實作見 MemoryRateLimitStore。
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

/** 淘汰時隨機取樣的數量。見 evictOne()。 */
export const EVICTION_SAMPLE_SIZE = 8;

/**
 * 記憶體 token bucket。
 *
 * 一個桶就是兩個數字，所以狀態是 O(1)——先前的滑動窗口日誌是 O(limit)，每個
 * key 存一個時間戳陣列，而且每個請求都要 filter() 出一個新陣列。這裡的熱路徑
 * 不配置任何物件（既有的桶就地改兩個欄位），佔用也不再隨 limit 成長。
 *
 * 但 key 的**數量**是另一回事，而且它是外部可控的：
 *
 *   撐大記憶體的全部是「已經回滿」的桶。欠著 token 的桶才在做限流，而它的
 *   數量有天然上界——最近 windowMs 內發過請求的來源數，預設 1 秒窗口下就算
 *   15,000 req/s 也只有約 15,000 個。回滿的桶不帶任何資訊（刪掉再重建結果
 *   一樣），卻因為清理被節流成 60 秒一次而堆到 90 萬個。
 *
 * 所以兩道防線：sweepThreshold 讓清理在 key 變多時不受節流限制（把天花板拉
 * 低），maxTrackedKeys 是真的上界（保證有天花板）。少任何一道都不完整——前者
 * 只是降低成長速度，後者單獨用則會讓每個請求都在淘汰。
 */
export class MemoryRateLimitStore extends RateLimitStore {
  constructor({ now = Date.now, maxTrackedKeys = 100000, onKeysExhausted } = {}) {
    super();
    this.now = now;
    this.buckets = new Map();
    this.lastCleanupAt = 0;
    this.maxTrackedKeys = maxTrackedKeys;
    this.onKeysExhausted = onKeysExhausted ?? null;
    // 到了這個數量就不管節流直接掃。取上限的一半：夠高，正常流量碰不到；夠
    // 低，碰到時離真正的上限還有一半的餘裕可以慢慢清。
    this.sweepThreshold = Math.max(1, Math.floor(maxTrackedKeys / 2));
    this.evictedKeys = 0;
  }

  /** 目前追蹤的 key 數，以及累計淘汰過幾個。供限流器的統計使用。 */
  stats() {
    return {
      trackedKeys: this.buckets.size,
      maxTrackedKeys: this.maxTrackedKeys,
      evictedKeys: this.evictedKeys
    };
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

    // 只有新 key 會把 Map 撐大。cleanup() 剛跑過，所以還在上限就代表這些桶
    // 都是真的在用的。
    if (!this.buckets.has(key) && this.buckets.size >= this.maxTrackedKeys) {
      this.evictOne(key);
    }

    this.buckets.set(key, next);

    return { allowed: true, remaining: Math.floor(tokens - 1), retryAfterMs: 0 };
  }

  /**
   * 流量觸發的清理。刻意保留：排程器或 purge job 被停用時，清理能力不該跟著
   * 消失，只是退回「有流量才清」。
   */
  cleanup(now, windowMs) {
    // 節流是為了避免每個請求都掃一次 Map，那是對的——但它不該是唯一條件。
    // key 數量本身就是「該掃了」的訊號，而且正是攻擊時唯一會動的那個訊號。
    // 沒有這個例外的話，60 秒的節流就是攻擊者的 60 秒自由累積窗口。
    if (
      this.buckets.size < this.sweepThreshold &&
      now - this.lastCleanupAt < Math.max(windowMs, 60000)
    ) {
      return;
    }

    this.removeRefilled(now - windowMs);
    this.lastCleanupAt = now;
  }

  /**
   * 騰出一個位置給新 key。
   *
   * 到上限時三種做法只有一種能用：拒絕新 key 等於讓攻擊者關掉所有新訪客的
   * 服務（把限流器變成完整的 DoS 工具）；對新 key 放行不限流等於讓攻擊者一次
   * 關掉限流；只剩淘汰。
   *
   * 淘汰「token 最多」的：token 越多代表欠得越少，淘汰它送出去的免費配額最少。
   * 這個排序在洪水攻擊下正好是我們要的——攻擊者的桶各只用過一次（limit - 1
   * 個 token，幾乎全滿），真正在被限流的重度使用者則是低 token，所以攻擊者
   * 的 key 會先被淘汰，被限流的人留下。
   *
   * 隨機取樣而不是找全域最大值：後者是 O(n)，滿載時每個請求一次就成了 O(n²)。
   * 取樣是 Redis 近似 LRU 的同一招——8 個樣本抓到「前 1/8 滿」的機率約 96%，
   * 而這裡本來就不需要精確，只需要不要總是淘汰到最欠的那個。
   */
  evictOne(incomingKey) {
    const iterator = this.buckets.keys();
    const size = this.buckets.size;
    let victimKey = null;
    let victimTokens = -Infinity;

    // Map 沒有隨機存取，所以用「從迭代器的隨機起點連續取樣」近似。Map 的迭代
    // 順序是插入順序，連續的一段就是時間上相近的一批——攻擊流量下這正好整段
    // 都是攻擊者的 key。
    const start = Math.floor(Math.random() * Math.max(1, size - EVICTION_SAMPLE_SIZE));

    for (let i = 0; i < start; i += 1) {
      iterator.next();
    }

    for (let i = 0; i < EVICTION_SAMPLE_SIZE; i += 1) {
      const { value: key, done } = iterator.next();

      if (done) {
        break;
      }

      const tokens = this.buckets.get(key).tokens;

      if (tokens > victimTokens) {
        victimTokens = tokens;
        victimKey = key;
      }
    }

    if (victimKey === null) {
      return;
    }

    this.buckets.delete(victimKey);
    this.evictedKeys += 1;
    // 淘汰是正確的處理，但它同時意味著有人的配額被無償重置了——限流的保證
    // 在這一刻已經不成立。呼叫端負責節流，這裡只管報告。
    this.onKeysExhausted?.({
      trackedKeys: this.buckets.size,
      maxTrackedKeys: this.maxTrackedKeys,
      evictedKeys: this.evictedKeys,
      incomingKey
    });
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
