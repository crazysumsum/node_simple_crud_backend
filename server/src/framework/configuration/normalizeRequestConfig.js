import { normalizeRequestLimitsConfig } from "../limiting/normalizeRequestLimitsConfig.js";
import { normalizeRequestValidationConfig } from "../validation/normalizeRequestValidationConfig.js";
import { normalizeResponseValidationConfig } from "../validation/normalizeResponseValidationConfig.js";

function requirePlainObject(value, fieldName) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${fieldName} must be an object`);
  }

  return value;
}

export function normalizeRequestConfig(source, { environment } = {}) {
  const config = requirePlainObject(source, "request config");
  const limits = requirePlainObject(config.limits, "request.limits");
  const validation = requirePlainObject(config.validation, "request.validation");
  const input = requirePlainObject(
    validation.input,
    "request.validation.input"
  );
  const output = requirePlainObject(
    validation.output,
    "request.validation.output"
  );

  return Object.freeze({
    limits: normalizeRequestLimitsConfig(limits),
    validation: Object.freeze({
      input: normalizeRequestValidationConfig(input),
      output: normalizeResponseValidationConfig(output, { environment })
    })
  });
}
