const databaseConfig = {
  // MySQL 主機名稱或 IP。可透過 DB_HOST 環境變數覆蓋；本機預設為 127.0.0.1。
  host: process.env.DB_HOST || "127.0.0.1",

  // MySQL TCP 連接埠。可透過 DB_PORT 環境變數覆蓋；MySQL 預設為 3306。
  port: Number(process.env.DB_PORT || 3306),

  // 登入 MySQL 使用的帳號。可透過 DB_USER 環境變數覆蓋。
  user: process.env.DB_USER || "root",

  // MySQL 帳號密碼。只應存放在 DB_PASSWORD 環境變數，不應把正式密碼寫入程式碼。
  password: process.env.DB_PASSWORD || "",

  // 系統連接的預設資料庫名稱。可透過 DB_NAME 環境變數覆蓋。
  database: process.env.DB_NAME || "erp_dev",

  // 可選的 MySQL Unix socket 路徑。設定 DB_SOCKET_PATH 後會優先使用 socket 連線；
  // 未設定時使用上面的 host 和 port 進行 TCP 連線。
  socketPath: process.env.DB_SOCKET_PATH || undefined,

  // 連線池滿載時是否等待可用連線。設為 false 時會立即回報無可用連線。
  waitForConnections: true,

  // 連線池最多同時建立的 MySQL 連線數，應按資料庫容量及 API 負載調整。
  connectionLimit: 10,

  // 等候連線的請求數上限。**不要設 0**——0 是 mysql2 的「不限制」，等待者會
  // 無上限累積：實測連線上限 2、送進 200 個查詢，198 個全部被收下排隊。
  //
  // 為什麼會累積到那個地步：route 逾時只是回了 504 並釋放限流槽位，被放棄的
  // 那個等待者還在隊列裡，而且吊著整個已經回應完畢的請求（req/res、request
  // scope、解析好的 body）。只要資料庫比 route 逾時慢，每過一個逾時週期就多
  // 累積一批，而且永遠不會排空。
  //
  // 超出上限時 mysql2 立刻拒絕，框架會轉成 503 + Retry-After——這是負載問題，
  // 不是伺服器故障。
  //
  // 值不能小於 requestLimiter.maxConcurrentRequests 減去 connectionLimit，
  // 否則正常滿載時就會開始拒絕。啟動時會檢查。
  queueLimit: Number(process.env.DB_QUEUE_LIMIT || 200),

  // 等待連線池分配一條連線的上限，單位為毫秒。
  //
  // 這一段原本完全沒有上限：下面的 queryTimeoutMs 是 mysql2 的查詢逾時，而它
  // 在 Query.start() 才起算——也就是拿到連線之後。實測把連線佔住、再送 20 個
  // timeout 設 200ms 的查詢，它們在 5708ms「成功」，那 200ms 從頭到尾沒有作用。
  acquireTimeoutMs: Number(process.env.DB_ACQUIRE_TIMEOUT_MS || 5000),

  // 單次 SQL query/execute 的預設 timeout，單位為毫秒。可由每次呼叫覆蓋；
  // 超時會包裝為 DATABASE_QUERY_TIMEOUT，不會向客戶端公開 SQL 或參數。
  //
  // 只涵蓋「拿到連線之後」那一段，等連線的時間由上面的 acquireTimeoutMs 管。
  // 兩者相加必須小於 application.requestTimeoutMs，否則 route 逾時會先到，
  // 又回到「已經回應但工作還掛著」的狀態。啟動時會檢查。
  queryTimeoutMs: Number(process.env.DB_QUERY_TIMEOUT_MS || 10000),

  // 查詢逾時或被 abort 之後，那條連線怎麼處理。
  //
  //   "destroy"  關掉它，讓連線池另外建一條。池子容量立刻回來。
  //   "release"  還回池子。
  //
  // 預設 destroy，因為逾時之後這條連線的狀態是未知的：
  //
  //   容量      release 根本不會讓容量回來。mysql2 的 pool.query() 是在查詢
  //             命令的 'end' 事件才 release，而逾時走的是 onResult——呼叫端
  //             脫身了，連線還被 checked out 著，直到被放棄的查詢在 MySQL 上
  //             自己跑完。實測：呼叫端 508ms 拿到逾時，下一個查詢等了 3506ms。
  //             改成 destroy 之後是 1ms。
  //
  //   狀態      mysql2 的 resetOnRelease 預設 false，release 不發
  //             COM_RESET_CONNECTION。實測前一個使用者設的 @tenant_id 與
  //             SESSION 隔離等級，下一個使用者原封不動繼承（threadId 相同）。
  //             未提交的交易、GET_LOCK 的鎖、暫存表也一樣會跟過去。
  //
  // 代價是要重建連線。本機 loopback 實測約 1ms，可以忽略；但跨網段加 TLS
  // 握手可能是 20–100ms，而逾時往往成批出現。資料庫在遠端、或託管服務對連線
  // 建立速率有限制時，可以改成 "release"——前提是你接受上面那兩件事。
  //
  // 普通的 SQL 錯誤（語法錯、ER_DUP_ENTRY）不受這個設定影響：那種情況連線
  // 狀態是明確的，一律 release。
  abandonedConnectionAction:
    process.env.DB_ABANDONED_CONNECTION_ACTION || "destroy",

  // 整個 transaction 的最長時間，單位為毫秒——涵蓋 BEGIN、callback、以及
  // COMMIT／ROLLBACK。callback 應監察傳入的 signal 並停止後續工作。
  //
  // 期限一定要蓋到 COMMIT。先前它在 commit 之前就被解除，於是一個永不回應的
  // COMMIT 沒有任何東西中斷得了——連線既不會還也不會毀，直接從池子裡消失，
  // 累積到 connectionLimit 條整個池子就死了。
  //
  // 超時之後連線一律 destroy。要注意 COMMIT 超時與其他階段超時的意義不同：
  // 其他階段確定沒有提交，可以重試；COMMIT 超時的結果是未知的（伺服器可能
  // 已經越過 commit point 只是回應丟了），會回報成
  // DATABASE_TRANSACTION_INDETERMINATE，不可以盲目重試。
  //
  // acquireTimeoutMs 加上這個值必須小於 application.requestTimeoutMs，否則
  // route 先回 504，交易還在跑。啟動時會檢查。
  transactionTimeoutMs: Number(process.env.DB_TRANSACTION_TIMEOUT_MS || 20000),

  // 是否對 MySQL 連線啟用 TLS。DB_HOST 指向非本機資料庫時應設為 true，否則
  // 帳密與查詢內容（含 ERP 資料）都會用明文送出。
  ssl: {
    enabled: process.env.DB_SSL_ENABLED === "true",

    // 憑證頒發機構（CA）的 PEM 內容。多數代管 MySQL（RDS、Cloud SQL 等）用的
    // 是內建信任清單驗不到的 CA，要把它的憑證餵進來才能建立信任鏈。環境變數
    // 存不了多行字串，所以允許把換行寫成字面上的 "\n"。
    ca: process.env.DB_SSL_CA
      ? process.env.DB_SSL_CA.replace(/\\n/g, "\n")
      : undefined,

    // 設為 false 會關閉憑證驗證，形同接受任何憑證。只能用在明確知道風險的情境
    // （例如本機以自簽憑證測試），正式環境不應該關閉。
    rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== "false"
  }
};

export default databaseConfig;
