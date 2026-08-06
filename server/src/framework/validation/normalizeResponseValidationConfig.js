function booleanValue(value, defaultValue) {
  return value === undefined ? defaultValue : value === true;
}

export function normalizeResponseValidationConfig(
  source,
  { environment = process.env.NODE_ENV || "development" } = {}
) {
  const enabled = source?.enabled !== false;
  const validateInProduction = booleanValue(
    source?.validateInProduction,
    true
  );
  const maxErrors = Number(source?.maxErrors ?? 20);

  if (!Number.isInteger(maxErrors) || maxErrors <= 0) {
    throw new Error(
      'Response validation config "maxErrors" must be a positive integer'
    );
  }

  return Object.freeze({
    enabled,
    validateInProduction,
    runtimeEnabled:
      enabled && (environment !== "production" || validateInProduction),
    allErrors: booleanValue(source?.allErrors, true),
    maxErrors
  });
}
