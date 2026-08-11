export class BaseService {
  constructor({ config, services, options = {} } = {}) {
    // config 是整份應用設定，每個 service 都拿得到同一份。設為不可列舉，
    // 這樣 JSON.stringify(service) 或把 service 塞進日誌 context 時，不會
    // 順手把整份設定一起帶出去。讀寫行為完全不變。
    Object.defineProperty(this, "config", {
      value: config,
      writable: true,
      enumerable: false,
      configurable: true
    });
    this.services = services;
    this.options = options;
  }

  async initialize() {}

  async shutdown() {}
}
