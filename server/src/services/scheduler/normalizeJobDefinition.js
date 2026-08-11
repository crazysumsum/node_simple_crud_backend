import { JOB_NAME_PATTERN } from "./normalizeSchedulerConfig.js";

export const JOB_SCOPES = Object.freeze(["instance", "cluster"]);

function positiveInteger(value, key, label) {
  const number = Number(value);

  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${label} "${key}" must be a positive integer`);
  }

  return number;
}

/**
 * 把一個 service 的 static jobs 條目正規化成排程器要用的定義。
 *
 * 這裡的驗證全部在啟動時執行。method 是字串形式的方法參照，沒有任何工具檢查
 * 得到它拼對沒有，所以必須在這裡確認它真的存在於 service 實例上——否則第一次
 * 觸發要等到幾小時後，而且症狀只是「工作沒有效果」。
 */
export function normalizeJobDefinition(source, instance, serviceName, config) {
  const label = `Job on service "${serviceName}"`;

  if (source === null || typeof source !== "object" || Array.isArray(source)) {
    throw new Error(`${label} must be an object`);
  }

  const name = String(source.name || "").trim();

  if (!JOB_NAME_PATTERN.test(name)) {
    throw new Error(`${label} has an invalid job name: ${source.name}`);
  }

  const method = String(source.method || "").trim();

  if (!method) {
    throw new Error(`Job "${name}" must declare the method to call`);
  }

  if (typeof instance?.[method] !== "function") {
    throw new Error(
      `Job "${name}" refers to method "${method}", which does not exist on service "${serviceName}"`
    );
  }

  const scope = String(source.scope ?? "instance").toLowerCase();

  if (!JOB_SCOPES.includes(scope)) {
    throw new Error(
      `Job "${name}" has an invalid scope "${source.scope}". Use one of: ${JOB_SCOPES.join(", ")}`
    );
  }

  if (source.runOnStart !== undefined && typeof source.runOnStart !== "boolean") {
    throw new Error(`Job "${name}" runOnStart must be a boolean`);
  }

  const override = config.jobs[name] ?? {};
  const timeoutMs = positiveInteger(
    override.timeoutMs ?? source.timeoutMs ?? config.defaultTimeoutMs,
    "timeoutMs",
    `Job "${name}"`
  );
  const intervalMs = positiveInteger(
    override.intervalMs ?? source.intervalMs,
    "intervalMs",
    `Job "${name}"`
  );

  // 這裡刻意不檢查 intervalMs 與 timeoutMs 的大小關係。timeoutMs 是安全上限
  // 而不是預期時長：「每 10 秒輪詢一次，萬一某次拖到 30 秒就中止它」是完全
  // 合理的設定，而 defaultTimeoutMs 本來就大於多數合理的間隔。真正發生重疊時
  // 由執行期的重疊保護處理——跳過、記 warn、計數，那才是有證據的訊號。
  return Object.freeze({
    name,
    serviceName,
    method,
    scope,
    intervalMs,
    timeoutMs,
    runOnStart: source.runOnStart === true,
    enabled: override.enabled ?? true,
    run: (signal) => instance[method](signal)
  });
}
