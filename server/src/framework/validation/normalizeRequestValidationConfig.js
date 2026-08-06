function booleanValue(value, defaultValue) {
  return value === undefined ? defaultValue : value === true;
}

export function normalizeRequestValidationConfig(source) {
  const maxErrors = Number(source.maxErrors ?? 20);

  if (!Number.isInteger(maxErrors) || maxErrors <= 0) {
    throw new Error('Request validation config "maxErrors" must be a positive integer');
  }

  return Object.freeze({
    enabled: source.enabled !== false,
    allErrors: booleanValue(source.allErrors, true),
    coerceTypes: booleanValue(source.coerceTypes, true),
    useDefaults: booleanValue(source.useDefaults, true),
    removeAdditional: booleanValue(source.removeAdditional, false),
    maxErrors,
    includeErrorDetailsInResponse: booleanValue(
      source.includeErrorDetailsInResponse,
      true
    )
  });
}
