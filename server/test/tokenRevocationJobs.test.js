import assert from "node:assert/strict";
import test from "node:test";
import { discoverServiceDefinitions } from "../src/framework/services/serviceDiscovery.js";
import { TokenRevocationRefreshJob } from "../src/services/tokenRevocation/jobs/TokenRevocationRefreshJob.js";

// refresh 弄成 cluster 不會發出任何錯誤：只有搶到租約的那台會更新快照，其餘
// 實例的撤銷永遠停在啟動時的狀態，而對排程器而言工作確實跑成功了。只能靠測試
// 釘住。
//
// 曾經還有一個 cluster scope 的 purge job，負責刪掉早已無意義的時間切線。版本
// 表永久保留（一個使用者一列，不隨撤銷次數增長），所以那件工作連同它的保留期
// 設定一起消失了。

function fakeScheduler() {
  const registered = [];
  return { registered, register: (instance) => registered.push(instance) };
}

function silentLogger() {
  const noop = async () => {};
  return { debug: noop, info: noop, warn: noop, error: noop };
}

function createRefreshJob({
  intervalMs,
  maxStalenessSeconds = 60,
  refreshResult = true
} = {}) {
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
              return refreshResult;
            }
          },
          scheduler,
          logging: { logger: silentLogger() }
        })[name]
    }
  });

  return { job, refreshed, scheduler };
}

// --- scope ------------------------------------------------------------------

test("the refresh job is instance scoped, so every instance updates its own snapshot", () => {
  const [declared] = TokenRevocationRefreshJob.jobs;

  assert.equal(declared.scope, "instance");
  assert.equal(declared.name, "tokenRevocation.refresh");
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

test("the job submits itself and its declaration resolves to a real method", async () => {
  const refresh = createRefreshJob();

  await refresh.job.initialize();

  assert.deepEqual(refresh.scheduler.registered, [refresh.job]);

  // method 是字串形式的方法參照，沒有工具檢查得到它拼對沒有。
  const [declared] = TokenRevocationRefreshJob.jobs;
  assert.equal(typeof refresh.job[declared.method], "function");
});

test("running the job reaches the revocation service", async () => {
  const refresh = createRefreshJob();

  await refresh.job.run();

  assert.deepEqual(refresh.refreshed, ["refresh"]);
});

test("a refresh that fails open still fails the job", async () => {
  // refresh() 刻意吞掉例外——快照失效時繼續服務是設計。但排程器必須知道，
  // 否則 fr_scheduler_stats 上的 lastOutcome 會一路 succeeded，撤銷死了幾個
  // 小時而那張專門為了看見工作異常而建的表看不見它。
  const { job, refreshed } = createRefreshJob({ refreshResult: false });

  await assert.rejects(
    () => job.run(),
    /Token revocation snapshot refresh failed/
  );

  // 而且要真的試過才失敗，不是繞過刷新直接報錯。
  assert.deepEqual(refreshed, ["refresh"]);
});

test("the job is discovered by the ordinary service mechanism", async () => {
  const definitions = await discoverServiceDefinitions();
  const names = definitions.map(({ name }) => name);

  assert.ok(names.includes("job.tokenRevocationRefresh"));

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
