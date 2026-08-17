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
  ipv6PrefixLength: 64,

  // 一個請求被判定為「放棄」之後，還願意等 handler 多久才把它當成洩漏。
  //
  // JS 的 Promise 不能取消。逾時只能發出 AbortSignal，一個沒有 race 這個
  // signal 的 handler 會一直跑下去，而它先前會一直佔著並行槽位——實測 4 個
  // 永不 resolve 的 handler 就讓 maxConcurrentRequests=4 的實例對所有後續請求
  // 回 429，關機也必然逾時強制退出。現在回應一結束就把槽位還回去。
  //
  // 需要這段寬限是因為客戶端中途取消是家常便飯：那種請求同樣會被判定為放棄，
  // 但 handler 幾毫秒後就正常返回，不是洩漏。沒有寬限期的話計數會不停跳動，
  // 真正的洩漏埋在雜訊裡。必須遠小於 application.requestTimeoutMs，啟動時會檢查。
  abandonGraceMs: 1000,

  // 過了寬限期仍未返回的 handler 累積到這個數，就停止接受新請求並回 503。
  //
  // 一個永不返回的 handler 是 bug，達到這個數代表那個 bug 是系統性的。被負載
  // 平衡摘出輪替，好過安靜地一路洩漏下去。每一筆都會記一則 error 級別的
  // request.handler_leaked，帶著是哪一條 route。
  maxAbandonedRequests: 100,

  // store.consume() 最多容許跑多久。這是限流器裡唯一一段外部依賴的 await——
  // 框架內建的 memory store 不會卡住，但注入的共享 adapter（例如 Redis）可能
  // 在連線池耗盡或網路分區時永遠不 resolve。少了這個上限，這段 await 完全不
  // 受任何既有機制保護：它比 bodyReceiveTimeout 和 route 的 timeoutMs 都還要
  // 早，兩者都要等它 next() 之後才會啟動；activeRequests/queue 也不會計數，
  // 因為兩者都是 consume() resolve 之後才更動。逾時後會記一筆 error 級別的
  // request.limit.store_timeout。
  storeOperationTimeoutMs: 500,

  // store.consume() 逾時之後怎麼處理這個請求。
  //
  // "closed"：回 503，跟 store 真的丟出錯誤時的效果一致——store 是限流器的
  // 依賴，它不可靠時保守地拒絕新請求。
  // "open"：放行這個請求的 IP 配額檢查，並行/佇列這兩層與 store 無關，照舊
  // 生效——store 的問題不該連帶波及跟它無關的保護。
  //
  // 兩者的安全含義相反，這裡明確寫出來，不依賴 normalizeRequestLimiterConfig
  // 裡的預設值。
  storeFailureMode: "closed"
};

export default requestLimiterConfig;
