function positiveInteger(value, key) {
  const number = Number(value);

  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`Token revocation config "${key}" must be a positive integer`);
  }

  return number;
}

const FAILURE_MODES = new Set(["closed", "open"]);

export function normalizeTokenRevocationConfig(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new TypeError("token revocation config must be an object");
  }

  const maxStalenessSeconds = positiveInteger(
    source.maxStalenessSeconds ?? 60,
    "maxStalenessSeconds"
  );
  const maxFailOpenSeconds = positiveInteger(
    source.maxFailOpenSeconds ?? 300,
    "maxFailOpenSeconds"
  );

  // 三個值構成一條鏈：刷新間隔 <= maxStalenessSeconds <= maxFailOpenSeconds。
  // 前半段由 TokenRevocationRefreshJob 在啟動時檢查，後半段在這裡。
  //
  // 上界小於 SLA 的話，正常運作時快照年齡就會超過它——熔斷會在資料庫完全
  // 健康的情況下觸發。那不是保護，是設定錯誤，所以擋在啟動。
  if (maxFailOpenSeconds < maxStalenessSeconds) {
    throw new Error(
      `Token revocation config "maxFailOpenSeconds" (${maxFailOpenSeconds}s) must be at ` +
        `least "maxStalenessSeconds" (${maxStalenessSeconds}s). A lower cap would trip ` +
        "while the database is healthy."
    );
  }

  const failureMode = String(source.failureMode ?? "closed");

  if (!FAILURE_MODES.has(failureMode)) {
    throw new Error(
      `Token revocation config "failureMode" must be one of: ${[...FAILURE_MODES].join(", ")}`
    );
  }

  return Object.freeze({
    maxStalenessSeconds,
    maxFailOpenSeconds,
    failureMode,
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
