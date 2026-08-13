const applicationConfig = {
  // Express HTTP server 監聽的主機。正式環境若由同機 reverse proxy 連入可保留
  // 127.0.0.1；容器環境通常設為 0.0.0.0。
  host: process.env.APP_HOST || "127.0.0.1",

  // Express HTTP server 監聽連接埠。0 只應用於自動測試，由作業系統分配臨時 port。
  port: Number(process.env.APP_PORT || 3000),

  // 全系統唯一的 IANA 時區來源。所有日誌、API timestamp 與應用程式時間服務
  // 都會使用此設定，避免不同元件各自採用 UTC 或不同時區。
  timeZone: process.env.APP_TIME_ZONE || "Asia/Hong_Kong",

  // API 已離開限流隊列、開始 authentication/validation/handler 後的最長處理時間，
  // 單位為毫秒。單一 API 可在 Handler 的 static api.timeoutMs 覆蓋此預設值。
  //
  // 注意它從 handler 階段才開始計時。請求「還在路上」的那一段由下面三個值管，
  // 兩段加起來才是一個請求最多能佔住限流槽位的時間。
  requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS || 30000),

  // ---------------------------------------------------------------------------
  // 以下三個值設定在 socket 層，管的是「請求還沒收完」的那一段。
  //
  // 為什麼需要它們：限流槽位在請求進來的第一時間就被佔住，但 requestTimeoutMs
  // 要等 body 解析完、進了 route 才開始計時。中間這一段如果沒有上限，客戶端
  // 宣告 100KB 卻每分鐘只送幾個位元組，就能用幾個位元組佔住一個槽位——handler
  // 從未執行，所以 requestTimeoutMs 永遠不會觸發。
  //
  // 必須滿足的關係（啟動時會檢查，不符就直接啟動失敗）：
  //
  //   connectionsCheckingIntervalMs
  //     <= headersReceiveTimeoutMs
  //     <= requestReceiveTimeoutMs
  //
  //   requestReceiveTimeoutMs >= requestTimeoutMs
  //   requestReceiveTimeoutMs >= 每一條 route 自己的 timeoutMs
  //
  // 最後兩條的理由：上傳的 body 是在 route timeout 開始計時之後才被讀取的，
  // 所以收取時間會與 handler 時間重疊。收取上限若比 route 的逾時短，Node 會
  // 先把連線切掉，route 的 timeoutMs 對任何會讀 body 的 route 就變成一句空話。
  // ---------------------------------------------------------------------------

  // 收完「整個請求」（header + body）的上限，單位為毫秒。對應 Node 的
  // server.requestTimeout。這是最後一道兜底，要容得下最大的合法上傳：
  // 一個 50MB 的檔案走 1Mbps 的行動網路需要約 400 秒。
  //
  // 框架不設的話 Node 預設是 300000（5 分鐘），對慢速攻擊來說太鬆。
  requestReceiveTimeoutMs: Number(process.env.REQUEST_RECEIVE_TIMEOUT_MS || 120000),

  // 只收 request header 的上限，單位為毫秒。對應 Node 的 server.headersTimeout。
  // header 是固定的小量資料，不需要跟 body 一樣寬鬆。Node 預設 60000。
  headersReceiveTimeoutMs: Number(process.env.HEADERS_RECEIVE_TIMEOUT_MS || 10000),

  // JSON body 收取的上限，單位為毫秒。這一段由框架的看門狗中間件負責，不是
  // Node 的機制——因為上面的 requestReceiveTimeoutMs 要容得下最大的上傳，
  // 對只有 jsonBodyLimit（預設 100kb）那麼大的 JSON body 來說太寬鬆了。
  //
  // 這個值換算出來就是 JSON 請求的最低速率要求：預設 10 秒配 100kb 等於
  // 10 kbps。正常客戶端遠遠超過，慢速攻擊則遠遠達不到。啟動時會把實際換算
  // 出來的速率記進 application.started 日誌，不用自己算。
  //
  // 不影響上傳：multipart 不經過 express.json()，它的 body 在 route timeout
  // 開始之後才被讀取。
  //
  // 另外建議讓它小於 requestLimiter.queueTimeoutMs（預設 30000）。兩者沒有正確
  // 性上的依賴，所以啟動時不檢查，但看門狗若比排隊逾時還慢，慢速連線佔住槽位
  // 的期間排隊的正常請求會先被拒——防護有效，體感卻還是被打掛。
  bodyReceiveTimeoutMs: Number(process.env.BODY_RECEIVE_TIMEOUT_MS || 10000),

  // 上面兩個 socket 層逾時的檢查頻率，單位為毫秒。對應 Node 的
  // connectionsCheckingInterval。
  //
  // 這是實際生效時間的誤差上界，不是可以忽略的細節：Node 預設 30000，實測
  // 一個設成 1500ms 的 requestReceiveTimeoutMs 會在 30004ms 才真的切斷連線。
  // 設定的數字與實際行為差 20 倍。
  connectionsCheckingIntervalMs: Number(
    process.env.CONNECTIONS_CHECKING_INTERVAL_MS || 2000
  ),

  // Graceful shutdown 最長等待時間，單位為毫秒。超時後會強制關閉剩餘 HTTP 連線，
  // 然後繼續關閉 MySQL pool 及 flush logs，避免部署或重啟永久卡住。
  shutdownTimeoutMs: Number(process.env.SHUTDOWN_TIMEOUT_MS || 30000)
};

export default applicationConfig;
