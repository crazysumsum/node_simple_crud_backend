import assert from "node:assert/strict";
import test from "node:test";
import { AuthenticationError } from "../src/framework/auth/AuthenticationError.js";
import { BaseAuthStrategy } from "../src/framework/auth/BaseAuthStrategy.js";
import { createAuthStrategyRegistry } from "../src/framework/auth/authStrategyRegistry.js";
import { ServiceContainer } from "../src/framework/services/ServiceContainer.js";

const silentLogger = { info: async () => {} };

/**
 * 策略現在是一般 service，所以測試也用真正的 container 建立它們——
 * 這樣才會連帶驗證依賴注入與生命週期都走同一條路。
 */
async function containerWith(strategyClasses, values = {}) {
  const container = new ServiceContainer({
    definitions: strategyClasses.map((ServiceClass) => ({
      name: ServiceClass.service.name,
      lifecycle: ServiceClass.service.lifecycle,
      dependencies: Object.freeze([...ServiceClass.service.dependencies]),
      eager: true,
      ServiceClass,
      moduleUrl: `virtual:${ServiceClass.name}`
    })),
    values: { logging: { logger: silentLogger }, ...values }
  });
  await container.initialize();
  return container;
}

function strategyService(name, dependencies = []) {
  // BaseAuthStrategy 的建構子會取用 logging，所以每個策略都必須宣告它——
  // 容器只會把宣告過的依賴交給 service。
  return Object.freeze({
    name,
    lifecycle: "singleton",
    dependencies: ["logging", ...dependencies],
    eager: true
  });
}

test("auth strategies are collected from the service container", async () => {
  class ApiKeyAuthStrategy extends BaseAuthStrategy {
    static authType = "apiKey";
    static service = strategyService("auth.apiKey", ["expectedKey"]);

    async authenticate(req) {
      if (req.get("x-api-key") !== this.services.require("expectedKey")) {
        throw new AuthenticationError("API_KEY_INVALID", "API key is invalid");
      }

      return { type: this.authType, claims: { sub: "api-client" } };
    }
  }

  const services = await containerWith([ApiKeyAuthStrategy], { expectedKey: "secret" });
  const registry = createAuthStrategyRegistry({ services, logger: silentLogger });
  const request = { get: (name) => (name === "x-api-key" ? "secret" : undefined) };

  assert.deepEqual(registry.types(), ["apiKey"]);
  assert.deepEqual(await registry.authenticate("apiKey", request), {
    type: "apiKey",
    claims: { sub: "api-client" }
  });
  assert.equal(request.auth.type, "apiKey");
  assert.deepEqual(request.user, { sub: "api-client" });
  assert.equal(Object.isFrozen(request.auth), true);
});

test("the registry ignores container entries that are not strategies", async () => {
  class ApiKeyAuthStrategy extends BaseAuthStrategy {
    static authType = "apiKey";
    static service = strategyService("auth.apiKey");

    async authenticate() {
      return { type: this.authType };
    }
  }

  class PlainService {
    static service = strategyService("plain");
  }

  const services = await containerWith([ApiKeyAuthStrategy, PlainService], {
    someValue: 42
  });
  const registry = createAuthStrategyRegistry({ services, logger: silentLogger });

  assert.deepEqual(registry.types(), ["apiKey"]);
});

test("the registry rejects duplicate auth types", async () => {
  class FirstStrategy extends BaseAuthStrategy {
    static authType = "duplicate";
    static service = strategyService("auth.first");

    async authenticate() {
      return { type: this.authType };
    }
  }
  class SecondStrategy extends BaseAuthStrategy {
    static authType = "duplicate";
    static service = strategyService("auth.second");

    async authenticate() {
      return { type: this.authType };
    }
  }

  const services = await containerWith([FirstStrategy, SecondStrategy]);

  assert.throws(
    () => createAuthStrategyRegistry({ services, logger: silentLogger }),
    /Duplicate authentication strategy/
  );
});

test("the registry rejects an invalid static authType", async () => {
  class BrokenStrategy extends BaseAuthStrategy {
    static authType = "not a valid type";
    static service = strategyService("auth.broken");

    async authenticate() {
      return { type: this.authType };
    }
  }

  const services = await containerWith([BrokenStrategy]);

  assert.throws(
    () => createAuthStrategyRegistry({ services, logger: silentLogger }),
    /invalid static authType/
  );
});

test("the registry validates the returned auth contract", async () => {
  class InvalidStrategy extends BaseAuthStrategy {
    static authType = "invalid";
    static service = strategyService("auth.invalid");

    async authenticate() {
      return { type: "anotherType" };
    }
  }

  const services = await containerWith([InvalidStrategy]);
  const registry = createAuthStrategyRegistry({ services, logger: silentLogger });

  await assert.rejects(
    () => registry.authenticate("invalid", {}),
    /must return type "invalid"/
  );
});

test("strategy shutdown is driven by the container, not the registry", async () => {
  let closeCalls = 0;

  class StatefulStrategy extends BaseAuthStrategy {
    static authType = "stateful";
    static service = strategyService("auth.stateful");

    async authenticate() {
      return { type: this.authType };
    }

    async shutdown() {
      closeCalls += 1;
    }
  }

  const services = await containerWith([StatefulStrategy]);
  const registry = createAuthStrategyRegistry({ services, logger: silentLogger });

  assert.deepEqual(registry.types(), ["stateful"]);
  // registry 不再擁有生命週期，容器關閉時策略才會被關閉，且只關一次。
  assert.equal(typeof registry.close, "undefined");
  await services.shutdown();
  await services.shutdown();
  assert.equal(closeCalls, 1);
});

test("a strategy must declare a static authType", async () => {
  class NamelessStrategy extends BaseAuthStrategy {
    static service = strategyService("auth.nameless");
  }

  await assert.rejects(
    () => containerWith([NamelessStrategy]),
    /must declare a non-empty static authType/
  );
});
