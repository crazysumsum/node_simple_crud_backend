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

function storeFailureMode(value) {
  const mode = String(value ?? "closed").trim();

  if (mode !== "open" && mode !== "closed") {
    throw new Error(
      'Request limiter config "storeFailureMode" must be "open" or "closed"'
    );
  }

  return mode;
}

function ipv6PrefixLength(value) {
  const bits = Number(value);

  // 上限 128 是完整位址（等於不聚合）；下限 1 擋掉 0，因為 /0 會把整個 IPv6
  // 網際網路算成一個客戶端，也就是一個人就能用光所有人的配額。
  if (!Number.isInteger(bits) || bits < 1 || bits > 128) {
    throw new Error(
      'Request limiter config "ipv6PrefixLength" must be an integer between 1 and 128'
    );
  }

  return bits;
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
    ),
    maxTrackedKeys: positiveInteger(
      source.maxTrackedKeys ?? 100000,
      "maxTrackedKeys"
    ),
    maxAbandonedRequests: positiveInteger(
      source.maxAbandonedRequests ?? 100,
      "maxAbandonedRequests"
    ),
    abandonGraceMs: positiveInteger(
      source.abandonGraceMs ?? 1000,
      "abandonGraceMs"
    ),
    ipv6PrefixLength: ipv6PrefixLength(source.ipv6PrefixLength ?? 64),
    storeOperationTimeoutMs: positiveInteger(
      source.storeOperationTimeoutMs ?? 500,
      "storeOperationTimeoutMs"
    ),
    storeFailureMode: storeFailureMode(source.storeFailureMode)
  });
}
