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

// 撤銷的兩個前提跨了三個設定檔，而且每一邊單獨看都合法：
//
//   token 壽命（config/jwt.js）        <= 切線保留期（config/tokenRevocation.js）
//   刷新工作是開著的（config/scheduler.js）
//
// 破壞任何一邊都沒有執行期症狀——第一個的症狀是已撤銷的 token 在幾週後重新
// 有效，第二個是幾分鐘後整站 503 或撤銷從此不生效。兩者都只能擋在啟動。

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

// --- 保留期 vs token 壽命 -----------------------------------------------------

test("the shipped defaults satisfy both preconditions", () => {
  // 2h 的 token 配 7 天的保留期，刷新工作預設開著。出廠設定必須自己過關，否則
  // 這兩條檢查會在第一天就被當成噪音關掉。
  const configuration = validateApplicationConfiguration(defaultConfigurationSource());

  assert.equal(configuration.jwt.expiresInSeconds, 7200);
  assert.equal(configuration.tokenRevocation.retentionSeconds, 604_800);
});

test("a token lifetime longer than the retention window fails startup", () => {
  // 實測過的那個組合：JWT_EXPIRES_IN=30d 加出廠的 7 天保留期，啟動成功，然後
  // 清理刪掉切線，被撤銷而尚未過期的 token 重新有效 23 天。
  const detail = detailFor(sourceWith({ jwt: { expiresIn: "30d" } }), "tokenRevocation");

  assert.match(detail.message, /"retentionSeconds" \(604800s\)/);
  // 訊息要同時說出兩邊的值，否則看到錯誤的人還要自己去翻另一個設定檔。
  assert.match(detail.message, /jwt\.expiresIn \(30d = 2592000s\)/);
  assert.match(detail.message, /revoked tokens become valid again/);
});

test("the margin covers the clock tolerance and the clock skew, not just the lifetime", () => {
  // 邊界剛好：保留期 = 壽命 + clockTolerance + maxClockSkew。
  const exact = sourceWith({
    jwt: { expiresIn: "1d", clockToleranceSeconds: 5 },
    tokenRevocation: { maxClockSkewSeconds: 60, retentionSeconds: 86_400 + 65 }
  });

  assert.equal(detailFor(exact, "tokenRevocation"), null);

  // 少一秒就不行。iat 與切線來自不同時鐘，卡在邊緣的那一批正是會復活的那一批。
  const short = sourceWith({
    jwt: { expiresIn: "1d", clockToleranceSeconds: 5 },
    tokenRevocation: { maxClockSkewSeconds: 60, retentionSeconds: 86_400 + 64 }
  });

  assert.match(detailFor(short, "tokenRevocation").message, /= 86465s/);
});

test("expiresIn is rejected before it can be compared against anything", () => {
  // 純數字對 jsonwebtoken 是毫秒：JWT_EXPIRES_IN=3600 會簽出 3 秒壽命的 token。
  // 這一條擋在 jwt 那一節，所以跨檔檢查根本不會拿到一個假的秒數去比。
  const detail = detailFor(sourceWith({ jwt: { expiresIn: "3600" } }), "jwt");

  assert.match(detail.message, /must be a whole number with a unit of s, m, h, d or w/);
  assert.match(detail.message, /milliseconds to jsonwebtoken, not seconds/);
});

// --- 刷新工作 ----------------------------------------------------------------

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
