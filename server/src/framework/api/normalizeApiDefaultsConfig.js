const AUTH_TYPE_PATTERN = /^[A-Za-z][A-Za-z0-9._-]*$/;
const BODY_CAPTURE_MODES = ["none", "full"];

function plainObject(value, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw new TypeError(`${label} must be a plain object`);
  }

  return value;
}

function cloneData(value, label) {
  if (value === null || ["string", "boolean"].includes(typeof value)) {
    return value;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item, index) => cloneData(item, `${label}[${index}]`));
  }

  if (value && typeof value === "object") {
    plainObject(value, label);
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        cloneData(item, `${label}.${key}`)
      ])
    );
  }

  throw new TypeError(`${label} must contain JSON-compatible values`);
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) {
      deepFreeze(item);
    }
    Object.freeze(value);
  }

  return value;
}

export function normalizeApiDefaultsConfig(source, { defaultVersion } = {}) {
  plainObject(source, "API defaults config");
  const version = String(source.version || defaultVersion || "").trim();
  const authType = String(source.authType || "").trim();
  const authorizationPolicies = cloneData(
    source.authorizationPolicies,
    "API defaults authorizationPolicies"
  );
  const deprecation = cloneData(source.deprecation, "API defaults deprecation");
  const idempotency = cloneData(source.idempotency, "API defaults idempotency");
  const logging = cloneData(source.logging, "API defaults logging");
  const timeoutMs = source.timeoutMs;

  if (!/^v[1-9]\d*$/.test(version)) {
    throw new Error('API defaults config "version" must match v<number>');
  }

  if (!AUTH_TYPE_PATTERN.test(authType)) {
    throw new Error('API defaults config "authType" is invalid');
  }

  if (!Array.isArray(authorizationPolicies) || authorizationPolicies.length === 0) {
    throw new Error(
      'API defaults config "authorizationPolicies" must be a non-empty array'
    );
  }

  plainObject(deprecation, "API defaults deprecation");
  plainObject(idempotency, "API defaults idempotency");
  plainObject(logging, "API defaults logging");

  if (typeof deprecation.deprecated !== "boolean") {
    throw new Error('API defaults config "deprecation.deprecated" must be boolean');
  }

  if (typeof idempotency.enabled !== "boolean") {
    throw new Error('API defaults config "idempotency.enabled" must be boolean');
  }

  if (!BODY_CAPTURE_MODES.includes(logging.bodyCapture)) {
    throw new Error(
      `API defaults config "logging.bodyCapture" must be one of: ${BODY_CAPTURE_MODES.join(", ")}`
    );
  }

  if (
    timeoutMs !== null &&
    (!Number.isInteger(Number(timeoutMs)) || Number(timeoutMs) <= 0)
  ) {
    throw new Error('API defaults config "timeoutMs" must be null or a positive integer');
  }

  return deepFreeze({
    version,
    authType,
    authorizationPolicies,
    deprecation,
    idempotency,
    logging,
    timeoutMs: timeoutMs === null ? null : Number(timeoutMs)
  });
}

export { cloneData, deepFreeze, plainObject };
