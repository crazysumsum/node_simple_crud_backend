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
    // Express trust proxy 設定。false 代表不信任代理；正整數代表可信任的代理 hop 數。
    // 正式環境若只有一層 Nginx，可將 TRUST_PROXY 設為 1。避免直接使用 true。
    trustProxy: process.env.TRUST_PROXY || "false",

    // 是否強制 HTTPS。部署在 TLS reverse proxy 後方時設 ENFORCE_HTTPS=true，
    // 並正確設定 TRUST_PROXY，Express 才能安全讀取 X-Forwarded-Proto。
    enforceHttps: process.env.ENFORCE_HTTPS === "true"
  }
};

export default securityConfig;
