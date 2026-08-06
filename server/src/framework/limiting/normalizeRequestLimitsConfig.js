function positiveInteger(value, key) {
  const number = Number(value);

  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`Request limits config "${key}" must be a positive integer`);
  }

  return number;
}

function nonNegativeInteger(value, key) {
  const number = Number(value);

  if (!Number.isInteger(number) || number < 0) {
    throw new Error(
      `Request limits config "${key}" must be a non-negative integer`
    );
  }

  return number;
}

export function normalizeRequestLimitsConfig(source) {
  const apiPathPrefix = String(source.apiPathPrefix || "/api").replace(/\/$/, "");
  const storeAdapter = String(source.storeAdapter || "memory").trim();
  const storeKeyPrefix = String(
    source.storeKeyPrefix || "erp-api:rate-limit"
  ).trim();

  if (!apiPathPrefix.startsWith("/")) {
    throw new Error('Request limits config "apiPathPrefix" must start with /');
  }

  if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(storeAdapter)) {
    throw new Error('Request limits config "storeAdapter" is invalid');
  }

  if (!storeKeyPrefix || storeKeyPrefix.length > 128) {
    throw new Error('Request limits config "storeKeyPrefix" is invalid');
  }

  return Object.freeze({
    enabled: source.enabled !== false,
    storeAdapter,
    storeKeyPrefix,
    apiPathPrefix,
    maxConcurrentRequests: positiveInteger(
      source.maxConcurrentRequests ?? 100,
      "maxConcurrentRequests"
    ),
    maxQueueSize: nonNegativeInteger(source.maxQueueSize ?? 200, "maxQueueSize"),
    queueTimeoutMs: positiveInteger(source.queueTimeoutMs ?? 30000, "queueTimeoutMs"),
    maxRequestsPerIpPerWindow: positiveInteger(
      source.maxRequestsPerIpPerWindow ?? 20,
      "maxRequestsPerIpPerWindow"
    ),
    ipWindowMs: positiveInteger(source.ipWindowMs ?? 1000, "ipWindowMs"),
    retryAfterSeconds: positiveInteger(
      source.retryAfterSeconds ?? 1,
      "retryAfterSeconds"
    )
  });
}
