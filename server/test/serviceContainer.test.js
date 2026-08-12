import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ServiceContainer } from "../src/framework/services/ServiceContainer.js";
import { discoverServiceDefinitions } from "../src/framework/services/serviceDiscovery.js";

function definition(ServiceClass) {
  return Object.freeze({
    ...ServiceClass.service,
    eager: ServiceClass.service.eager !== false,
    ServiceClass,
    moduleUrl: `virtual:${ServiceClass.name}`
  });
}

async function javascriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await javascriptFiles(entryPath)));
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      files.push(entryPath);
    }
  }

  return files;
}

test("service container initializes singleton dependencies once and shuts down in reverse order", async () => {
  const events = [];

  class LoggingService {
    static service = {
      name: "logging",
      lifecycle: "singleton",
      dependencies: []
    };

    constructor() {
      events.push("construct:logging");
    }

    async initialize() {
      events.push("initialize:logging");
    }

    async shutdown() {
      events.push("shutdown:logging");
    }
  }

  class OrderService {
    static service = {
      name: "order",
      lifecycle: "singleton",
      dependencies: ["logging"]
    };

    constructor({ services }) {
      this.logging = services.require("logging");
      events.push("construct:order");
    }

    async initialize() {
      events.push("initialize:order");
    }

    async shutdown() {
      events.push("shutdown:order");
    }
  }

  const container = new ServiceContainer({
    definitions: [definition(OrderService), definition(LoggingService)]
  });
  await container.initialize();

  assert.equal(container.require("order"), await container.resolve("order"));
  assert.equal(container.require("order").logging, container.require("logging"));

  const result = await container.shutdown();
  assert.equal(result.closed, true);
  assert.deepEqual(events, [
    "construct:logging",
    "initialize:logging",
    "construct:order",
    "initialize:order",
    "shutdown:order",
    "shutdown:logging"
  ]);
});

test("service container rejects missing and circular dependencies", () => {
  class MissingDependencyService {
    static service = {
      name: "missingDependency",
      lifecycle: "singleton",
      dependencies: ["unknown"]
    };
  }

  assert.throws(
    () => new ServiceContainer({ definitions: [definition(MissingDependencyService)] }),
    /missing dependency/
  );

  class FirstService {
    static service = {
      name: "first",
      lifecycle: "singleton",
      dependencies: ["second"]
    };
  }

  class SecondService {
    static service = {
      name: "second",
      lifecycle: "singleton",
      dependencies: ["first"]
    };
  }

  assert.throws(
    () =>
      new ServiceContainer({
        definitions: [definition(FirstService), definition(SecondService)]
      }),
    /Circular service dependency/
  );
});

test("service discovery finds the built-in public services", async () => {
  const definitions = await discoverServiceDefinitions();
  const summary = definitions.map(({ name, lifecycle, dependencies }) => ({
    name,
    lifecycle,
    dependencies: [...dependencies]
  }));

  assert.deepEqual(summary, [
    {
      // 簽發與驗證 JWT 的服務。策略只負責從 header 取出 token，密鑰留在這裡。
      name: "jwt",
      lifecycle: "singleton",
      dependencies: []
    },
    {
      // 認證策略也是一般 service，因此出現在這份清單裡。
      name: "auth.jwt",
      lifecycle: "singleton",
      dependencies: ["jwt", "logging"]
    },
    {
      // 自己不記錄任何東西，但 BaseAuthStrategy 會取用 logging。
      name: "auth.public",
      lifecycle: "singleton",
      dependencies: ["logging"]
    },
    {
      name: "context",
      lifecycle: "singleton",
      dependencies: ["time"]
    },
    {
      name: "filetypes",
      lifecycle: "singleton",
      dependencies: []
    },
    {
      name: "logging",
      lifecycle: "singleton",
      dependencies: ["time"]
    },
    {
      name: "mysqldatabase",
      lifecycle: "singleton",
      dependencies: ["logging", "context"]
    },
    {
      // 限流器是 service，中間件只是它的產出。框架用 get() 取它，所以停用之後
      // 應用照常啟動，只是不掛限流。
      name: "requestLimiter",
      lifecycle: "singleton",
      dependencies: ["logging", "time"]
    },
    {
      name: "scheduler",
      lifecycle: "singleton",
      dependencies: ["logging", "time", "mysqldatabase"]
    },
    {
      // jobs/ 就在 src/services/ 底下，所以定時工作被同一套自發現載入，
      // 不需要第四套機制。
      name: "job.logRetention",
      lifecycle: "singleton",
      dependencies: ["scheduler", "logging"]
    },
    {
      // 排程器依賴被隔離在葉子裡：掛在限流器身上的話，停用排程器會讓限流器
      // 建構失敗，而框架用 get() 取限流器——等於靜默地關掉限流。
      name: "job.rateLimitPurge",
      lifecycle: "singleton",
      dependencies: ["scheduler", "requestLimiter"]
    },
    {
      name: "time",
      lifecycle: "singleton",
      dependencies: []
    }
  ]);
});

test("service discovery rejects duplicate service names", async () => {
  class FirstService {
    static service = {
      name: "duplicate",
      lifecycle: "singleton",
      dependencies: []
    };
  }

  class SecondService {
    static service = {
      name: "duplicate",
      lifecycle: "singleton",
      dependencies: []
    };
  }

  await assert.rejects(
    () =>
      discoverServiceDefinitions({
        moduleUrls: ["virtual:first", "virtual:second"],
        moduleLoader: async (url) =>
          url === "virtual:first" ? { FirstService } : { SecondService }
      }),
    /Duplicate service name/
  );
});

test("service container rolls initialized services back when startup fails", async () => {
  const events = [];

  class ReadyService {
    static service = {
      name: "ready",
      lifecycle: "singleton",
      dependencies: []
    };

    async initialize() {
      events.push("initialize:ready");
    }

    async shutdown() {
      events.push("shutdown:ready");
    }
  }

  class FailingService {
    static service = {
      name: "failing",
      lifecycle: "singleton",
      dependencies: ["ready"]
    };

    async initialize() {
      events.push("initialize:failing");
      throw new Error("startup failed");
    }

    async shutdown() {
      events.push("shutdown:failing");
    }
  }

  const container = new ServiceContainer({
    definitions: [definition(ReadyService), definition(FailingService)]
  });

  await assert.rejects(() => container.initialize(), /startup failed/);
  assert.deepEqual(events, [
    "initialize:ready",
    "initialize:failing",
    "shutdown:failing",
    "shutdown:ready"
  ]);
});

test("request and transient services remain isolated inside service scopes", async () => {
  let requestInstances = 0;
  let transientInstances = 0;
  let requestShutdowns = 0;
  let transientShutdowns = 0;

  class SharedService {
    static service = {
      name: "shared",
      lifecycle: "singleton",
      dependencies: []
    };
  }

  class TransientService {
    static service = {
      name: "transientValue",
      lifecycle: "transient",
      dependencies: ["shared"]
    };

    constructor({ services }) {
      this.shared = services.require("shared");
      this.instanceNumber = ++transientInstances;
    }

    async shutdown() {
      transientShutdowns += 1;
    }
  }

  class RequestService {
    static service = {
      name: "requestValue",
      lifecycle: "request",
      dependencies: ["shared", "transientValue"]
    };

    constructor({ services }) {
      this.shared = services.require("shared");
      this.transient = services.require("transientValue");
      this.instanceNumber = ++requestInstances;
    }

    async shutdown() {
      requestShutdowns += 1;
    }
  }

  const container = new ServiceContainer({
    definitions: [
      definition(RequestService),
      definition(TransientService),
      definition(SharedService)
    ]
  });
  await container.initialize();
  const firstScope = container.createScope();
  const secondScope = container.createScope();
  const first = await firstScope.resolve("requestValue");
  const firstAgain = await firstScope.resolve("requestValue");
  const second = await secondScope.resolve("requestValue");

  assert.equal(first, firstAgain);
  assert.notEqual(first, second);
  assert.equal(first.shared, container.require("shared"));
  assert.equal(requestInstances, 2);
  assert.equal(transientInstances, 2);
  assert.equal(container.get("requestValue"), undefined);

  assert.equal((await firstScope.shutdown()).closed, true);
  assert.equal((await secondScope.shutdown()).closed, true);
  assert.equal(requestShutdowns, 2);
  assert.equal(transientShutdowns, 2);
});

test("service resolution automatically uses the active asynchronous request scope", async () => {
  class RequestService {
    static service = {
      name: "requestValue",
      lifecycle: "request",
      dependencies: []
    };
  }

  const container = new ServiceContainer({
    definitions: [definition(RequestService)]
  });
  const scope = container.createScope();
  const resolved = await scope.run(async () => {
    await Promise.resolve();
    return container.resolve("requestValue");
  });

  assert.equal(resolved, await scope.resolve("requestValue"));
  await scope.shutdown();
  assert.throws(
    () => scope.run(() => container.resolve("requestValue")),
    /scope is closed/
  );
});

test("singleton services reject request-scoped dependencies", () => {
  class RequestService {
    static service = {
      name: "requestValue",
      lifecycle: "request",
      dependencies: []
    };
  }

  class InvalidSingletonService {
    static service = {
      name: "invalidSingleton",
      lifecycle: "singleton",
      dependencies: ["requestValue"]
    };
  }

  assert.throws(
    () =>
      new ServiceContainer({
        definitions: [definition(RequestService), definition(InvalidSingletonService)]
      }),
    /cannot depend on request service/
  );
});

test("production modules do not directly construct container-owned public services", async () => {
  const sourceDirectory = fileURLToPath(new URL("../src/", import.meta.url));
  const files = await javascriptFiles(sourceDirectory);
  const violations = [];
  const directPublicServiceConstruction =
    /new\s+(?:MySqlDatabaseService|RequestContextService|LoggingService)\s*\(/;

  for (const file of files) {
    const source = await readFile(file, "utf8");

    if (directPublicServiceConstruction.test(source)) {
      violations.push(path.relative(sourceDirectory, file));
    }

    if (
      /new\s+Logger\s*\(/.test(source) &&
      !file.endsWith(path.join("services", "logging", "LoggerRegistry.js"))
    ) {
      violations.push(path.relative(sourceDirectory, file));
    }

    if (
      /new\s+(?:LoggerRegistry|SystemLogger)\s*\(/.test(source) &&
      !file.endsWith(path.join("services", "logging", "LoggingService.js"))
    ) {
      violations.push(path.relative(sourceDirectory, file));
    }
  }

  assert.deepEqual(violations, []);
});
