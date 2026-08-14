import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultConfigurationSource,
  validateApplicationConfiguration
} from "../src/framework/configuration/applicationConfiguration.js";
import { ConfigurationError } from "../src/framework/configuration/ConfigurationError.js";
import {
  JOB_NAME,
  TokenRevocationRefreshJob
} from "../src/services/tokenRevocation/jobs/TokenRevocationRefreshJob.js";

// 撤銷的前提：刷新工作（config/scheduler.js）必須是開著的，否則快照永遠停在
// 啟動時的狀態。這件事沒有執行期症狀——啟動成功，然後幾分鐘後整站 503，或者
// 撤銷從此靜默地不生效——所以只能擋在啟動。
//
// 曾經還有第二條前提：切線的保留期必須蓋過 token 壽命，否則清理刪掉列時已撤銷
// 的 token 會復活。改用版本號之後那條關係整個消失了——版本表永久保留，連清理
// 工作都沒有。

function sourceWith(overrides) {
  const source = defaultConfigurationSource();

  return {
    ...source,
    ...Object.fromEntries(
      Object.entries(overrides).map(([section, values]) => [
        section,
        { ...source[section], ...values }
      ])
    )
  };
}

function detailFor(source, section) {
  try {
    validateApplicationConfiguration(source);
  } catch (error) {
    assert.ok(error instanceof ConfigurationError, `not a ConfigurationError: ${error.message}`);
    return error.details.find((detail) => detail.section === section);
  }

  return null;
}

test("the shipped defaults pass their own check", () => {
  // 出廠設定必須自己過關，否則這條檢查會在第一天就被當成噪音關掉。
  const configuration = validateApplicationConfiguration(defaultConfigurationSource());

  assert.equal(configuration.scheduler.enabled, true);
  assert.equal(configuration.jwt.expiresIn, "2h");
  // 版本表永久保留，所以這裡沒有保留期可以配錯。
  assert.equal(Object.hasOwn(configuration.tokenRevocation, "retentionSeconds"), false);
});

test("expiresIn must be a duration anyone can read the same way", () => {
  // 純數字對 jsonwebtoken 是毫秒：JWT_EXPIRES_IN=3600 會簽出 3 秒壽命的 token，
  // 而 banana 會通過全部啟動驗證，等到第一次有人登入才爆。
  const detail = detailFor(sourceWith({ jwt: { expiresIn: "3600" } }), "jwt");

  assert.match(detail.message, /must be a whole number with a unit of s, m, h, d or w/);
  assert.match(detail.message, /milliseconds to jsonwebtoken, not seconds/);
});

test("the cross-check names the job the scheduler actually registers", () => {
  // 檢查用的是匯出的常數而不是自己寫一遍字串。兩邊的字面值一旦分岔，檢查會
  // 靜默地永遠通過——這正是它要防的那種錯誤自己的翻版。
  assert.equal(TokenRevocationRefreshJob.jobs[0].name, JOB_NAME);
});

test("turning the scheduler off fails startup instead of 503-ing five minutes later", () => {
  const detail = detailFor(sourceWith({ scheduler: { enabled: false } }), "scheduler");

  assert.match(detail.message, new RegExp(`Job "${JOB_NAME}" is disabled`));
  assert.match(detail.message, /every JWT request\s+answers 503/);
});

test("disabling just the refresh job is caught too", () => {
  const source = sourceWith({
    scheduler: { jobs: { [JOB_NAME]: { enabled: false } } }
  });

  assert.match(detailFor(source, "scheduler").message, /is disabled/);
});

test("failureMode open does not excuse a missing refresher", () => {
  // "open" 換掉的是熔斷，不是刷新。沒有人刷新時它的症狀更安靜：撤銷從啟動那
  // 一刻起永遠不再生效，而且沒有 503 會讓任何人發現。
  const source = sourceWith({
    scheduler: { enabled: false },
    tokenRevocation: { failureMode: "open" }
  });

  assert.match(detailFor(source, "scheduler").message, /silently stops applying/);
});

test("an explicit enabled:true override still passes", () => {
  const source = sourceWith({
    scheduler: { jobs: { [JOB_NAME]: { enabled: true, intervalMs: 5000 } } }
  });

  assert.equal(detailFor(source, "scheduler"), null);
});
