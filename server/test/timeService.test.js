import assert from "node:assert/strict";
import test from "node:test";
import { createTestTime } from "../test-support/createTestTime.js";

test("time service formats every current timestamp and log date in application time zone", () => {
  const time = createTestTime({
    timeZone: "Asia/Hong_Kong",
    clock: () => new Date("2026-08-05T16:01:42.461Z")
  });

  assert.equal(time.nowMs(), Date.parse("2026-08-05T16:01:42.461Z"));
  assert.equal(time.timestamp(), "2026-08-06T00:01:42.461+08:00");
  assert.equal(time.fileDate(), "2026-08-06");
  assert.equal(
    time.timestamp(time.at(Date.parse("2026-08-05T10:01:42.461Z"))),
    "2026-08-05T18:01:42.461+08:00"
  );
});
