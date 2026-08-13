import { revealSecret, secretValue } from "./SecretValue.js";

function integer(value, key, { minimum = 0, maximum } = {}) {
  const number = Number(value);

  if (
    !Number.isInteger(number) ||
    number < minimum ||
    (maximum !== undefined && number > maximum)
  ) {
    throw new Error(`Database config "${key}" is invalid`);
  }

  return number;
}

function abandonedConnectionAction(value) {
  const action = String(value ?? "destroy");

  if (!ABANDONED_CONNECTION_ACTIONS.has(action)) {
    throw new Error(
      `Database config "abandonedConnectionAction" must be one of: ${[
        ...ABANDONED_CONNECTION_ACTIONS
      ].join(", ")}`
    );
  }

  return action;
}

function requiredText(value, key) {
  const text = String(value || "").trim();

  if (!text) {
    throw new Error(`Database config "${key}" must be a non-empty string`);
  }

  return text;
}

const ABANDONED_CONNECTION_ACTIONS = new Set(["destroy", "release"]);

export function normalizeDatabaseConfig(source) {
  const socketPath = source?.socketPath
    ? requiredText(source.socketPath, "socketPath")
    : undefined;

  return Object.freeze({
    host: socketPath ? String(source.host || "127.0.0.1") : requiredText(source?.host, "host"),
    port: integer(source?.port, "port", { minimum: 1, maximum: 65535 }),
    user: requiredText(source?.user, "user"),
    // 密鑰包裝：整份設定被寫進日誌或錯誤 context 時只會得到 [REDACTED]。
    // 真正要用的地方（建立連線池）必須明寫 reveal()。
    password: secretValue(revealSecret(source?.password), "database password"),
    database: requiredText(source?.database, "database"),
    socketPath,
    waitForConnections: source?.waitForConnections !== false,
    connectionLimit: integer(source?.connectionLimit, "connectionLimit", {
      minimum: 1
    }),
    // 下限 1 而不是 0：0 是 mysql2 的「不限制」，也就是等待者無上限累積。
    // 那是這個框架不接受的預設，所以連寫都不讓寫。
    queueLimit: integer(source?.queueLimit, "queueLimit", { minimum: 1 }),
    acquireTimeoutMs: integer(source?.acquireTimeoutMs, "acquireTimeoutMs", {
      minimum: 1
    }),
    queryTimeoutMs: integer(source?.queryTimeoutMs, "queryTimeoutMs", {
      minimum: 1
    }),
    abandonedConnectionAction: abandonedConnectionAction(
      source?.abandonedConnectionAction
    ),
    transactionTimeoutMs: integer(
      source?.transactionTimeoutMs,
      "transactionTimeoutMs",
      { minimum: 1 }
    )
  });
}
