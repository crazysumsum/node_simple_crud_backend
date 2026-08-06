const jwtConfig = {
  // JWT 簽署及驗證密鑰。正式環境必須透過 JWT_SECRET 提供高強度隨機值，
  // 不可使用下面只供本機開發的預設密鑰，也不可提交正式密鑰到版本控制。
  secret:
    process.env.JWT_SECRET ||
    "erp-local-development-jwt-secret-change-before-production",

  // 正式環境是否強制要求 JWT_SECRET 環境變數。保持 true 可防止正式系統誤用開發密鑰。
  requireEnvironmentSecretInProduction: true,

  // Token 簽發者，用來防止其他系統簽發的 Token 被本 API 接受。
  issuer: process.env.JWT_ISSUER || "erp-api",

  // Token 預期使用者，驗證時必須與此值一致。
  audience: process.env.JWT_AUDIENCE || "erp-web",

  // JWT 簽署演算法。驗證時只接受此演算法，防止演算法降級攻擊。
  algorithm: "HS256",

  // 登入成功後簽發的 Token 有效期，支援 jsonwebtoken 的時間格式，例如 2h、30m、7d。
  expiresIn: process.env.JWT_EXPIRES_IN || "2h",

  // 驗證 exp、nbf 等時間欄位時容許的時鐘誤差，單位為秒。
  clockToleranceSeconds: Number(process.env.JWT_CLOCK_TOLERANCE_SECONDS || 5),

  // JWT 所在的 HTTP header 名稱。Express 讀取 header 時不分大小寫。
  headerName: "authorization",

  // Authorization header 使用的認證方案，例如：Authorization: Bearer <token>。
  authScheme: "Bearer"
};

export default jwtConfig;
