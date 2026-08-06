function positiveInteger(value, key) {
  const number = Number(value);

  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`Idempotency config "${key}" must be a positive integer`);
  }

  return number;
}

export function normalizeIdempotencyConfig(source) {
  const headerName = String(source?.headerName || "").trim();
  const storeAdapter = String(source?.storeAdapter || "memory").trim();
  const storeKeyPrefix = String(source?.storeKeyPrefix || "").trim();
  const cacheableStatusCodes = Array.isArray(source?.cacheableStatusCodes)
    ? source.cacheableStatusCodes.map(Number)
    : [];

  if (!/^[A-Za-z0-9-]+$/.test(headerName)) {
    throw new Error('Idempotency config "headerName" is invalid');
  }

  if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(storeAdapter)) {
    throw new Error('Idempotency config "storeAdapter" is invalid');
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
    enabled: source?.enabled !== false,
    headerName,
    maxKeyLength: positiveInteger(source?.maxKeyLength ?? 128, "maxKeyLength"),
    defaultTtlMs: positiveInteger(source?.defaultTtlMs ?? 86400000, "defaultTtlMs"),
    cacheableStatusCodes: Object.freeze([...new Set(cacheableStatusCodes)]),
    storeAdapter,
    storeKeyPrefix,
    memoryMaxEntries: positiveInteger(
      source?.memoryMaxEntries ?? 10000,
      "memoryMaxEntries"
    )
  });
}
