import assert from "node:assert/strict";
import test from "node:test";
import { BaseRequestHandler } from "../src/framework/api/BaseRequestHandler.js";
import { createHandlerRegistry } from "../src/framework/api/handlerRegistry.js";
import { createHandlerServices } from "../src/framework/api/createHandlerServices.js";
import { RequestContextService } from "../src/services/context/RequestContextService.js";

const silentLogger = {
  info: async () => {},
  error: async () => {}
};

test("handler discovery registers classes and injects the shared service container", async () => {
  const mysqlDatabase = { query: async () => [] };
  const loggers = { get: () => null };
  const context = new RequestContextService();
  const inventory = { reserve: async () => true };
  const services = createHandlerServices({
    logger: silentLogger,
    loggers,
    mysqlDatabase,
    context,
    custom: { inventory }
  });

  class CreateOrderHandler extends BaseRequestHandler {
    static handlerName = "createOrder";

    execute() {
      return { created: true };
    }
  }

  const registry = await createHandlerRegistry({
    services,
    moduleUrls: ["virtual:createOrderHandler"],
    moduleLoader: async () => ({ CreateOrderHandler })
  });

  assert.deepEqual(Object.keys(registry), ["createOrder"]);
  assert.ok(registry.createOrder instanceof CreateOrderHandler);
  assert.equal(registry.createOrder.services, services);
  assert.equal(registry.createOrder.mysqlDatabase, mysqlDatabase);
  assert.equal(registry.createOrder.services.require("loggers"), loggers);
  assert.equal(registry.createOrder.services.require("inventory"), inventory);
  assert.equal(registry.createOrder.context, services.require("context"));
  assert.equal(typeof services.require, "function");
  assert.equal(Object.isFrozen(registry), true);
});

test("handler discovery rejects duplicate handler names at startup", async () => {
  class FirstHandler extends BaseRequestHandler {
    static handlerName = "duplicate";
  }
  class SecondHandler extends BaseRequestHandler {
    static handlerName = "duplicate";
  }

  await assert.rejects(
    () =>
      createHandlerRegistry({
        services: { logger: silentLogger },
        moduleUrls: ["virtual:first", "virtual:second"],
        moduleLoader: async (url) =>
          url === "virtual:first" ? { FirstHandler } : { SecondHandler }
      }),
    /Duplicate handler name discovered/
  );
});
