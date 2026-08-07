import { SystemTimeService } from "../src/services/time/SystemTimeService.js";

export function createTestTime({
  timeZone = "Asia/Hong_Kong",
  clock = () => new Date("2026-08-07T06:00:00.000Z")
} = {}) {
  return new SystemTimeService({
    config: { application: { timeZone } },
    services: {},
    options: { clock }
  });
}

export function servicesWithTime(time) {
  return {
    require(name) {
      if (name === "time") {
        return time;
      }

      throw new Error(`Unexpected test service: ${name}`);
    }
  };
}
