import { BaseService } from "../../framework/services/BaseService.js";
import {
  asValidDate,
  formatDateForFile,
  formatTimestamp
} from "./timeFormat.js";

export class SystemTimeService extends BaseService {
  static service = Object.freeze({
    name: "time",
    lifecycle: "singleton",
    dependencies: [],
    eager: true
  });

  constructor({ config, services, options = {} } = {}) {
    super({ config, services, options });

    this.timeZone = config?.application?.timeZone;
    this.clock = options.clock || (() => new Date());

    if (typeof this.clock !== "function") {
      throw new TypeError("Time service clock must be a function");
    }
  }

  now() {
    return asValidDate(this.clock(), "Time service clock result");
  }

  nowMs() {
    return this.now().getTime();
  }

  at(milliseconds) {
    return asValidDate(milliseconds, "Time service milliseconds");
  }

  timestamp(value = this.now()) {
    return formatTimestamp(value, this.timeZone);
  }

  fileDate(value = this.now()) {
    return formatDateForFile(value, this.timeZone);
  }
}
