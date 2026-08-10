const SUPPORTED_ALGORITHMS = new Set(["HS256", "HS384", "HS512"]);

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
  if (!String(source?.secret || "").trim()) {
    throw new Error(
      "JWT_SECRET is required. Set it to a random value of at least 32 characters."
    );
  }

  const secret = requiredText(source.secret, "secret");
  const algorithm = requiredText(source?.algorithm, "algorithm");
  const clockToleranceSeconds = Number(source?.clockToleranceSeconds);

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
    secret,
    issuer: requiredText(source?.issuer, "issuer"),
    audience: requiredText(source?.audience, "audience"),
    algorithm,
    expiresIn: requiredText(source?.expiresIn, "expiresIn"),
    clockToleranceSeconds,
    headerName: requiredText(source?.headerName, "headerName").toLowerCase(),
    authScheme: requiredText(source?.authScheme, "authScheme")
  });
}
