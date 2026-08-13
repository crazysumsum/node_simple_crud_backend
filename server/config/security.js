const securityConfig = {
  // 是否啟用 Helmet security headers，包括 HSTS、frame protection、
  // MIME sniffing protection、referrer policy 及移除 X-Powered-By 等。
  helmetEnabled: true,

  // 是否額外由 Express 明確關閉 X-Powered-By，減少伺服器技術指紋。
  hidePoweredBy: true,

  // JSON request body 最大容量。支援 b、kb、mb，例如 100kb 或 1mb。
  // 超過限制時統一回傳 HTTP 413，不會進入 authentication 或 handler。
  jsonBodyLimit: "100kb",

  cors: {
    // 允許的瀏覽器 Origin，以逗號分隔。不可使用 *；無 Origin 的後台服務請求不受影響。
    // 可透過 CLIENT_URL 環境變數覆蓋，例如 https://erp.example.com。
    allowedOrigins:
      process.env.CLIENT_URL ||
      "http://localhost:5173,http://127.0.0.1:5173",

    // CORS preflight 允許的 HTTP methods。
    allowedMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],

    // 瀏覽器可以發送的 request headers。
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-Request-Id",
      "Idempotency-Key"
    ],

    // 允許瀏覽器 JavaScript 讀取的 response headers。
    exposedHeaders: [
      "X-Request-Id",
      "API-Version",
      "Deprecation",
      "Sunset",
      "Link",
      "Idempotency-Replayed"
    ],

    // 是否允許跨域 cookie/credentials。目前 JWT 使用 Authorization header，因此預設關閉。
    credentials: false,

    // 瀏覽器可快取 CORS preflight 結果的秒數。
    maxAgeSeconds: 600
  },

  reverseProxy: {
    // 誰送來的 X-Forwarded-For 可以相信。false 代表都不信。
    //
    // 兩種寫法，差別是「信任位置」還是「信任身分」：
    //
    //   跳數    TRUST_PROXY=1，代表從右邊數一跳是自己的代理。
    //           只適用於單一入口。它數的是位置，所以只要有任何一條入口路徑
    //           比這個數字短——CDN 加直連 LB、多區域、對特定路徑 bypass
    //           CDN——那條路徑上客戶端自己送的那一段就會被算進信任範圍，
    //           req.ip 從此由客戶端指定。
    //
    //   信任來源  TRUST_PROXY="loopback, 10.0.0.0/8"，接受 IP、CIDR，以及
    //           loopback／linklocal／uniquelocal。走到第一個不在範圍內的
    //           位址就停，與鏈的長度無關。**多入口請用這個。**
    //
    // 不接受 true：那等於相信整條 X-Forwarded-For，任何客戶端都能偽造出
    // 任意 req.ip。
    //
    // 這個值設錯不會有任何徵兆。req.ip 餵三個地方——IP 限流、公開 route 的
    // idempotency scope、日誌的 clientIp——被污染時三者一起失準。
    trustProxy: process.env.TRUST_PROXY || "false",

    // 是否強制 HTTPS。部署在 TLS reverse proxy 後方時設 ENFORCE_HTTPS=true，
    // 並正確設定 TRUST_PROXY，Express 才能安全讀取 X-Forwarded-Proto。
    enforceHttps: process.env.ENFORCE_HTTPS === "true"
  }
};

export default securityConfig;
