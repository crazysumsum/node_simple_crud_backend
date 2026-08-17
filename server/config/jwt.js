const jwtConfig = {
  // JWT 簽署及驗證密鑰，一律由 JWT_SECRET 環境變數提供，至少 32 個字元。
  // 這裡刻意沒有預設值：任何寫進版本控制的密鑰都等同公開，能讓任何人自行簽發
  // 任意 role 及 permission 的 Token。未設定時應用程式會在啟動時直接失敗。
  secret: process.env.JWT_SECRET,

  // Token 簽發者，用來防止其他系統簽發的 Token 被本 API 接受。
  issuer: process.env.JWT_ISSUER || "erp-api",

  // Token 預期使用者，驗證時必須與此值一致。
  audience: process.env.JWT_AUDIENCE || "erp-web",

  // JWT 簽署演算法。驗證時只接受此演算法，防止演算法降級攻擊。
  algorithm: "HS256",

  // 登入成功後簽發的 Token 有效期。必須是整數加上單位 s、m、h、d 或 w，例如
  // 2h、30m、7d。不接受純數字：jsonwebtoken 把字串 "3600" 當成 3600 毫秒，
  // 會簽出 3 秒壽命的 token。這個值在啟動時會與 config/tokenRevocation.js 的
  // retentionSeconds 交叉檢查——保留期蓋不過 token 壽命的話，撤銷記錄被清掉時
  // 已撤銷的 token 會重新有效。
  expiresIn: process.env.JWT_EXPIRES_IN || "2h",

  // 驗證 exp、nbf 等時間欄位時容許的時鐘誤差，單位為秒。
  clockToleranceSeconds: Number(process.env.JWT_CLOCK_TOLERANCE_SECONDS || 5),

  // JWT 所在的 HTTP header 名稱。Express 讀取 header 時不分大小寫。
  headerName: "authorization",

  // Authorization header 使用的認證方案，例如：Authorization: Bearer <token>。
  authScheme: "Bearer"
};

export default jwtConfig;
