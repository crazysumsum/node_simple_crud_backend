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
    jobs: Object.freeze(jobs)
  });
}

export { JOB_NAME_PATTERN };
