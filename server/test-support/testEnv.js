// 由 `node --test --import` 在任何測試模組載入前執行。
//
// config/jwt.js 讀取 JWT_SECRET 且刻意沒有預設值，所以測試必須自行提供一組。
// 這比在程式碼裡留一個「只供開發」的預設密鑰安全：測試用的值留在測試範圍內，
// 不會意外成為正式環境的後備值。
process.env.JWT_SECRET ||= "test-only-jwt-secret-with-at-least-32-characters";
