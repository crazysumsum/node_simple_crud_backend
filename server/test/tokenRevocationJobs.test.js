import assert from "node:assert/strict";
import test from "node:test";
import { discoverServiceDefinitions } from "../src/framework/services/serviceDiscovery.js";
import { TokenRevocationPurgeJob } from "../src/services/scheduler/jobs/TokenRevocationPurgeJob.js";
import { TokenRevocationRefreshJob } from "../src/services/scheduler/jobs/TokenRevocationRefreshJob.js";

// 這兩個 job 的 scope 相反，而且都不會在弄反時發出任何錯誤：
//   refresh 弄成 cluster → 只有搶到租約的那台會更新快照，其餘實例的撤銷永遠
//                          停在啟動時的狀態
//   purge   弄成 instance → 每台重複掃同一張共用表，結果正確只是白費
// 兩者都只能靠測試釘住。

function fakeScheduler() {
  const registered = [];
  return { registered, register: (instance) => registered.push(instance) };
}

function silentLogger() {
  const noop = async () => {};
  return { debug: noop, info: noop, warn: noop, error: noop };
}

function createRefreshJob({ intervalMs, maxStalenessSeconds = 60 } = {}) {
  const refreshed = [];
  const scheduler = fakeScheduler();
  const config = {
    tokenRevocation: { maxStalenessSeconds },
    scheduler: {
      jobs: intervalMs === undefined ? {} : { "tokenRevocation.refresh": { intervalMs } }
    }
  };
  const job = new TokenRevocationRefreshJob({
    config,
    services: {
      require: (name) =>
        ({
          tokenRevocation: {
            async refresh() {
              refreshed.push("refresh");
            }
          },
          scheduler,
          logging: { logger: silentLogger() }
        })[name]
    }
  });

  return { job, refreshed, scheduler };
}

function createPurgeJob() {
  const purged = [];
  const scheduler = fakeScheduler();
  const job = new TokenRevocationPurgeJob({
    config: {},
    services: {
      require: (name) =>
        ({
          tokenRevocation: {
            async purge() {
              purged.push("purge");
              return 0;
            }
          },
          scheduler
        })[name]
    }
  });

  return { job, purged, scheduler };
}

// --- scope ------------------------------------------------------------------

test("the refresh job is instance scoped, so every instance updates its own snapshot", () => {
  const [declared] = TokenRevocationRefreshJob.jobs;

  assert.equal(declared.scope, "instance");
  assert.equal(declared.name, "tokenRevocation.refresh");
});

test("the purge job is cluster scoped, so one instance cleans the shared table", () => {
  const [declared] = TokenRevocationPurgeJob.jobs;

  assert.equal(declared.scope, "cluster");
  assert.equal(declared.name, "tokenRevocation.purge");
});

// --- 交叉檢查 ----------------------------------------------------------------

test("an interval slower than the staleness guarantee fails startup", async () => {
  // 有人為了省資料庫負載把間隔調到 10 分鐘，撤銷 SLA 就從 60 秒悄悄變成 10
  // 分鐘。刷新間隔住在 scheduler 設定裡，SLA 住在 tokenRevocation 設定裡，
  // 沒有這道檢查就沒有任何地方會把兩者對起來看。
  const { job } = createRefreshJob({ intervalMs: 600_000, maxStalenessSeconds: 60 });

  await assert.rejects(
    () => job.initialize(),
    (error) => {
      assert.match(error.message, /exceeds tokenRevocation\.maxStalenessSeconds \(60s\)/);
      assert.match(error.message, /Lower the interval, or raise maxStalenessSeconds/);
      return true;
    }
  );
});

test("an interval within the guarantee registers normally", async () => {
  const { job, scheduler } = createRefreshJob({ intervalMs: 30_000 });

  await job.initialize();

  assert.deepEqual(scheduler.registered, [job]);
});

test("the interval exactly equal to the guarantee is allowed", async () => {
  // 60 秒間隔配 60 秒 SLA 剛好滿足承諾，不該被擋。
  const { job, scheduler } = createRefreshJob({
    intervalMs: 60_000,
    maxStalenessSeconds: 60
  });

  await job.initialize();

  assert.deepEqual(scheduler.registered, [job]);
});

test("the deployment override wins over the static declaration", async () => {
  const { job } = createRefreshJob({ intervalMs: 45_000 });

  // 與排程器同一套優先序，否則交叉檢查會檢查一個不會生效的數字。
  assert.equal(job.intervalMs, 45_000);

  const { job: unoverridden } = createRefreshJob();
  assert.equal(unoverridden.intervalMs, TokenRevocationRefreshJob.jobs[0].intervalMs);
});

// --- 提交與執行 --------------------------------------------------------------

test("both jobs submit themselves and their declarations resolve to real methods", async () => {
  const refresh = createRefreshJob();
  const purge = createPurgeJob();

  await refresh.job.initialize();
  await purge.job.initialize();

  assert.deepEqual(refresh.scheduler.registered, [refresh.job]);
  assert.deepEqual(purge.scheduler.registered, [purge.job]);

  // method 是字串形式的方法參照，沒有工具檢查得到它拼對沒有。
  for (const [JobClass, instance] of [
    [TokenRevocationRefreshJob, refresh.job],
    [TokenRevocationPurgeJob, purge.job]
  ]) {
    const [declared] = JobClass.jobs;
    assert.equal(typeof instance[declared.method], "function");
  }
});

test("running each job reaches the revocation service", async () => {
  const refresh = createRefreshJob();
  const purge = createPurgeJob();

  await refresh.job.run();
  await purge.job.run();

  assert.deepEqual(refresh.refreshed, ["refresh"]);
  assert.deepEqual(purge.purged, ["purge"]);
});

test("both jobs are discovered by the ordinary service mechanism", async () => {
  const definitions = await discoverServiceDefinitions();
  const names = definitions.map(({ name }) => name);

  assert.ok(names.includes("job.tokenRevocationRefresh"));
  assert.ok(names.includes("job.tokenRevocationPurge"));

  // 排程器依賴刻意隔離在葉子裡。掛在 TokenRevocationService 身上的話，停用
  // 排程器會讓撤銷 service 建構失敗，進而讓 auth.jwt 起不來——用「關掉排程器」
  // 換到「整個 JWT 認證消失」。
  const revocation = definitions.find(({ name }) => name === "tokenRevocation");
  assert.equal(revocation.dependencies.includes("scheduler"), false);
});

// --- 停用 --------------------------------------------------------------------

test("disabling the revocation service fails startup because auth.jwt requires it", async () => {
  const { ServiceContainer } = await import(
    "../src/framework/services/ServiceContainer.js"
  );
  const definitions = await discoverServiceDefinitions({
    moduleLoader: async (url) => {
      const module = await import(url);
      const patched = {};

      for (const [exportName, value] of Object.entries(module)) {
        patched[exportName] =
          typeof value === "function" &&
          Object.hasOwn(value, "service") &&
          value.name === "TokenRevocationService"
            ? class extends value {
                static service = Object.freeze({ ...value.service, enabled: false });
              }
            : value;
      }

      return patched;
    }
  });

  // 統一規則：依賴的 service 不存在就啟動報錯。代價要說清楚——撤銷從此是強制
  // 的，JWT 認證從此需要 MySQL。想要「有 JWT 但不要撤銷」就得連 auth.jwt 一起
  // 停用，那已經是另一種部署。
  assert.throws(
    () => new ServiceContainer({ definitions }),
    (error) => {
      assert.match(error.message, /^Service "auth\.jwt" requires "tokenRevocation"/);
      assert.match(error.message, /disabled by its static service\.enabled flag/);
      return true;
    }
  );
});
