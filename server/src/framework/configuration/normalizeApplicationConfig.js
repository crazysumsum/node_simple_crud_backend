function integer(value, key, { minimum = 1, maximum } = {}) {
  const number = Number(value);

  if (
    !Number.isInteger(number) ||
    number < minimum ||
    (maximum !== undefined && number > maximum)
  ) {
    const range = maximum
      ? `between ${minimum} and ${maximum}`
      : `greater than or equal to ${minimum}`;
    throw new Error(`Application config "${key}" must be an integer ${range}`);
  }

  return number;
}

export function normalizeApplicationConfig(source) {
  const host = String(source?.host || "").trim();

  if (!host) {
    throw new Error('Application config "host" must be a non-empty string');
  }

  return Object.freeze({
    host,
    port: integer(source.port, "port", { minimum: 0, maximum: 65535 }),
    requestTimeoutMs: integer(source.requestTimeoutMs, "requestTimeoutMs"),
    shutdownTimeoutMs: integer(source.shutdownTimeoutMs, "shutdownTimeoutMs")
  });
}
