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

function timeZone(value) {
  const normalized = String(value || "").trim();

  try {
    new Intl.DateTimeFormat("en", { timeZone: normalized }).format();
  } catch {
    throw new Error(`Application config "timeZone" is invalid: ${normalized}`);
  }

  return normalized;
}

export function normalizeApplicationConfig(source) {
  const host = String(source?.host || "").trim();

  if (!host) {
    throw new Error('Application config "host" must be a non-empty string');
  }

  return Object.freeze({
    host,
    port: integer(source.port, "port", { minimum: 0, maximum: 65535 }),
    timeZone: timeZone(source.timeZone),
    requestTimeoutMs: integer(source.requestTimeoutMs, "requestTimeoutMs"),
    shutdownTimeoutMs: integer(source.shutdownTimeoutMs, "shutdownTimeoutMs")
  });
}
