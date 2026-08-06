import Ajv from "ajv";
import addFormats from "ajv-formats";
import requestConfig from "../../../config/request.js";
import { ApplicationError } from "../errors/ApplicationError.js";
import { normalizeRequestValidationConfig } from "./normalizeRequestValidationConfig.js";

const REQUEST_LOCATIONS = ["params", "query", "body", "headers"];

function validationDetail(location, error) {
  let path = error.instancePath || "/";

  if (error.keyword === "required" && error.params?.missingProperty) {
    const prefix = error.instancePath || "";
    path = `${prefix}/${error.params.missingProperty}`;
  }

  return {
    location,
    path,
    keyword: error.keyword,
    message: error.message || "is invalid"
  };
}

export class RequestValidationError extends ApplicationError {
  constructor(details, includeDetailsInResponse) {
    super("Request validation failed", {
      code: "REQUEST_VALIDATION_FAILED",
      statusCode: 400,
      details,
      publicDetails: includeDetailsInResponse ? details : undefined
    });
  }
}

export class RequestValidator {
  constructor({ config = requestConfig.validation.input } = {}) {
    this.config = normalizeRequestValidationConfig(config);
    this.ajv = new Ajv({
      allErrors: this.config.allErrors,
      coerceTypes: this.config.coerceTypes,
      useDefaults: this.config.useDefaults,
      removeAdditional: this.config.removeAdditional,
      strict: true
    });
    addFormats(this.ajv, { mode: "fast" });
  }

  compile(requestSchema, routeKey) {
    if (
      requestSchema === null ||
      typeof requestSchema !== "object" ||
      Array.isArray(requestSchema)
    ) {
      throw new TypeError(`requestSchema must be an object for ${routeKey}`);
    }

    const unsupportedLocations = Object.keys(requestSchema).filter(
      (location) => !REQUEST_LOCATIONS.includes(location)
    );

    if (unsupportedLocations.length > 0) {
      throw new Error(
        `Unsupported requestSchema location for ${routeKey}: ${unsupportedLocations.join(", ")}`
      );
    }

    const validators = this.config.enabled
      ? Object.entries(requestSchema).map(([location, schema]) => {
          try {
            return [location, this.ajv.compile(schema)];
          } catch (error) {
            throw new Error(
              `Invalid ${location} schema for ${routeKey}: ${error.message}`
            );
          }
        })
      : [];

    return (req) => {
      const details = [];

      for (const [location, validate] of validators) {
        if (!validate(req[location])) {
          details.push(
            ...(validate.errors || []).map((error) =>
              validationDetail(location, error)
            )
          );
        }
      }

      if (details.length > 0) {
        throw new RequestValidationError(
          details.slice(0, this.config.maxErrors),
          this.config.includeErrorDetailsInResponse
        );
      }

      req.input = Object.freeze({
        params: requestSchema.params ? req.params : {},
        query: requestSchema.query ? req.query : {},
        body: requestSchema.body ? req.body : null,
        headers: requestSchema.headers ? req.headers : {}
      });
    };
  }
}
