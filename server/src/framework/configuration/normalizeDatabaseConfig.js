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

function requiredText(value, key) {
  const text = String(value || "").trim();

  if (!text) {
    throw new Error(`Database config "${key}" must be a non-empty string`);
  }

  return text;
}

export function normalizeDatabaseConfig(source) {
  const socketPath = source?.socketPath
    ? requiredText(source.socketPath, "socketPath")
    : undefined;

  return Object.freeze({
    host: socketPath ? String(source.host || "127.0.0.1") : requiredText(source?.host, "host"),
    port: integer(source?.port, "port", { minimum: 1, maximum: 65535 }),
    user: requiredText(source?.user, "user"),
    password: String(source?.password ?? ""),
    database: requiredText(source?.database, "database"),
    socketPath,
    waitForConnections: source?.waitForConnections !== false,
    connectionLimit: integer(source?.connectionLimit, "connectionLimit", {
      minimum: 1
    }),
    queueLimit: integer(source?.queueLimit, "queueLimit"),
    queryTimeoutMs: integer(source?.queryTimeoutMs, "queryTimeoutMs", {
      minimum: 1
    }),
    transactionTimeoutMs: integer(
      source?.transactionTimeoutMs,
      "transactionTimeoutMs",
      { minimum: 1 }
    )
  });
}
