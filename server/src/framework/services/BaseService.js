export class BaseService {
  constructor({ config, services, options = {} } = {}) {
    this.config = config;
    this.services = services;
    this.options = options;
  }

  async initialize() {}

  async shutdown() {}
}
