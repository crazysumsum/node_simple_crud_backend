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
  // 限流狀態儲存介面。memory 適用於單一實例；多實例可使用已註冊的共享 adapter，
  // 並以 serviceOptions.requestLimiter.store 注入。
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

  // 同一 client IP 在一個時間窗口內最多可接受的請求數量。
  maxRequestsPerIpPerWindow: 20,

  // IP 限流時間窗口長度（毫秒）。1000 代表每秒計算一次。
  ipWindowMs: 1000,

  // 被限流時，Retry-After header 建議客戶端等待的秒數。
  retryAfterSeconds: 1
};

export default requestLimiterConfig;
