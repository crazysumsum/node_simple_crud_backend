import assert from "node:assert/strict";
import test from "node:test";
import { AuthenticationError } from "../src/framework/auth/AuthenticationError.js";
import { BaseAuthStrategy } from "../src/framework/auth/BaseAuthStrategy.js";
import {
  createAuthStrategyRegistry
} from "../src/framework/auth/authStrategyRegistry.js";
import { createAuthStrategyServices } from "../src/framework/auth/createAuthStrategyServices.js";

const silentLogger = {
  info: async () => {}
};

test("auth strategy discovery registers implementations and injects services", async () => {
  class ApiKeyAuthStrategy extends BaseAuthStrategy {
    static authType = "apiKey";

    async authenticate(req) {
      if (req.get("x-api-key") !== this.services.require("expectedKey")) {
        throw new AuthenticationError("API_KEY_INVALID", "API key is invalid");
      }

      return { type: this.authType, claims: { sub: "api-client" } };
    }
  }

  const services = createAuthStrategyServices({
    logger: silentLogger,
    custom: { expectedKey: "secret" }
  });
  const registry = await createAuthStrategyRegistry({
    services,
    moduleUrls: ["virtual:apiKeyAuthStrategy"],
    moduleLoader: async () => ({ ApiKeyAuthStrategy })
  });
  const request = {
    get: (name) => (name === "x-api-key" ? "secret" : undefined)
  };

  assert.deepEqual(registry.types(), ["apiKey"]);
  assert.deepEqual(await registry.authenticate("apiKey", request), {
    type: "apiKey",
    claims: { sub: "api-client" }
  });
  assert.equal(request.auth.type, "apiKey");
  assert.deepEqual(request.user, { sub: "api-client" });
  assert.equal(typeof services.require, "function");
  assert.equal(Object.isFrozen(request.auth), true);
});

test("auth strategy discovery rejects duplicate auth types", async () => {
  let closeCalls = 0;

  class FirstStrategy extends BaseAuthStrategy {
    static authType = "duplicate";

    async close() {
      closeCalls += 1;
    }
  }
  class SecondStrategy extends BaseAuthStrategy {
    static authType = "duplicate";

    async close() {
      closeCalls += 1;
    }
  }

  await assert.rejects(
    () =>
      createAuthStrategyRegistry({
        moduleUrls: ["virtual:first", "virtual:second"],
        moduleLoader: async (url) =>
          url === "virtual:first" ? { FirstStrategy } : { SecondStrategy }
      }),
    /Duplicate authentication strategy/
  );
  assert.equal(closeCalls, 2);
});

test("auth strategy registry validates the returned auth contract", async () => {
  class InvalidStrategy extends BaseAuthStrategy {
    static authType = "invalid";

    async authenticate() {
      return { type: "anotherType" };
    }
  }

  const registry = await createAuthStrategyRegistry({
    moduleUrls: ["virtual:invalid"],
    moduleLoader: async () => ({ InvalidStrategy })
  });

  await assert.rejects(
    () => registry.authenticate("invalid", {}),
    /must return type "invalid"/
  );
});

test("auth strategy registry closes every strategy only once", async () => {
  let closeCalls = 0;

  class StatefulStrategy extends BaseAuthStrategy {
    static authType = "stateful";

    async close() {
      closeCalls += 1;
    }
  }

  const registry = await createAuthStrategyRegistry({
    moduleUrls: ["virtual:stateful"],
    moduleLoader: async () => ({ StatefulStrategy })
  });

  await Promise.all([registry.close(), registry.close()]);
  assert.equal(closeCalls, 1);
  await assert.rejects(
    () => registry.authenticate("stateful", {}),
    /registry is closed/
  );
});
