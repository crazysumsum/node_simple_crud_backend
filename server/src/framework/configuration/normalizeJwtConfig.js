const SUPPORTED_ALGORITHMS = new Set(["HS256", "HS384", "HS512"]);

function requiredText(value, key) {
  const text = String(value || "").trim();

  if (!text) {
    throw new Error(`JWT config "${key}" must be a non-empty string`);
  }

  return text;
}

export function normalizeJwtConfig(
  source,
  { environment = process.env.NODE_ENV || "development", environmentSecret } = {}
) {
  const secret = requiredText(source?.secret, "secret");
  const algorithm = requiredText(source?.algorithm, "algorithm");
  const clockToleranceSeconds = Number(source?.clockToleranceSeconds);

  if (secret.length < 32) {
    throw new Error("JWT config secret must contain at least 32 characters");
  }

  if (
    environment === "production" &&
    source?.requireEnvironmentSecretInProduction !== false &&
    !environmentSecret
  ) {
    throw new Error("JWT_SECRET is required when NODE_ENV=production");
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
    requireEnvironmentSecretInProduction:
      source?.requireEnvironmentSecretInProduction !== false,
    issuer: requiredText(source?.issuer, "issuer"),
    audience: requiredText(source?.audience, "audience"),
    algorithm,
    expiresIn: requiredText(source?.expiresIn, "expiresIn"),
    clockToleranceSeconds,
    headerName: requiredText(source?.headerName, "headerName").toLowerCase(),
    authScheme: requiredText(source?.authScheme, "authScheme")
  });
}
