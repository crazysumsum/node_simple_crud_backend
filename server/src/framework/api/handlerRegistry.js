import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BaseRequestHandler } from "./BaseRequestHandler.js";
import { systemLoggerFromServices } from "../services/serviceAccess.js";

const DEFAULT_HANDLERS_DIRECTORY = new URL("../../handlers/", import.meta.url);
const HANDLER_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9._-]*$/;

async function findHandlerModules(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const modules = [];

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      modules.push(...(await findHandlerModules(entryPath)));
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

function exportedHandlerClasses(moduleNamespace) {
  return [...new Set(Object.values(moduleNamespace))].filter(
    (value) =>
      typeof value === "function" &&
      value !== BaseRequestHandler &&
      value.prototype instanceof BaseRequestHandler
  );
}

export async function createHandlerRegistry({
  services = {},
  handlersDirectory = DEFAULT_HANDLERS_DIRECTORY,
  moduleUrls,
  moduleLoader = (url) => import(url)
} = {}) {
  if (services === null || typeof services !== "object" || Array.isArray(services)) {
    throw new TypeError("Handler registry services must be an object");
  }

  const directory =
    handlersDirectory instanceof URL
      ? fileURLToPath(handlersDirectory)
      : path.resolve(String(handlersDirectory));
  const urls = moduleUrls || (await findHandlerModules(directory));
  const modules = await Promise.all(urls.map((url) => moduleLoader(url)));
  const registry = Object.create(null);
  const logger = systemLoggerFromServices(services);

  for (const [moduleIndex, moduleNamespace] of modules.entries()) {
    const handlerClasses = exportedHandlerClasses(moduleNamespace);

    for (const HandlerClass of handlerClasses) {
      if (
        typeof HandlerClass.handlerName !== "string" ||
        !HANDLER_NAME_PATTERN.test(HandlerClass.handlerName)
      ) {
        throw new Error(
          `${HandlerClass.name} in ${urls[moduleIndex]} has an invalid static handlerName`
        );
      }

      const handler = new HandlerClass(services);

      if (handler.handlerName !== HandlerClass.handlerName) {
        throw new Error(
          `${HandlerClass.name} instance handlerName must match its static handlerName`
        );
      }

      if (Object.hasOwn(registry, handler.handlerName)) {
        throw new Error(`Duplicate handler name discovered: ${handler.handlerName}`);
      }

      registry[handler.handlerName] = handler;
      void logger?.info?.("handler.registered", "Request handler registered", {
        handler: handler.handlerName,
        className: HandlerClass.name,
        module: urls[moduleIndex]
      });
    }
  }

  void logger?.info?.(
    "handler.registration.completed",
    "Request handler discovery completed",
    { handlerCount: Object.keys(registry).length, handlers: Object.keys(registry) }
  );

  return Object.freeze(registry);
}
