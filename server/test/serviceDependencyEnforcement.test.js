import assert from "node:assert/strict";
import test from "node:test";
import { BaseAuthStrategy } from "../src/framework/auth/BaseAuthStrategy.js";
import { ServiceContainer } from "../src/framework/services/ServiceContainer.js";

// 容器的初始化與關機順序完全照「宣告的依賴」排。只要有一條耦合沒宣告，順序就是
// 碰運氣——而發現順序是按檔名排的，改個檔名就可能翻轉結果。

const def = (name, dependencies, ServiceClass, lifecycle = "singleton") => ({
  name,
  lifecycle,
  dependencies: Object.freeze(dependencies),
  eager: true,
  ServiceClass,
  moduleUrl: `virtual:${name}`
});

test("an undeclared service is not reachable, and the error says how to fix it", async () => {
  let leaked = null;

  class Database {
    async shutdown() {}
  }

  class Audit {
    constructor({ services }) {
      this.services = services;
    }

    reach() {
      return this.services.require("database");
    }

    peek() {
      return this.services.get("database");
    }
  }

  const container = new ServiceContainer({
    definitions: [def("database", [], Database), def("audit", [], Audit)]
  });
  await container.initialize();
  const audit = container.require("audit");

  assert.equal(audit.peek(), undefined, "get() 不得回傳未宣告的 service");
  assert.equal(
    container.createServiceAccess(new Map()).has("database"),
    false,
    "has() 回答的是「我拿得到嗎」，不是「容器裡有沒有」"
  );

  assert.throws(
    () => {
      leaked = audit.reach();
    },
    // 訊息要直接說出修法，否則遇到的人只會去繞過它。
    /was not declared as a dependency.*static service\.dependencies/s
  );
  assert.equal(leaked, null);

  // 完全沒註冊的 service 要能和「有註冊但沒宣告」區分開。
  assert.throws(
    () => container.createServiceAccess(new Map()).require("nope"),
    /Service is not registered: nope/
  );

  await container.shutdown();
});

test("a declared dependency fixes both access and shutdown order", async () => {
  const log = [];

  class Database {
    constructor() {
      this.open = true;
    }

    write(row) {
      if (!this.open) {
        throw new Error("pool already closed");
      }

      log.push(`write:${row}`);
    }

    async shutdown() {
      this.open = false;
      log.push("database.shutdown");
    }
  }

  class Audit {
    constructor({ services }) {
      this.database = services.require("database");
    }

    async shutdown() {
      log.push("audit.shutdown");
      this.database.write("final");
    }
  }

  // audit 排在 database 之前，等同某天有人改了檔名而使發現順序翻轉。宣告了依賴
  // 之後，拓撲排序會把 database 提前建立，關機時也就會在 audit 之後才關閉。
  const container = new ServiceContainer({
    definitions: [def("audit", ["database"], Audit), def("database", [], Database)]
  });
  await container.initialize();

  assert.deepEqual(container.initializationOrder, ["database", "audit"]);

  const result = await container.shutdown();

  assert.deepEqual(log, ["audit.shutdown", "write:final", "database.shutdown"]);
  assert.equal(result.closed, true);
  assert.deepEqual(result.failures, []);
});

test("resolve stays available for lazy and request-scoped services", async () => {
  class Lazy {
    constructor() {
      this.ready = true;
    }
  }

  class Eager {
    constructor({ services }) {
      this.services = services;
    }

    async load() {
      // 延遲初始化的 service 無法宣告成建構期依賴，resolve() 是刻意保留的出口。
      return this.services.resolve("lazy");
    }
  }

  const container = new ServiceContainer({
    definitions: [
      { ...def("lazy", [], Lazy), eager: false },
      def("eager", [], Eager)
    ]
  });
  await container.initialize();

  const lazy = await container.require("eager").load();
  assert.equal(lazy.ready, true);

  await container.shutdown();
});

test("a request-scoped instance stays reachable inside its scope", async () => {
  class PerRequest {
    constructor() {
      this.id = "scoped";
    }
  }

  class Singleton {
    constructor({ services }) {
      this.services = services;
    }

    peek() {
      return this.services.get("perRequest");
    }
  }

  const container = new ServiceContainer({
    definitions: [
      def("perRequest", [], PerRequest, "request"),
      def("singleton", [], Singleton)
    ]
  });
  await container.initialize();
  const singleton = container.require("singleton");

  // scope 外看不到。
  assert.equal(singleton.peek(), undefined);

  const scope = container.createScope();
  await scope.run(async () => {
    await container.resolve("perRequest");
    // scope 內已經建立的實例仍然看得到——收緊 get() 不影響 request scope。
    assert.equal(singleton.peek()?.id, "scoped");
  });
  await scope.shutdown();

  await container.shutdown();
});

test("an auth strategy that does not declare logging fails at startup, not silently", async () => {
  class QuietStrategy extends BaseAuthStrategy {
    static authType = "quiet";
    static service = Object.freeze({
      name: "auth.quiet",
      lifecycle: "singleton",
      // 刻意漏掉 logging。BaseAuthStrategy 會取用它。
      dependencies: [],
      eager: true
    });

    async authenticate() {
      return { type: this.authType };
    }
  }

  const container = new ServiceContainer({
    definitions: [def("auth.quiet", [], QuietStrategy)],
    values: { logging: { logger: { info: async () => {} } } }
  });

  // 以前這裡會靜靜地把 logger 設成 null，而所有日誌呼叫都是可選鏈——認證事件
  // 就此不再被記錄，沒有任何徵兆。
  await assert.rejects(
    () => container.initialize(),
    /QuietStrategy could not resolve the system logger.*Add "logging"/s
  );
});

test("a strategy that declares logging receives it", async () => {
  const logger = { info: async () => {} };

  class LoudStrategy extends BaseAuthStrategy {
    static authType = "loud";
    static service = Object.freeze({
      name: "auth.loud",
      lifecycle: "singleton",
      dependencies: ["logging"],
      eager: true
    });

    async authenticate() {
      return { type: this.authType };
    }
  }

  const container = new ServiceContainer({
    definitions: [def("auth.loud", ["logging"], LoudStrategy)],
    values: { logging: { logger } }
  });
  await container.initialize();

  assert.equal(container.require("auth.loud").logger, logger);
  await container.shutdown();
});
