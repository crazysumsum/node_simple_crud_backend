import { revealSecret, secretValue } from "./SecretValue.js";

const SUPPORTED_ALGORITHMS = new Set(["HS256", "HS384", "HS512"]);

const DURATION_PATTERN = /^(\d+)(s|m|h|d|w)$/;
const UNIT_SECONDS = Object.freeze({ s: 1, m: 60, h: 3600, d: 86400, w: 604800 });

/**
 * expiresIn 必須是一個看得懂的時長。
 *
 * jsonwebtoken 收到字串時一律交給 ms()，而 ms("3600") 是 3600 毫秒不是 3600
 * 秒——JWT_EXPIRES_IN=3600 會簽出 3 秒壽命的 token，而且沒有任何地方會說出來。
 * "banana" 則是通過全部啟動驗證，等到第一次有人登入才爆。
 *
 * 只接受帶單位的整數。ms() 還吃 "1.5h"、"2 hours"、"1y"，但那些寫法我們沒有
 * 逐一比對過，而一個「看起來像設定值、實際算出來是別的數字」的東西正是這裡要
 * 擋的。收窄到驗證過的子集，比多支援幾種寫法值得。
 */
function durationSeconds(value, key) {
  const match = DURATION_PATTERN.exec(String(value ?? "").trim());

  if (!match) {
    throw new Error(
      `JWT config "${key}" must be a whole number with a unit of s, m, h, d or w ` +
        "(for example 2h). A bare number means milliseconds to jsonwebtoken, not seconds."
    );
  }

  const seconds = Number(match[1]) * UNIT_SECONDS[match[2]];

  if (seconds <= 0) {
    throw new Error(`JWT config "${key}" must be greater than zero`);
  }

  return seconds;
}

function requiredText(value, key) {
  const text = String(value || "").trim();

  if (!text) {
    throw new Error(`JWT config "${key}" must be a non-empty string`);
  }

  return text;
}

export function normalizeJwtConfig(source) {
  // 密鑰在每個環境都是必要的。舊版只在 NODE_ENV=production 時強制，而 NODE_ENV
  // 未設定時會落回 "development"，等於漏設環境變數就會靜默採用一組寫死的密鑰。
  const secret = revealSecret(source?.secret).trim();

  if (!secret) {
    throw new Error(
      "JWT_SECRET is required. Set it to a random value of at least 32 characters."
    );
  }

  const algorithm = requiredText(source?.algorithm, "algorithm");
  const clockToleranceSeconds = Number(source?.clockToleranceSeconds);
  const expiresIn = requiredText(source?.expiresIn, "expiresIn");

  // 解析出來的秒數刻意不留下來：撤銷改用版本號之後，已經沒有任何跨檔檢查需要
  // 它了。這裡呼叫它純粹是為了驗證格式，原字串照樣交給 jwt.sign() 自己解析。
  durationSeconds(expiresIn, "expiresIn");

  if (secret.length < 32) {
    throw new Error("JWT config secret must contain at least 32 characters");
  }

  if (!SUPPORTED_ALGORITHMS.has(algorithm)) {
    throw new Error(`JWT config algorithm is unsupported: ${algorithm}`);
  }

  if (!Number.isInteger(clockToleranceSeconds) || clockToleranceSeconds < 0) {
    throw new Error(
      'JWT config "clockToleranceSeconds" must be a non-negative integer'
    );
  }

  return Object.freeze({
    // 包起來之後，把整份設定寫進日誌或錯誤 context 只會得到 [REDACTED]。
    secret: secretValue(secret, "JWT secret"),
    issuer: requiredText(source?.issuer, "issuer"),
    audience: requiredText(source?.audience, "audience"),
    algorithm,
    expiresIn,
    clockToleranceSeconds,
    headerName: requiredText(source?.headerName, "headerName").toLowerCase(),
    authScheme: requiredText(source?.authScheme, "authScheme")
  });
}
