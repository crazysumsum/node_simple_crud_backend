const OVERRIDE_FIELDS = new Set(["enabled", "intervalMs", "timeoutMs"]);
const JOB_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9._-]*$/;

function positiveInteger(value, key) {
  const number = Number(value);

  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`Scheduler config "${key}" must be a positive integer`);
  }

  return number;
}

function ratio(value, key) {
  const number = Number(value);

  if (!Number.isFinite(number) || number < 0 || number > 1) {
    throw new Error(`Scheduler config "${key}" must be a number between 0 and 1`);
  }

  return number;
}

/**
 * 依名稱覆寫個別工作。只接受 static jobs 上真的存在的欄位——寫錯欄位名時如果
 * 靜默忽略，設定看起來生效了但完全沒作用，而那正是最難查的一種問題。
 */
function jobOverride(source, name) {
  if (source === null || typeof source !== "object" || Array.isArray(source)) {
    throw new Error(`Scheduler config "jobs.${name}" must be an object`);
  }

  const unsupported = Object.keys(source).filter((key) => !OVERRIDE_FIELDS.has(key));

  if (unsupported.length > 0) {
    throw new Error(
      `Scheduler config "jobs.${name}" has unsupported fields: ${unsupported.join(", ")}. Only ${[...OVERRIDE_FIELDS].join(", ")} may be overridden.`
    );
  }

  const override = {};

  if (source.enabled !== undefined) {
    if (typeof source.enabled !== "boolean") {
      throw new Error(`Scheduler config "jobs.${name}.enabled" must be a boolean`);
    }

    override.enabled = source.enabled;
  }

  if (source.intervalMs !== undefined) {
    override.intervalMs = positiveInteger(source.intervalMs, `jobs.${name}.intervalMs`);
  }

  if (source.timeoutMs !== undefined) {
    override.timeoutMs = positiveInteger(source.timeoutMs, `jobs.${name}.timeoutMs`);
  }

  return Object.freeze(override);
}

/**
 * 統計發佈的設定。刻意沒有 enabled 與 intervalMs：前者由
 * job.schedulerStatsFlush 的 static service.enabled 決定，後者就是那件工作的
 * intervalMs。同一件事有兩個開關，遲早會出現兩邊不一致而沒人發現的情況。
 */
function statsConfig(source) {
  if (source === null || typeof source !== "object" || Array.isArray(source)) {
    throw new Error('Scheduler config "stats" must be an object');
  }

  const address = String(source.address ?? "");

  if (address.length > 64) {
    throw new Error('Scheduler config "stats.address" must be at most 64 characters');
  }

  const staleAfterRuns = positiveInteger(source.staleAfterRuns ?? 3, "stats.staleAfterRuns");

  // 1 代表「錯過一輪就當你死了」。排程有抖動、資料庫偶爾慢一下，那會讓活著的
  // 實例被反覆刪掉又寫回來。
  if (staleAfterRuns < 2) {
    throw new Error('Scheduler config "stats.staleAfterRuns" must be at least 2');
  }

  return Object.freeze({
    address,
    staleAfterRuns,
    consecutiveFailureAlertThreshold: positiveInteger(
      source.consecutiveFailureAlertThreshold ?? 3,
      "stats.consecutiveFailureAlertThreshold"
    )
  });
}

export function normalizeSchedulerConfig(source) {
  if (source === null || typeof source !== "object" || Array.isArray(source)) {
    throw new Error("Scheduler config must be an object");
  }

  const sourceJobs = source.jobs ?? {};

  if (sourceJobs === null || typeof sourceJobs !== "object" || Array.isArray(sourceJobs)) {
    throw new Error('Scheduler config "jobs" must be an object');
  }

  const jobs = {};

  for (const [name, override] of Object.entries(sourceJobs)) {
    if (!JOB_NAME_PATTERN.test(name)) {
      throw new Error(`Scheduler config job name is invalid: ${name}`);
    }

    jobs[name] = jobOverride(override, name);
  }

  return Object.freeze({
    enabled: source.enabled !== false,
    defaultTimeoutMs: positiveInteger(source.defaultTimeoutMs ?? 30000, "defaultTimeoutMs"),
    clusterLeaseGraceMs: positiveInteger(
      source.clusterLeaseGraceMs ?? 30000,
      "clusterLeaseGraceMs"
    ),
    startupJitterRatio: ratio(source.startupJitterRatio ?? 0.2, "startupJitterRatio"),
    stats: statsConfig(source.stats ?? {}),
    jobs: Object.freeze(jobs)
  });
}

export { JOB_NAME_PATTERN };
