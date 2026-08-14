/**
 * 請求限流器的全域配置。
 *
 * 限流器的開關由 RequestLimiterService 的 static service.enabled 決定，不在
 * 這裡——一個 service 只能有一個開關，否則「限流為什麼沒生效」會有兩個要查的
 * 地方。停用之後框架照常啟動，只是不掛限流中間件。
 *
 * 此文件只保存配置資料，不應加入 function 或執行任何初始化邏輯。
 */
const requestLimiterConfig = {
  // 限流狀態儲存介面。框架只內建 memory，所以 IP 配額是**每個實例各自計算**
  // 的：部署 N 個實例就是 N 倍速率。啟動時會記一筆 request.limit.started 把這
  // 件事講出來。
  //
  // 需要跨實例的精確配額，就自己實作 RateLimitStore（介面上有四條契約，看
  // RateLimitStore.js 的註解）並用 serviceOptions.requestLimiter.store 注入。
  // 這裡設成非 memory 而沒有注入時，啟動會直接失敗，不會靜默退回記憶體。
  storeAdapter: "memory",

  // 共享限流儲存使用的 key 前綴，避免不同應用互相衝突。
  storeKeyPrefix: "erp-api:rate-limit",

  // 只對此路徑前綴下的請求套用限流。
  apiPathPrefix: "/api",

  // 單一應用實例同一時間最多可執行的請求數量。
  maxConcurrentRequests: 100,

  // 並行請求已滿時，最多容許排隊的請求數量。
  maxQueueSize: 200,

  // 排隊請求最長等待時間（毫秒）；超時後拒絕該請求。
  queueTimeoutMs: 30000,

  // 同一 client IP 的 token bucket 容量，也就是可以一次爆發用掉的請求數。
  maxRequestsPerIpPerWindow: 20,

  // 桶從空回滿所需的時間（毫秒），因此穩態速率是
  // maxRequestsPerIpPerWindow / ipWindowMs。1000 代表每秒 20 個。
  //
  // 回填是連續的而不是整窗釋放：用完 20 個之後每 50ms 補回一個，而不是等滿
  // 一秒才一次放行 20 個。
  ipWindowMs: 1000,

  // 被限流時，Retry-After header 建議客戶端等待的秒數。
  retryAfterSeconds: 1,

  // 記憶體 store 同時追蹤的 key 數量上限。
  //
  // 限流器為每個沒見過的來源分配一個桶，而「沒見過」的判斷完全由對方控制，
  // 所以它自己就是這個攻擊的放大器：偽造的來源永遠是新桶，新桶永遠是滿的，
  // 一個都擋不下來。實測用真的應用、TRUST_PROXY=1、一條 keep-alive 連線每個
  // 請求換一個 X-Forwarded-For，可以用 15,005 key/秒 的速度製造新桶；一個
  // 清理週期（60 秒）就是 90 萬個 key、約 107MB。IPv6 更便宜——一台有 /64
  // 路由的主機不必偽造任何東西就有 1.8×10^19 個真實來源位址。
  //
  // 一個桶約 125 bytes，所以預設 100,000 約等於 12MB。到上限時淘汰「token
  // 最多」的桶：token 越多代表欠得越少，淘汰它送出去的免費配額最少，而洪水
  // 攻擊製造的桶正好都是幾乎全滿的，所以真正在被限流的重度使用者會被留下。
  //
  // 到上限代表限流的保證已經不成立（有人的配額被無償重置），這件事會記一筆
  // error 級別的 request.limit.keys_exhausted。
  maxTrackedKeys: 100000,

  // IPv6 來源聚合到這個前綴長度再計算配額。
  //
  // 直接用完整位址當 key，等於認為 IPv6 的每個位址是一個獨立客戶端。實際上
  // 一個客戶通常整段 /64 都是他的，那 1.8×10^19 個位址是同一個人——不聚合的
  // 話他可以無限繞過配額，而且順便把 key 空間撐爆。
  //
  // /64 是單一客戶的常態分配。有些 ISP 給家庭客戶 /56 甚至 /48，那樣一個客戶
  // 仍然拿得到 256 個以上的 /64；把這個值調小會更保守，代價是同一個 ISP 的
  // 不同客戶可能被算成同一個。IPv4 不受影響。
  ipv6PrefixLength: 64
};

export default requestLimiterConfig;
