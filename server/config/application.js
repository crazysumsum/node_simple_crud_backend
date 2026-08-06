const applicationConfig = {
  // Express HTTP server 監聽的主機。正式環境若由同機 reverse proxy 連入可保留
  // 127.0.0.1；容器環境通常設為 0.0.0.0。
  host: process.env.APP_HOST || "127.0.0.1",

  // Express HTTP server 監聽連接埠。0 只應用於自動測試，由作業系統分配臨時 port。
  port: Number(process.env.APP_PORT || 3000),

  // API 已離開限流隊列、開始 authentication/validation/handler 後的最長處理時間，
  // 單位為毫秒。單一 API 可在 Handler 的 static api.timeoutMs 覆蓋此預設值。
  requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS || 30000),

  // Graceful shutdown 最長等待時間，單位為毫秒。超時後會強制關閉剩餘 HTTP 連線，
  // 然後繼續關閉 MySQL pool 及 flush logs，避免部署或重啟永久卡住。
  shutdownTimeoutMs: Number(process.env.SHUTDOWN_TIMEOUT_MS || 30000)
};

export default applicationConfig;
