import { ServiceContainer } from "./ServiceContainer.js";
import { discoverServiceDefinitions } from "./serviceDiscovery.js";

export async function createServiceContainer({
  config,
  overrides,
  factories,
  values,
  options,
  discoveryOptions
} = {}) {
  const definitions = await discoverServiceDefinitions(discoveryOptions);
  const container = new ServiceContainer({
    definitions,
    config,
    overrides,
    factories,
    values,
    options
  });

  await container.initialize();
  return container;
}
