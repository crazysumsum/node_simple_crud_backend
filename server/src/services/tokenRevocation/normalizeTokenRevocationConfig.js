function positiveInteger(value, key) {
  const number = Number(value);

  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`Token revocation config "${key}" must be a positive integer`);
  }

  return number;
}

export function normalizeTokenRevocationConfig(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new TypeError("token revocation config must be an object");
  }

  return Object.freeze({
    maxStalenessSeconds: positiveInteger(
      source.maxStalenessSeconds ?? 60,
      "maxStalenessSeconds"
    ),
    retentionSeconds: positiveInteger(
      source.retentionSeconds ?? 7 * 24 * 60 * 60,
      "retentionSeconds"
    ),
    maxCachedSubjects: positiveInteger(
      source.maxCachedSubjects ?? 100000,
      "maxCachedSubjects"
    )
  });
}
