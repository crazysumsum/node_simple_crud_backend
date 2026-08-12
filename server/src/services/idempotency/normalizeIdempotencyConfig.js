export const IDEMPOTENCY_STORE_ADAPTERS = Object.freeze(["memory", "mysql"]);

function positiveInteger(value, key) {
  const number = Number(value);

  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`Idempotency config "${key}" must be a positive integer`);
  }

  return number;
}

export function normalizeIdempotencyConfig(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new TypeError("idempotency config must be an object");
  }

  // enabled 曾經在這裡，現在由 static service.enabled 決定。留著不報錯的話，
  // 升級後忘了刪的部署會以為自己關掉了 idempotency，實際上照常生效。
  if (Object.hasOwn(source, "enabled")) {
    throw new Error(
      'Idempotency config "enabled" was removed. Disable the service with static service.enabled instead.'
    );
  }

  const headerName = String(source.headerName || "").trim();
  const storeAdapter = String(source.storeAdapter || "mysql").trim();
  const storeKeyPrefix = String(source.storeKeyPrefix || "").trim();
  const cacheableStatusCodes = Array.isArray(source.cacheableStatusCodes)
    ? source.cacheableStatusCodes.map(Number)
    : [];

  if (!/^[A-Za-z0-9-]+$/.test(headerName)) {
    throw new Error('Idempotency config "headerName" is invalid');
  }

  // 只接受框架真的有實作的 adapter。先前這裡只檢查字元合法性，於是一個打錯的
  // 名字會一路走到 Factory 才變成「adapter must be injected」——而在共享 store
  // 這件事上，錯字的代價是整個叢集靜默失去 idempotency。
  if (!IDEMPOTENCY_STORE_ADAPTERS.includes(storeAdapter)) {
    throw new Error(
      `Idempotency config "storeAdapter" must be one of: ${IDEMPOTENCY_STORE_ADAPTERS.join(", ")}`
    );
  }

  if (!storeKeyPrefix || storeKeyPrefix.length > 128) {
    throw new Error('Idempotency config "storeKeyPrefix" is invalid');
  }

  if (
    cacheableStatusCodes.length === 0 ||
    cacheableStatusCodes.some(
      (statusCode) =>
        !Number.isInteger(statusCode) || statusCode < 200 || statusCode > 299
    )
  ) {
    throw new Error(
      'Idempotency config "cacheableStatusCodes" must contain HTTP 2xx codes'
    );
  }

  return Object.freeze({
    headerName,
    maxKeyLength: positiveInteger(source.maxKeyLength ?? 128, "maxKeyLength"),
    defaultTtlMs: positiveInteger(source.defaultTtlMs ?? 3600000, "defaultTtlMs"),
    pendingLeaseMs: positiveInteger(
      source.pendingLeaseMs ?? 120000,
      "pendingLeaseMs"
    ),
    cacheableStatusCodes: Object.freeze([...new Set(cacheableStatusCodes)]),
    storeAdapter,
    storeKeyPrefix,
    memoryMaxEntries: positiveInteger(
      source.memoryMaxEntries ?? 10000,
      "memoryMaxEntries"
    ),
    maxResponseBytes: positiveInteger(
      source.maxResponseBytes ?? 1048576,
      "maxResponseBytes"
    )
  });
}
