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
  retryAfterSeconds: 1
};

export default requestLimiterConfig;
