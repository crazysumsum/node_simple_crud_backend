import assert from "node:assert/strict";
import test from "node:test";
import {
  ResponseValidationError,
  ResponseValidator
} from "../src/framework/validation/responseValidator.js";

const strictConfig = {
  enabled: true,
  validateInProduction: true,
  allErrors: true,
  maxErrors: 20
};

test("response validator accepts matching data and rejects contract violations", () => {
  const validator = new ResponseValidator({ config: strictConfig });
  const validate = validator.compile(
    {
      200: {
        type: "object",
        required: ["id", "active"],
        additionalProperties: false,
        properties: {
          id: { type: "integer" },
          active: { type: "boolean" }
        }
      }
    },
    "get /api/example"
  );

  assert.doesNotThrow(() => validate(200, { id: 42, active: true }));
  assert.throws(
    () => validate(200, { id: "42", leakedField: "secret" }),
    (error) => {
      assert.ok(error instanceof ResponseValidationError);
      assert.equal(error.code, "RESPONSE_VALIDATION_FAILED");
      assert.equal(error.publicCode, "INTERNAL_SERVER_ERROR");
      assert.ok(error.details.length >= 3);
      return true;
    }
  );
});

test("response validator requires a schema for the actual HTTP status", () => {
  const validate = new ResponseValidator({ config: strictConfig }).compile(
    { 200: { type: "object" } },
    "post /api/example"
  );

  assert.throws(
    () => validate(201, {}),
    (error) => {
      assert.ok(error instanceof ResponseValidationError);
      assert.equal(error.details[0].keyword, "responseSchema");
      return true;
    }
  );
});

test("response schemas compile at startup even when production runtime validation is disabled", () => {
  const validator = new ResponseValidator({
    config: {
      ...strictConfig,
      validateInProduction: false
    },
    environment: "production"
  });

  assert.throws(
    () =>
      validator.compile(
        { 200: { type: "not-a-json-schema-type" } },
        "get /api/invalid"
      ),
    /Invalid response schema/
  );

  const validate = validator.compile(
    { 200: { type: "integer" } },
    "get /api/runtime-disabled"
  );
  assert.doesNotThrow(() => validate(200, "not-an-integer"));
});
