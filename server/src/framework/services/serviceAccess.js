export function optionalService(services, name) {
  if (!services) {
    return undefined;
  }

  if (typeof services.get === "function") {
    return services.get(name);
  }

  return services[name];
}

export function requireService(services, name) {
  if (services && typeof services.require === "function") {
    return services.require(name);
  }

  const service = optionalService(services, name);

  if (service === undefined) {
    throw new Error(`Service is not available: ${name}`);
  }

  return service;
}

export function systemLoggerFromServices(services) {
  return optionalService(services, "logging")?.logger ||
    optionalService(services, "logger") ||
    null;
}
