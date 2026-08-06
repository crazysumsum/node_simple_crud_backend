import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AuthenticationError } from "./AuthenticationError.js";
import { BaseAuthStrategy } from "./BaseAuthStrategy.js";
import { createAuthStrategyServices } from "./createAuthStrategyServices.js";
import { systemLoggerFromServices } from "../services/serviceAccess.js";

const DEFAULT_STRATEGIES_DIRECTORY = new URL(
  "../../auth_strategies/",
  import.meta.url
);
const AUTH_TYPE_PATTERN = /^[A-Za-z][A-Za-z0-9._-]*$/;

async function findStrategyModules(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const modules = [];

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      modules.push(...(await findStrategyModules(entryPath)));
      continue;
    }

    if (
      entry.isFile() &&
      entry.name.endsWith(".js") &&
      !entry.name.endsWith(".test.js") &&
      !entry.name.startsWith("_")
    ) {
      modules.push(pathToFileURL(entryPath).href);
    }
  }

  return modules.sort();
}

function exportedStrategyClasses(moduleNamespace) {
  return [...new Set(Object.values(moduleNamespace))].filter(
    (value) =>
      typeof value === "function" &&
      value !== BaseAuthStrategy &&
      value.prototype instanceof BaseAuthStrategy
  );
}

export class AuthStrategyRegistry {
  constructor() {
    this.strategies = new Map();
    this.closePromise = null;
  }

  register(type, strategy) {
    if (this.closePromise) {
      throw new Error("Authentication strategy registry is closed");
    }

    if (typeof type !== "string" || !AUTH_TYPE_PATTERN.test(type)) {
      throw new TypeError("Authentication type is invalid");
    }

    const authenticate =
      strategy instanceof BaseAuthStrategy
        ? strategy.authenticate.bind(strategy)
        : strategy;

    if (typeof authenticate !== "function") {
      throw new TypeError(
        `Authentication strategy "${type}" must implement authenticate()`
      );
    }

    if (this.strategies.has(type)) {
      throw new Error(`Duplicate authentication strategy: ${type}`);
    }

    this.strategies.set(type, { authenticate, strategy });
    return this;
  }

  has(type) {
    return this.strategies.has(type);
  }

  types() {
    return [...this.strategies.keys()];
  }

  async authenticate(type, req) {
    if (this.closePromise) {
      throw new Error("Authentication strategy registry is closed");
    }

    const entry = this.strategies.get(type);

    if (!entry) {
      throw new Error(`Unsupported authentication type: ${type}`);
    }

    const result = await entry.authenticate(req);

    if (result === null || typeof result !== "object" || Array.isArray(result)) {
      throw new TypeError(
        `Authentication strategy "${type}" must return an auth object`
      );
    }

    if (result.type !== type) {
      throw new TypeError(
        `Authentication strategy "${type}" must return type "${type}"`
      );
    }

    const auth = Object.freeze({ ...result });
    req.auth = auth;

    if (auth.claims !== undefined) {
      req.user = auth.claims;
    }

    return auth;
  }

  close() {
    if (this.closePromise) {
      return this.closePromise;
    }

    const strategies = [...this.strategies.values()]
      .map(({ strategy }) => strategy)
      .filter((strategy) => typeof strategy?.close === "function")
      .reverse();

    this.closePromise = Promise.all(
      strategies.map((strategy) =>
        Promise.resolve().then(() => strategy.close())
      )
    ).then(() => undefined);
    return this.closePromise;
  }
}

export async function createAuthStrategyRegistry({
  services = createAuthStrategyServices(),
  strategiesDirectory = DEFAULT_STRATEGIES_DIRECTORY,
  moduleUrls,
  moduleLoader = (url) => import(url)
} = {}) {
  if (services === null || typeof services !== "object" || Array.isArray(services)) {
    throw new TypeError("Authentication strategy registry services must be an object");
  }

  const directory =
    strategiesDirectory instanceof URL
      ? fileURLToPath(strategiesDirectory)
      : path.resolve(String(strategiesDirectory));
  const urls = moduleUrls || (await findStrategyModules(directory));
  const modules = await Promise.all(urls.map((url) => moduleLoader(url)));
  const registry = new AuthStrategyRegistry();
  const logger = systemLoggerFromServices(services);
  let unregisteredStrategy = null;

  try {
    for (const [moduleIndex, moduleNamespace] of modules.entries()) {
      for (const StrategyClass of exportedStrategyClasses(moduleNamespace)) {
        if (
          typeof StrategyClass.authType !== "string" ||
          !AUTH_TYPE_PATTERN.test(StrategyClass.authType)
        ) {
          throw new Error(
            `${StrategyClass.name} in ${urls[moduleIndex]} has an invalid static authType`
          );
        }

        unregisteredStrategy = new StrategyClass(services);

        if (unregisteredStrategy.authType !== StrategyClass.authType) {
          throw new Error(
            `${StrategyClass.name} instance authType must match its static authType`
          );
        }

        registry.register(unregisteredStrategy.authType, unregisteredStrategy);
        unregisteredStrategy = null;
        void logger?.info?.(
          "auth.strategy.registered",
          "Authentication strategy registered",
          {
            authType: StrategyClass.authType,
            className: StrategyClass.name,
            module: urls[moduleIndex]
          }
        );
      }
    }

    void logger?.info?.(
      "auth.strategy.registration.completed",
      "Authentication strategy discovery completed",
      { strategyCount: registry.types().length, authTypes: registry.types() }
    );

    return registry;
  } catch (error) {
    await Promise.allSettled([
      registry.close(),
      ...(typeof unregisteredStrategy?.close === "function"
        ? [Promise.resolve().then(() => unregisteredStrategy.close())]
        : [])
    ]);
    throw error;
  }
}

export { AuthenticationError };
