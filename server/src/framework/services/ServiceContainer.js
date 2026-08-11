import { AsyncLocalStorage } from "node:async_hooks";
import { reportInternalFailure } from "../diagnostics/reportInternalFailure.js";

function plainObject(value, fieldName) {
  if (value === undefined) {
    return {};
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${fieldName} must be an object`);
  }

  return value;
}

function withTimeout(operation, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return operation;
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Service lifecycle exceeded ${timeoutMs}ms`)),
      timeoutMs
    );

    Promise.resolve(operation).then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      }
    );
  });
}

export class ServiceContainer {
  constructor({
    definitions = [],
    config = {},
    overrides,
    factories,
    values,
    options
  } = {}) {
    this.config = config;
    this.definitions = new Map();
    this.instances = new Map();
    this.overrides = new Map(Object.entries(plainObject(overrides, "Service overrides")));
    this.factories = new Map(Object.entries(plainObject(factories, "Service factories")));
    this.options = plainObject(options, "Service options");
    this.creationOrder = [];
    this.initializationPromises = new Map();
    this.closedServices = new Set();
    this.scopeStorage = new AsyncLocalStorage();
    this.scopeStates = new WeakMap();
    this.activeScopes = new Set();
    this.initialized = false;
    this.shutdownStarted = false;

    for (const definition of definitions) {
      if (this.definitions.has(definition.name)) {
        throw new Error(`Duplicate service definition: ${definition.name}`);
      }

      this.definitions.set(definition.name, definition);
    }

    for (const [name, value] of Object.entries(plainObject(values, "Service values"))) {
      this.registerValue(name, value);
    }

    this.initializationOrder = this.validateDependencyGraph();
  }

  registerValue(name, value) {
    if (this.initialized || this.shutdownStarted) {
      throw new Error("Service values must be registered before initialization");
    }

    if (this.definitions.has(name) || this.instances.has(name)) {
      throw new Error(`Service is already registered: ${name}`);
    }

    this.instances.set(name, value);
    return this;
  }

  validateDependencyGraph() {
    const order = [];
    const states = new Map();
    const visit = (name, path = []) => {
      const state = states.get(name);

      if (state === "visited") {
        return;
      }

      if (state === "visiting") {
        throw new Error(`Circular service dependency: ${[...path, name].join(" -> ")}`);
      }

      const definition = this.definitions.get(name);

      if (!definition) {
        return;
      }

      states.set(name, "visiting");

      for (const dependency of definition.dependencies) {
        if (!this.definitions.has(dependency) && !this.instances.has(dependency)) {
          throw new Error(
            `Service "${name}" requires missing dependency "${dependency}"`
          );
        }

        const dependencyDefinition = this.definitions.get(dependency);

        if (
          definition.lifecycle === "singleton" &&
          dependencyDefinition &&
          dependencyDefinition.lifecycle !== "singleton"
        ) {
          throw new Error(
            `Singleton service "${name}" cannot depend on ${dependencyDefinition.lifecycle} service "${dependency}"`
          );
        }

        visit(dependency, [...path, name]);
      }

      states.set(name, "visited");
      order.push(name);
    };

    for (const name of this.definitions.keys()) {
      visit(name);
    }

    return Object.freeze(order);
  }

  async initialize() {
    if (this.initialized) {
      return this;
    }

    try {
      for (const name of this.initializationOrder) {
        const definition = this.definitions.get(name);

        if (definition.lifecycle === "singleton" && definition.eager) {
          await this.resolve(name);
        }
      }
    } catch (error) {
      await this.shutdown();
      throw error;
    }

    this.initialized = true;
    return this;
  }

  has(name) {
    return this.instances.has(name) || this.definitions.has(name);
  }

  get(name) {
    return this.instances.get(name);
  }

  require(name) {
    if (!this.instances.has(name)) {
      throw new Error(
        `Service is not initialized: ${name}. Use resolve() for lazy or scoped services.`
      );
    }

    return this.instances.get(name);
  }

  names() {
    return [...new Set([...this.definitions.keys(), ...this.instances.keys()])];
  }

  describe() {
    return this.names().map((name) => {
      const definition = this.definitions.get(name);

      return Object.freeze({
        name,
        lifecycle: definition?.lifecycle || "singleton-value",
        dependencies: definition?.dependencies || Object.freeze([]),
        className: definition?.ServiceClass?.name || this.instances.get(name)?.constructor?.name || null,
        module: definition?.moduleUrl || null
      });
    });
  }

  async resolve(name, { scope } = {}) {
    const activeScope = scope || this.scopeStorage.getStore() || null;

    if (this.instances.has(name)) {
      return this.instances.get(name);
    }

    const definition = this.definitions.get(name);

    if (!definition) {
      throw new Error(`Service is not registered: ${name}`);
    }

    if (definition.lifecycle === "request") {
      if (!activeScope) {
        throw new Error(`Request-scoped service "${name}" requires a service scope`);
      }

      if (activeScope.closed) {
        throw new Error(`Request service scope is closed: ${name}`);
      }

      if (activeScope.instances.has(name)) {
        return activeScope.instances.get(name);
      }

      if (!activeScope.promises.has(name)) {
        activeScope.promises.set(
          name,
          this.createInstance(definition, { track: false, scope: activeScope })
            .then((instance) => {
              activeScope.instances.set(name, instance);
              return instance;
            })
            .finally(() => activeScope.promises.delete(name))
        );
      }

      return activeScope.promises.get(name);
    }

    if (definition.lifecycle === "transient") {
      if (activeScope?.closed) {
        throw new Error(`Request service scope is closed: ${name}`);
      }

      return this.createInstance(definition, {
        track: false,
        scope: activeScope
      });
    }

    if (!this.initializationPromises.has(name)) {
      this.initializationPromises.set(
        name,
        this.createInstance(definition).finally(() => {
          this.initializationPromises.delete(name);
        })
      );
    }

    return this.initializationPromises.get(name);
  }

  /**
   * 建立單一 service 所看到的 services 物件。
   *
   * get() 與 require() 只看得見「自己宣告過的依賴」與「當前 request scope 內的
   * 實例」。這裡以前會落回 this.get(name)，於是任何已初始化的 singleton 不宣告
   * 也拿得到——宣告因此形同虛設，而容器的初始化與關機順序完全照宣告排：
   *
   * - 沒宣告的耦合會讓關機順序變成碰運氣。被使用的一方可能先關閉，使用它的一方
   *   在自己的 shutdown 裡就會撞上已關閉的資源，而發現順序是按檔名排的，改個
   *   檔名就可能翻轉結果。
   * - 啟動日誌記錄的依賴圖會少掉那條邊，循環偵測也看不到它。
   *
   * resolve() 刻意保留為逃生口：延遲初始化的 singleton 與 request-scoped
   * service 本來就無法宣告成建構期依賴。
   */
  createServiceAccess(dependencies, scope) {
    const get = (name) => {
      const activeScope = scope || this.scopeStorage.getStore() || null;

      if (dependencies.has(name)) {
        return dependencies.get(name);
      }

      if (activeScope?.instances.has(name)) {
        return activeScope.instances.get(name);
      }

      return undefined;
    };

    return Object.freeze({
      // 「我拿得到嗎」，而不是「容器裡有沒有」——後者會誘使呼叫端去拿沒宣告的東西。
      has: (name) => get(name) !== undefined,
      get,
      require: (name) => {
        const service = get(name);

        if (service === undefined) {
          throw new Error(
            this.has(name)
              ? `Service "${name}" was not declared as a dependency. Add it to static service.dependencies, or use resolve() for lazy and request-scoped services.`
              : `Service is not registered: ${name}`
          );
        }

        return service;
      },
      resolve: (name) => this.resolve(name, { scope }),
      names: () => this.names(),
      describe: () => this.describe()
    });
  }

  async createInstance(definition, { track = true, scope } = {}) {
    const dependencies = new Map();

    for (const dependency of definition.dependencies) {
      dependencies.set(
        dependency,
        await this.resolve(dependency, { scope })
      );
    }

    const constructorContext = {
      config: this.config,
      services: this.createServiceAccess(dependencies, scope),
      options: this.options[definition.name] || {}
    };
    const override = this.overrides.get(definition.name);
    const factory = this.factories.get(definition.name);
    const instance = override ||
      (factory
        ? await factory(constructorContext)
        : new definition.ServiceClass(constructorContext));

    if (!instance || (typeof instance !== "object" && typeof instance !== "function")) {
      throw new TypeError(`Service "${definition.name}" did not create an instance`);
    }

    try {
      await instance.initialize?.();
    } catch (error) {
      const lifecycleMethod = instance.shutdown || instance.close;

      try {
        await lifecycleMethod?.call(instance);
      } catch (cleanupError) {
        // 原本的啟動錯誤才是根因，要原封不動往上拋。但這個 instance 從來沒有
        // 被 track，正常 shutdown 不會再碰它一次——清理失敗在這裡不記就永遠
        // 消失了。logging service 自己可能就是啟動失敗的那一個，所以走 stderr。
        reportInternalFailure("services.rollback_cleanup_failed", cleanupError, {
          service: definition.name,
          startupError: error.message
        });
      }

      throw error;
    }

    if (track) {
      this.instances.set(definition.name, instance);
      this.creationOrder.push(definition.name);
    } else if (scope) {
      scope.creationOrder.push({ name: definition.name, instance });
    }

    return instance;
  }

  createScope() {
    const scope = {
      instances: new Map(),
      promises: new Map(),
      creationOrder: [],
      closedInstances: new Set(),
      closed: false,
      shutdownPromise: null,
      shutdown: null
    };
    const api = {
      resolve: (name) => this.resolve(name, { scope }),
      get: (name) =>
        scope.instances.has(name) ? scope.instances.get(name) : this.get(name),
      require: (name) => {
        if (scope.instances.has(name)) {
          return scope.instances.get(name);
        }

        return this.require(name);
      },
      run: (callback) => this.runInScope(api, callback),
      shutdown: ({ timeoutMs } = {}) => {
        if (scope.shutdownPromise) {
          return scope.shutdownPromise;
        }

        scope.shutdownPromise = (async () => {
          const failures = [];

          try {
            await withTimeout(
              Promise.allSettled([...scope.promises.values()]),
              timeoutMs
            );
          } catch (error) {
            failures.push({ name: "request-service-initialization", error });
          }

          for (const { name, instance } of [...scope.creationOrder].reverse()) {
            if (scope.closedInstances.has(instance)) {
              continue;
            }

            const lifecycleMethod = instance?.shutdown || instance?.close;

            try {
              await withTimeout(lifecycleMethod?.call(instance), timeoutMs);
            } catch (error) {
              failures.push({ name, error });
            }

            scope.closedInstances.add(instance);
          }

          scope.closed = true;
          this.activeScopes.delete(scope);

          return Object.freeze({
            closed: failures.length === 0,
            failures: Object.freeze(failures)
          });
        })();

        return scope.shutdownPromise;
      }
    };

    const frozenApi = Object.freeze(api);
    this.scopeStates.set(frozenApi, scope);
    this.activeScopes.add(scope);
    scope.shutdown = frozenApi.shutdown;
    return frozenApi;
  }

  runInScope(scopeApi, callback) {
    const scope = this.scopeStates.get(scopeApi);

    if (!scope) {
      throw new TypeError("Service scope was not created by this container");
    }

    if (scope.closed) {
      throw new Error("Service scope is closed");
    }

    if (typeof callback !== "function") {
      throw new TypeError("Service scope callback must be a function");
    }

    return this.scopeStorage.run(scope, callback);
  }

  async shutdown({ exclude = [], timeoutMs } = {}) {
    this.shutdownStarted = true;
    const excluded = new Set(exclude);
    const results = {};
    const failures = [];

    const scopeResults = await Promise.all(
      [...this.activeScopes].map((scope) => scope.shutdown({ timeoutMs }))
    );

    for (const result of scopeResults) {
      failures.push(...result.failures);
    }

    for (const name of [...this.creationOrder].reverse()) {
      if (excluded.has(name) || this.closedServices.has(name)) {
        continue;
      }

      const instance = this.instances.get(name);
      const lifecycleMethod = instance?.shutdown || instance?.close;

      try {
        await withTimeout(lifecycleMethod?.call(instance), timeoutMs);
        results[name] = true;
      } catch (error) {
        results[name] = false;
        failures.push({ name, error });
      }

      this.closedServices.add(name);
    }

    return Object.freeze({
      closed: failures.length === 0,
      results: Object.freeze(results),
      failures: Object.freeze(failures)
    });
  }
}
