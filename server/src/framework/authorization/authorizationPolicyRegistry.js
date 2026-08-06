import { ApplicationError } from "../errors/ApplicationError.js";

export class AuthorizationError extends ApplicationError {
  constructor(code = "AUTHORIZATION_DENIED", message = "Authorization denied") {
    super(message, {
      code,
      statusCode: 403,
      publicCode: "Forbidden",
      publicMessage: "Forbidden"
    });
  }
}

function plainObject(value, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw new Error(`${label} must be a plain object`);
  }

  return value;
}

function noOptions(options, policyName) {
  plainObject(options, `Authorization policy ${policyName} options`);

  if (Object.keys(options).length > 0) {
    throw new Error(`Authorization policy ${policyName} does not accept options`);
  }

  return Object.freeze({});
}

function stringList(value, key, policyName) {
  const source = typeof value === "string" ? [value] : value;

  if (
    !Array.isArray(source) ||
    source.length === 0 ||
    source.some((item) => typeof item !== "string" || !item.trim())
  ) {
    throw new Error(
      `Authorization policy ${policyName} option ${key} must contain strings`
    );
  }

  return Object.freeze([...new Set(source.map((item) => item.trim()))]);
}

function claimPolicyOptions(options, policyName, key) {
  plainObject(options, `Authorization policy ${policyName} options`);
  const allowedKeys = new Set([key, "match"]);

  if (Object.keys(options).some((optionKey) => !allowedKeys.has(optionKey))) {
    throw new Error(`Authorization policy ${policyName} contains unknown options`);
  }

  const match = options.match || "all";

  if (!new Set(["all", "any"]).has(match)) {
    throw new Error(`Authorization policy ${policyName} option match is invalid`);
  }

  return Object.freeze({
    [key]: stringList(options[key], key, policyName),
    match
  });
}

function claimValues(claims, singularKey, pluralKey) {
  return new Set(
    [
      ...(Array.isArray(claims?.[pluralKey]) ? claims[pluralKey] : []),
      ...(typeof claims?.[singularKey] === "string" ? [claims[singularKey]] : [])
    ].filter((value) => typeof value === "string")
  );
}

function matchesClaim(required, actual, match) {
  return match === "any"
    ? required.some((value) => actual.has(value))
    : required.every((value) => actual.has(value));
}

export class AuthorizationPolicyRegistry {
  constructor() {
    this.policies = new Map();
  }

  register(name, policy, { normalizeOptions = (options) => options } = {}) {
    if (typeof name !== "string" || !name.trim()) {
      throw new TypeError("Authorization policy name must be a non-empty string");
    }

    if (typeof policy !== "function") {
      throw new TypeError(`Authorization policy "${name}" must be a function`);
    }

    if (typeof normalizeOptions !== "function") {
      throw new TypeError(`Authorization policy "${name}" option normalizer is invalid`);
    }

    this.policies.set(name, { authorize: policy, normalizeOptions });
    return this;
  }

  has(name) {
    return this.policies.has(name);
  }

  names() {
    return [...this.policies.keys()];
  }

  normalize(policyConfigs, routeKey = "API route") {
    if (!Array.isArray(policyConfigs) || policyConfigs.length === 0) {
      throw new Error(`authorizationPolicies are required for ${routeKey}`);
    }

    const normalized = policyConfigs.map((source) => {
      const config = typeof source === "string" ? { name: source, options: {} } : source;

      plainObject(config, `Authorization policy config for ${routeKey}`);
      const name = String(config.name || "").trim();
      const policy = this.policies.get(name);

      if (!policy) {
        throw new Error(`Unsupported authorization policy for ${routeKey}: ${name}`);
      }

      const sourceOptions = plainObject(
        config.options || {},
        `Authorization policy ${name} options`
      );
      const options = policy.normalizeOptions(sourceOptions, name);
      return Object.freeze({ name, options });
    });
    const names = normalized.map(({ name }) => name);

    if (new Set(names).size !== names.length) {
      throw new Error(`authorizationPolicies must contain unique names for ${routeKey}`);
    }

    return Object.freeze(normalized);
  }

  async authorize(policyConfigs, req, route) {
    const policies = this.normalize(
      policyConfigs,
      `${String(route?.method || "").toLowerCase()} ${route?.path || "API route"}`
    );

    for (const { name, options } of policies) {
      const allowed = await this.policies.get(name).authorize({
        req,
        auth: req.auth,
        route,
        options
      });

      if (allowed !== true) {
        throw new AuthorizationError();
      }
    }

    return true;
  }
}

export function createAuthorizationPolicyRegistry() {
  return new AuthorizationPolicyRegistry()
    .register("allowAll", async () => true, { normalizeOptions: noOptions })
    .register("authenticated", async ({ auth }) => auth?.type === "jwt", {
      normalizeOptions: noOptions
    })
    .register(
      "hasRole",
      async ({ auth, options }) =>
        auth?.type === "jwt" &&
        matchesClaim(
          options.roles,
          claimValues(auth.claims, "role", "roles"),
          options.match
        ),
      {
        normalizeOptions: (options, name) =>
          claimPolicyOptions(options, name, "roles")
      }
    )
    .register(
      "hasPermission",
      async ({ auth, options }) =>
        auth?.type === "jwt" &&
        matchesClaim(
          options.permissions,
          claimValues(auth.claims, "permission", "permissions"),
          options.match
        ),
      {
        normalizeOptions: (options, name) =>
          claimPolicyOptions(options, name, "permissions")
      }
    );
}
