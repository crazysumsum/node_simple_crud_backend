import Ajv from "ajv";
import addFormats from "ajv-formats";
import requestConfig from "../../../config/request.js";
import { ApplicationError } from "../errors/ApplicationError.js";
import { normalizeResponseValidationConfig } from "./normalizeResponseValidationConfig.js";

const STATUS_CODE_PATTERN = /^[1-5]\d{2}$/;

function validationDetail(error) {
  let path = error.instancePath || "/";

  if (error.keyword === "required" && error.params?.missingProperty) {
    path = `${error.instancePath || ""}/${error.params.missingProperty}`;
  }

  return {
    path,
    keyword: error.keyword,
    message: error.message || "is invalid"
  };
}

export class ResponseValidationError extends ApplicationError {
  constructor(statusCode, details) {
    super(`Response validation failed for HTTP ${statusCode}`, {
      code: "RESPONSE_VALIDATION_FAILED",
      statusCode: 500,
      details,
      publicCode: "INTERNAL_SERVER_ERROR",
      publicMessage: "Internal server error"
    });
  }
}

export class ResponseValidator {
  constructor({ config = requestConfig.validation.output, environment } = {}) {
    this.config = normalizeResponseValidationConfig(config, { environment });
    this.ajv = new Ajv({
      allErrors: this.config.allErrors,
      coerceTypes: false,
      useDefaults: false,
      removeAdditional: false,
      strict: true
    });
    addFormats(this.ajv, { mode: "fast" });
  }

  compile(responseSchema, routeKey) {
    if (
      responseSchema === null ||
      typeof responseSchema !== "object" ||
      Array.isArray(responseSchema)
    ) {
      throw new TypeError(`responseSchema must be an object for ${routeKey}`);
    }

    const entries = Object.entries(responseSchema);

    if (entries.length === 0) {
      throw new Error(`responseSchema must define at least one status for ${routeKey}`);
    }

    const validators = new Map();

    for (const [statusCode, schema] of entries) {
      if (statusCode !== "default" && !STATUS_CODE_PATTERN.test(statusCode)) {
        throw new Error(
          `Invalid response status "${statusCode}" for ${routeKey}`
        );
      }

      try {
        validators.set(statusCode, this.ajv.compile(schema));
      } catch (error) {
        throw new Error(
          `Invalid response schema for HTTP ${statusCode} on ${routeKey}: ${error.message}`
        );
      }
    }

    return (statusCode, data) => {
      if (!this.config.runtimeEnabled) {
        return;
      }

      const normalizedStatusCode = Number(statusCode);

      if (
        !Number.isInteger(normalizedStatusCode) ||
        normalizedStatusCode < 100 ||
        normalizedStatusCode > 599
      ) {
        throw new ResponseValidationError(statusCode, [
          {
            path: "/",
            keyword: "statusCode",
            message: "must be an HTTP status code between 100 and 599"
          }
        ]);
      }

      const validate =
        validators.get(String(normalizedStatusCode)) || validators.get("default");

      if (!validate) {
        throw new ResponseValidationError(normalizedStatusCode, [
          {
            path: "/",
            keyword: "responseSchema",
            message: `has no schema for HTTP ${normalizedStatusCode}`
          }
        ]);
      }

      if (!validate(data)) {
        throw new ResponseValidationError(
          normalizedStatusCode,
          (validate.errors || [])
            .slice(0, this.config.maxErrors)
            .map(validationDetail)
        );
      }
    };
  }
}
