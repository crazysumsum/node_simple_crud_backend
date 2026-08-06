function positiveInteger(value, key) {
  const number = Number(value);

  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`Security config "${key}" must be a positive integer`);
  }

  return number;
}

function normalizeTrustProxy(value) {
  const normalized = String(value ?? "false").trim().toLowerCase();

  if (normalized === "false" || normalized === "0" || normalized === "") {
    return false;
  }

  if (normalized === "true") {
    throw new Error(
      'Security config "trustProxy" must use a proxy hop count instead of true'
    );
  }

  return positiveInteger(normalized, "reverseProxy.trustProxy");
}

export function normalizeSecurityConfig(source) {
  const allowedOrigins = String(source.cors?.allowedOrigins || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (allowedOrigins.length === 0 || allowedOrigins.includes("*")) {
    throw new Error("Security config requires a non-wildcard CORS origin allowlist");
  }

  for (const origin of allowedOrigins) {
    try {
      const parsed = new URL(origin);

      if (!parsed.protocol.startsWith("http")) {
        throw new Error("unsupported protocol");
      }
    } catch {
      throw new Error(`Security config contains an invalid CORS origin: ${origin}`);
    }
  }

  const jsonBodyLimit = String(source.jsonBodyLimit || "100kb").toLowerCase();

  if (!/^\d+(b|kb|mb)$/.test(jsonBodyLimit)) {
    throw new Error(`Security config "jsonBodyLimit" is invalid: ${jsonBodyLimit}`);
  }

  return Object.freeze({
    helmetEnabled: source.helmetEnabled !== false,
    hidePoweredBy: source.hidePoweredBy !== false,
    jsonBodyLimit,
    cors: Object.freeze({
      allowedOrigins,
      allowedMethods: [...(source.cors?.allowedMethods || [])].map(String),
      allowedHeaders: [...(source.cors?.allowedHeaders || [])].map(String),
      exposedHeaders: [...(source.cors?.exposedHeaders || [])].map(String),
      credentials: source.cors?.credentials === true,
      maxAgeSeconds: positiveInteger(
        source.cors?.maxAgeSeconds ?? 600,
        "cors.maxAgeSeconds"
      )
    }),
    reverseProxy: Object.freeze({
      trustProxy: normalizeTrustProxy(source.reverseProxy?.trustProxy),
      enforceHttps: source.reverseProxy?.enforceHttps === true
    })
  });
}
