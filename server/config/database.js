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

  // 等候連線的請求數上限；0 代表不限制排隊數量。
  queueLimit: 0,

  // 單次 SQL query/execute 的預設 timeout，單位為毫秒。可由每次呼叫覆蓋；
  // 超時會包裝為 DATABASE_QUERY_TIMEOUT，不會向客戶端公開 SQL 或參數。
  queryTimeoutMs: Number(process.env.DB_QUERY_TIMEOUT_MS || 10000),

  // transaction callback 的最長執行時間，單位為毫秒。callback 應監察傳入的
  // signal 並停止後續工作，超時時框架會 rollback transaction。
  transactionTimeoutMs: Number(process.env.DB_TRANSACTION_TIMEOUT_MS || 30000)
};

export default databaseConfig;
