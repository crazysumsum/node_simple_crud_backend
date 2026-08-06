import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_SERVICES_DIRECTORY = new URL("../../services/", import.meta.url);
const SERVICE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9._-]*$/;
const SERVICE_LIFECYCLES = new Set(["singleton", "request", "transient"]);

async function findServiceModules(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const modules = [];

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      modules.push(...(await findServiceModules(entryPath)));
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

function normalizeServiceDefinition(ServiceClass, moduleUrl) {
  const metadata = ServiceClass.service;

  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new TypeError(`${ServiceClass.name}.service must be an object`);
  }

  const name = String(metadata.name || "").trim();
  const lifecycle = String(metadata.lifecycle || "singleton").toLowerCase();
  const dependencies = metadata.dependencies ?? [];

  if (!SERVICE_NAME_PATTERN.test(name)) {
    throw new Error(`${ServiceClass.name} in ${moduleUrl} has an invalid service name`);
  }

  if (!SERVICE_LIFECYCLES.has(lifecycle)) {
    throw new Error(
      `${ServiceClass.name} in ${moduleUrl} has an invalid service lifecycle`
    );
  }

  if (
    !Array.isArray(dependencies) ||
    dependencies.some((dependency) => !SERVICE_NAME_PATTERN.test(dependency))
  ) {
    throw new Error(
      `${ServiceClass.name} in ${moduleUrl} has invalid service dependencies`
    );
  }

  return Object.freeze({
    name,
    lifecycle,
    dependencies: Object.freeze([...new Set(dependencies)]),
    eager: metadata.eager !== false,
    ServiceClass,
    moduleUrl
  });
}

export async function discoverServiceDefinitions({
  servicesDirectory = DEFAULT_SERVICES_DIRECTORY,
  moduleUrls,
  additionalModuleUrls = [],
  moduleLoader = (url) => import(url)
} = {}) {
  const directory =
    servicesDirectory instanceof URL
      ? fileURLToPath(servicesDirectory)
      : path.resolve(String(servicesDirectory));
  if (!Array.isArray(additionalModuleUrls)) {
    throw new TypeError("additionalModuleUrls must be an array");
  }

  const urls = moduleUrls || [
    ...(await findServiceModules(directory)),
    ...additionalModuleUrls
  ];
  const modules = await Promise.all(urls.map((url) => moduleLoader(url)));
  const definitions = [];
  const names = new Map();

  for (const [moduleIndex, moduleNamespace] of modules.entries()) {
    const classes = [...new Set(Object.values(moduleNamespace))].filter(
      (value) =>
        typeof value === "function" &&
        Object.hasOwn(value, "service")
    );

    for (const ServiceClass of classes) {
      const definition = normalizeServiceDefinition(
        ServiceClass,
        urls[moduleIndex]
      );
      const existing = names.get(definition.name);

      if (existing) {
        throw new Error(
          `Duplicate service name "${definition.name}" in ${existing} and ${definition.moduleUrl}`
        );
      }

      names.set(definition.name, definition.moduleUrl);
      definitions.push(definition);
    }
  }

  return Object.freeze(definitions);
}

export { SERVICE_LIFECYCLES, SERVICE_NAME_PATTERN };
