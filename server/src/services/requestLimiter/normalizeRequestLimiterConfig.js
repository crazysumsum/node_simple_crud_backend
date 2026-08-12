function positiveInteger(value, key) {
  const number = Number(value);

  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`Request limiter config "${key}" must be a positive integer`);
  }

  return number;
}

function nonNegativeInteger(value, key) {
  const number = Number(value);

  if (!Number.isInteger(number) || number < 0) {
    throw new Error(
      `Request limiter config "${key}" must be a non-negative integer`
    );
  }

  return number;
}

export function normalizeRequestLimiterConfig(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new TypeError("request limiter config must be an object");
  }

  // enabled 曾經在這裡，現在由 static service.enabled 決定。留著不報錯的話，
  // 升級後忘了刪的部署會靜默地拿到全額限流——正好與作者的意圖相反。
  if (Object.hasOwn(source, "enabled")) {
    throw new Error(
      'Request limiter config "enabled" was removed. Disable the service with static service.enabled instead.'
    );
  }

  const apiPathPrefix = String(source.apiPathPrefix || "/api").replace(/\/$/, "");
  const storeAdapter = String(source.storeAdapter || "memory").trim();
  const storeKeyPrefix = String(
    source.storeKeyPrefix || "erp-api:rate-limit"
  ).trim();

  if (!apiPathPrefix.startsWith("/")) {
    throw new Error('Request limiter config "apiPathPrefix" must start with /');
  }

  if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(storeAdapter)) {
    throw new Error('Request limiter config "storeAdapter" is invalid');
  }

  if (!storeKeyPrefix || storeKeyPrefix.length > 128) {
    throw new Error('Request limiter config "storeKeyPrefix" is invalid');
  }

  return Object.freeze({
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
