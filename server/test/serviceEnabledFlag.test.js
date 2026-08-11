import assert from "node:assert/strict";
import test from "node:test";
import { ServiceContainer } from "../src/framework/services/ServiceContainer.js";
import { discoverServiceDefinitions } from "../src/framework/services/serviceDiscovery.js";

// static service.enabled 讓同一份程式碼在不同部署載入不同的 service。停用的
// service 不建構、不出現在容器裡，但名字要留著——有人依賴它時，「被停用」和
// 「不存在」是兩件不同的事，修法也不同。

const def = (name, dependencies, ServiceClass, extra = {}) => ({
  name,
  lifecycle: "singleton",
  dependencies: Object.freeze(dependencies),
  eager: true,
  enabled: true,
  ServiceClass,
  moduleUrl: `virtual:${name}`,
  ...extra
});

function tracked(label, built) {
  return class Tracked {
    constructor() {
      built.push(label);
    }
  };
}

test("a disabled service is never constructed and is absent from the container", async () => {
  const built = [];
  const container = new ServiceContainer({
    definitions: [
      def("kept", [], tracked("kept", built)),
      def("dropped", [], tracked("dropped", built), { enabled: false })
    ]
  });
  await container.initialize();

  assert.deepEqual(built, ["kept"]);
  assert.deepEqual(container.names(), ["kept"]);
  assert.equal(container.has("dropped"), false);
  assert.deepEqual(
    container.describe().map(({ name }) => name),
    ["kept"]
  );

  // 但啟動日誌看得到它被略過，否則「service 為什麼不見了」只能翻原始碼。
  assert.deepEqual(container.describeDisabled(), [
    { name: "dropped", className: "Tracked", module: "virtual:dropped" }
  ]);

  await container.shutdown();
});

test("depending on a disabled service fails at construction, saying it is disabled", () => {
  class Anything {}

  assert.throws(
    () =>
      new ServiceContainer({
        definitions: [
          def("reports", ["database"], Anything),
          def("database", [], Anything, { enabled: false })
        ]
      }),
    (error) => {
      // 「不存在」會讓人去找一個根本沒打錯的名字，訊息必須指出真正的原因。
      assert.match(error.message, /"reports" requires "database", which is disabled/);
      assert.match(error.message, /static service\.enabled/);
      return true;
    }
  );

  // 真的不存在時仍然是原本的訊息。
  assert.throws(
    () =>
      new ServiceContainer({
        definitions: [def("reports", ["nowhere"], Anything)]
      }),
    /requires missing dependency "nowhere"/
  );
});

test("a disabled service may itself declare dependencies that are also disabled", async () => {
  class Anything {}

  // 停用的 service 不會被走訪，所以它的依賴不需要存在——整組一起關掉才可行。
  const container = new ServiceContainer({
    definitions: [
      def("reportExport", ["reportEngine"], Anything, { enabled: false }),
      def("reportEngine", [], Anything, { enabled: false }),
      def("core", [], Anything)
    ]
  });
  await container.initialize();

  assert.deepEqual(container.names(), ["core"]);
  await container.shutdown();
});

test("reaching a disabled service at runtime says so", async () => {
  class Anything {}
  class Consumer {
    constructor({ services }) {
      this.services = services;
    }
  }

  const container = new ServiceContainer({
    definitions: [
      def("consumer", [], Consumer),
      def("offline", [], Anything, { enabled: false })
    ]
  });
  await container.initialize();

  assert.throws(() => container.require("offline"), /Service is disabled: offline/);
  await assert.rejects(() => container.resolve("offline"), /Service is disabled: offline/);
  assert.throws(
    () => container.require("consumer").services.require("offline"),
    /Service is disabled: offline/
  );
  // 未宣告與被停用要分得開。
  assert.throws(
    () => container.require("consumer").services.require("nowhere"),
    /Service is not registered: nowhere/
  );

  await container.shutdown();
});

test("omitting the flag keeps a service enabled, and a non-boolean is rejected", async () => {
  class Present {
    static service = Object.freeze({ name: "present", lifecycle: "singleton", dependencies: [] });
  }

  // 預設啟用：既有的 service 完全不需要改。
  const [definition] = await discoverServiceDefinitions({
    moduleUrls: ["virtual:present"],
    moduleLoader: async () => ({ Present })
  });
  assert.equal(definition.enabled, true);

  class Sloppy {
    static service = Object.freeze({
      name: "sloppy",
      lifecycle: "singleton",
      dependencies: [],
      // "false" 是字串。當成停用會讓 service 因為一個打錯的設定靜靜消失。
      enabled: "false"
    });
  }

  await assert.rejects(
    () =>
      discoverServiceDefinitions({
        moduleUrls: ["virtual:sloppy"],
        moduleLoader: async () => ({ Sloppy })
      }),
    /non-boolean service "enabled" flag/
  );
});

test("a disabled name still collides with a duplicate definition", () => {
  class Anything {}

  // 停用不代表名字被釋放：兩個同名的 service 仍然是設定錯誤。
  assert.throws(
    () =>
      new ServiceContainer({
        definitions: [
          def("same", [], Anything, { enabled: false }),
          def("same", [], Anything)
        ]
      }),
    /Duplicate service definition: same/
  );
});
