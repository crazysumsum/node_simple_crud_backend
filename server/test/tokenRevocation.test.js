import assert from "node:assert/strict";
import test from "node:test";
import { AuthenticationError } from "../src/framework/auth/AuthenticationError.js";
import { JwtAuthStrategy } from "../src/services/auth/jwtAuthStrategy.js";
import { TokenRevocationService } from "../src/services/tokenRevocation/TokenRevocationService.js";
import { normalizeTokenRevocationConfig } from "../src/services/tokenRevocation/normalizeTokenRevocationConfig.js";
import { createTestTime } from "../test-support/createTestTime.js";

// JWT 是自證的：簽章對、還沒過期就有效。撤銷是唯一能在到期前作廢它的機制，
// 而它的每一個失效模式都是安靜的——快照沒更新、版本沒寫進 token、比較寫反了，
// 症狀都是「已撤銷的 token 還能用」，不會有任何錯誤浮現。

function collectingLogger() {
  const entries = [];
  const write = (level) => async (event, message, context) => {
    entries.push({ level, event, message, context });
  };

  return {
    entries,
    debug: write("debug"),
    info: write("info"),
    warn: write("warn"),
    error: write("error")
  };
}

/**
 * 只實作這個 service 真正用到的那幾句 SQL，讓判斷邏輯確實被執行到。
 * dbNowSeconds 與 time 刻意分開，才測得出時鐘偏差有沒有被量到。
 */
function fakeDatabase({ rows = [], dbNowSeconds = 1_000_000, fail = null } = {}) {
  const state = { rows: [...rows], dbNowSeconds, queries: [] };

  const run = async (sql, params = []) => {
    state.queries.push({ sql: sql.replace(/\s+/g, " ").trim(), params });

    if (fail) {
      throw fail;
    }

    if (sql.includes("UNIX_TIMESTAMP() AS db_now")) {
      return [[{ db_now: state.dbNowSeconds }]];
    }

    if (sql.includes("SELECT version FROM")) {
      const [subject] = params;
      const row = state.rows.find((candidate) => candidate.subject === subject);
      return [row ? [{ version: row.version }] : []];
    }

    if (sql.includes("SELECT subject, version")) {
      return [state.rows.map((row) => ({ ...row }))];
    }

    if (sql.includes("INSERT INTO fr_token_versions")) {
      const [subject, reason] = params;
      const existing = state.rows.find((row) => row.subject === subject);

      if (existing) {
        // version + 1 在資料庫端算，所以這裡也在「資料庫端」算。
        existing.version += 1;
        existing.reason = reason;
        existing.updated_at = state.dbNowSeconds;
      } else {
        state.rows.push({
          subject,
          version: 1,
          reason,
          updated_at: state.dbNowSeconds
        });
      }

      return [{ affectedRows: 1 }];
    }

    throw new Error(`Unexpected SQL: ${sql}`);
  };

  return { state, query: run, execute: run };
}

function createService({ database, time, logger = collectingLogger(), config } = {}) {
  // 預設讓本機時鐘與 fake 資料庫的時鐘一致。兩者不同步是一個有自己意義的情境
  // ——它正是撤銷會被繞過的原因，有專門的測試——不該當成每個測試的隱含背景，
  // 否則偏差告警在哪裡響過都沒人看得出來。
  const clock =
    time ??
    createTestTime({
      clock: () => new Date((database?.state.dbNowSeconds ?? 0) * 1000)
    });
  const service = new TokenRevocationService({
    config: { tokenRevocation: config ?? {} },
    services: {
      require: (name) =>
        ({ mysqldatabase: database, logging: { logger }, time: clock })[name]
    }
  });

  return { service, logger };
}

// --- 快照與熱路徑 ------------------------------------------------------------

test("the first load blocks startup, so no request is served before it finishes", async () => {
  const database = fakeDatabase({
    rows: [{ subject: "42", version: 5 }]
  });
  const { service } = createService({ database });

  // 建構完成但尚未 initialize：此時什麼都還不知道。
  assert.equal(service.loadedAtMs, null);
  assert.equal(service.snapshotAgeSeconds(), null);

  await service.initialize();

  assert.equal(service.snapshot.get("42"), 5);
});

test("a failed first load fails startup instead of serving an empty snapshot", async () => {
  const database = fakeDatabase({ fail: new Error("database is unreachable") });
  const { service } = createService({ database });

  // 空快照代表「沒有人被撤銷」，如果它是載入失敗的結果，那就是靜默地把所有
  // 已撤銷的 token 全部放行——而那正是撤銷最需要生效的時刻。
  await assert.rejects(() => service.initialize(), /database is unreachable/);
});

test("a token older than the current version is revoked, the current one is not", async () => {
  const database = fakeDatabase({
    rows: [{ subject: "42", version: 3 }]
  });
  const { service } = createService({ database });
  await service.initialize();

  assert.equal(service.isRevoked({ sub: "42", ver: 2 }), true);
  // 邊界：ver === 目前版本 就是最新簽的那一批，必須放行。
  assert.equal(service.isRevoked({ sub: "42", ver: 3 }), false);
  // 比目前版本還新：只可能是快照落後了一輪，那個 token 是有效的。反過來當成
  // 已撤銷的話，撤銷的那一刻剛登入的人會被自己的新 token 鎖在外面。
  assert.equal(service.isRevoked({ sub: "42", ver: 4 }), false);
  // 沒有被撤銷過的 subject 沒有列，等同版本 0。
  assert.equal(service.isRevoked({ sub: "99", ver: 0 }), false);
  // 沒有 sub 就沒有 key 可查。放行的話那個 token 對所有撤銷免疫，所以唯一
  // fail closed 的答案是當作已撤銷——與下面 ver 缺失同一條規則。
  assert.equal(service.isRevoked({ ver: 3 }), true);
  assert.equal(service.isRevoked({ sub: "", ver: 3 }), true);
  assert.equal(service.isRevoked({ sub: "   ", ver: 3 }), true);
});

test("a token without ver is treated as revoked", async () => {
  const database = fakeDatabase({
    rows: [{ subject: "42", version: 3 }]
  });
  const { service } = createService({ database });
  await service.initialize();

  // issue() 一定會帶 ver。少了它代表這個 token 是切線那一版簽的，或是拿著密鑰
  // 手工造的——放行的話它會天然免疫於所有撤銷，正是攻擊者想要的那種。
  //
  // 這也是換掉切線之後唯一的相容性斷點：部署當下所有既存 token 一起失效。
  assert.equal(service.isRevoked({ sub: "42" }), true);
  assert.equal(service.isRevoked({ sub: "42", ver: null }), true);
  assert.equal(service.isRevoked({ sub: "42", ver: "3" }), true);
  assert.equal(service.isRevoked({ sub: "42", ver: 1.5 }), true);

  // 從未撤銷過的人也一樣：沒有 ver 就是不合格的 token，跟有沒有被撤銷無關。
  assert.equal(service.isRevoked({ sub: "99" }), true);
});

// --- 撤銷寫入 ----------------------------------------------------------------

test("the first revocation takes a never-revoked subject from 0 to 1", async () => {
  const database = fakeDatabase();
  const { service } = createService({ database });
  await service.initialize();

  // 沒有列 = 版本 0，而簽發時拿到的也是 0，所以第一次撤銷就必須讓那些 token
  // 失效。DEFAULT 1 與「沒有列等於 0」這兩件事要在這裡對得起來。
  assert.equal(await service.currentVersion("42"), 0);
  assert.equal(service.isRevoked({ sub: "42", ver: 0 }), false);

  assert.equal(await service.revoke("42"), 1);
  assert.equal(service.isRevoked({ sub: "42", ver: 0 }), true);
});

test("revocation takes effect locally without waiting for the next refresh", async () => {
  const database = fakeDatabase({ rows: [{ subject: "42", version: 7 }] });
  const { service } = createService({ database });
  await service.initialize();

  await service.revoke("42", { reason: "password changed" });

  // 發起撤銷的那個實例不該還要等一輪刷新才認得自己剛寫下的東西。
  assert.equal(service.isRevoked({ sub: "42", ver: 7 }), true);
  assert.equal(service.snapshot.get("42"), 8);
});

test("the version only ever moves forward, whichever instance bumped it", async () => {
  const database = fakeDatabase({ rows: [{ subject: "42", version: 4 }] });
  const { service } = createService({ database });
  await service.initialize();

  // 另一個實例同時也撤銷了同一個人。加一是在資料庫端做的，所以兩次都算數
  // ——在應用層讀出 4 再寫 5 的話，其中一次會被另一次蓋掉。
  database.state.rows.find((row) => row.subject === "42").version = 6;
  assert.equal(await service.revoke("42"), 7);
  assert.equal(service.snapshot.get("42"), 7);

  // 本機快照領先也不該退回去：版本號只往前，領先只代表多擋掉一些本來就該擋的。
  service.snapshot.set("42", 9);
  await service.revoke("42");
  assert.equal(service.snapshot.get("42"), 9);
});

test("a clock that disagrees with the database is reported", async () => {
  const database = fakeDatabase({ dbNowSeconds: 5_000 });
  // 本機時鐘刻意超前資料庫 1000 秒，模擬未同步的機器。
  const time = createTestTime({ clock: () => new Date(6_000_000) });
  const { service, logger } = createService({ database, time });

  await service.initialize();

  // 撤銷本身已經不看時鐘了，但 token 的 iat 與 exp 還是由簽發那台機器的時鐘
  // 決定，而驗證只帶 clockToleranceSeconds 的容忍。快 1000 秒的機器簽出來的
  // token 在每一台機器上都多活 1000 秒。
  const entry = logger.entries.find(
    ({ event }) => event === "auth.revocation.clock_skew"
  );
  assert.equal(entry.level, "error");
  assert.equal(entry.context.skewSeconds, 1_000);
  assert.equal(entry.context.maxClockSkewSeconds, 60);
});

test("the recorded revocation says which version it produced", async () => {
  const database = fakeDatabase({ rows: [{ subject: "42", version: 2 }] });
  const { service, logger } = createService({ database });
  await service.initialize();

  await service.revoke("42", { reason: "password changed" });

  const entry = logger.entries.find(
    ({ event }) => event === "auth.revocation.recorded"
  );
  assert.equal(entry.context.version, 3);
  assert.equal(entry.context.subject, "42");
  assert.equal(entry.context.reason, "password changed");
});

test("revoking without a subject is rejected", async () => {
  const database = fakeDatabase();
  const { service } = createService({ database });
  await service.initialize();

  // 空字串會變成一個所有無 sub token 都對不上的幽靈列。
  await assert.rejects(() => service.revoke(""), /requires a subject/);
  await assert.rejects(() => service.revoke(null), /requires a subject/);
});

// --- 刷新失敗：fail open ------------------------------------------------------

test("a failed refresh keeps serving the old snapshot and says how stale it is", async () => {
  let nowMs = 1_000_000;
  const database = fakeDatabase({
    dbNowSeconds: nowMs / 1000,
    rows: [{ subject: "42", version: 3 }]
  });
  const time = createTestTime({ clock: () => new Date(nowMs) });
  const { service, logger } = createService({ database, time });
  await service.initialize();

  nowMs += 90_000;
  database.state.rows = [];
  const failing = fakeDatabase({ fail: new Error("database is unreachable") });
  service.database = failing;

  assert.equal(await service.refresh(), false);

  // fail open：舊快照繼續服務。反過來會讓一次資料庫抖動變成全站登出。
  assert.equal(service.isRevoked({ sub: "42", ver: 2 }), true);

  const entry = logger.entries.find(
    ({ event }) => event === "auth.revocation.refresh_failed"
  );
  assert.equal(entry.level, "error");
  // fail open 的前提是失效看得見，而唯一要回答的問題是「失效多久了」。
  assert.equal(entry.context.snapshotAgeSeconds, 90);
  assert.equal(entry.context.cachedSubjects, 1);
});

/**
 * 讓時間可以往前推的 service，用來測快照年齡相關的行為。
 */
function stalableService({ config, rows = [{ subject: "42", version: 3 }] } = {}) {
  let nowMs = 1_000_000;
  const database = fakeDatabase({ dbNowSeconds: nowMs / 1000, rows });
  const time = createTestTime({ clock: () => new Date(nowMs) });
  const { service, logger } = createService({ database, time, config });

  return {
    service,
    logger,
    database,
    advance(seconds) {
      nowMs += seconds * 1000;
    },
    breakDatabase() {
      service.database = fakeDatabase({ fail: new Error("database is unreachable") });
    }
  };
}

test("fail open is time boxed: past the cap the snapshot stops counting", async () => {
  const harness = stalableService({ config: { maxFailOpenSeconds: 300 } });
  await harness.service.initialize();
  harness.breakDatabase();

  // 上界之內：撐著服務，這是 fail open 存在的理由——一次資料庫抖動不該
  // 變成全站登出。
  harness.advance(299);
  assert.equal(await harness.service.refresh(), false);
  assert.equal(harness.service.snapshotUsable(), true);

  // 邊界：年齡剛好等於上界仍然算數。
  harness.advance(1);
  assert.equal(harness.service.snapshotUsable(), true);
  assert.equal(harness.service.snapshotAgeSeconds(), 300);

  // 越過上界：這已經不是抖動了。
  harness.advance(1);
  assert.equal(harness.service.snapshotUsable(), false);

  // 熔斷不動快照本身——切線還在，恢復之後不需要重建。
  assert.equal(harness.service.isRevoked({ sub: "42", ver: 2 }), true);
});

test("failureMode open restores the unbounded behaviour", async () => {
  const harness = stalableService({
    config: { maxFailOpenSeconds: 300, failureMode: "open" }
  });
  await harness.service.initialize();
  harness.breakDatabase();

  // 明確選擇「沒有上界」的人拿得到舊行為，八小時之後照樣放行。
  harness.advance(8 * 3600);
  assert.equal(await harness.service.refresh(), false);
  assert.equal(harness.service.snapshotAgeSeconds(), 28_800);
  assert.equal(harness.service.snapshotUsable(), true);
});

test("a snapshot that never loaded is never usable", async () => {
  // initialize() 失敗就是啟動失敗，所以正常情況下走不到這裡。但 loadedAtMs
  // 為 null 時 snapshotAgeSeconds() 回傳 null，null <= 300 在 JavaScript 裡
  // 是 true——沒有這道短路，「從未載入」會被當成「非常新鮮」。
  const { service } = createService({ database: fakeDatabase() });

  assert.equal(service.loadedAtMs, null);
  assert.equal(service.snapshotUsable(), false);
});

test("recovery is logged with how long revocation was down", async () => {
  const harness = stalableService();
  await harness.service.initialize();
  const working = harness.service.database;

  harness.breakDatabase();
  assert.equal(await harness.service.refresh(), false);

  harness.advance(420);
  harness.service.database = working;
  assert.equal(await harness.service.refresh(), true);

  // 沒有這則日誌的話，「一片 error 之後恢復」與「一片 error 之後行程死掉」
  // 在日誌上長得一模一樣。
  const entry = harness.logger.entries.find(
    ({ event }) => event === "auth.revocation.recovered"
  );
  assert.equal(entry.level, "info");
  assert.equal(entry.context.outageSeconds, 420);

  // 恢復之後不該每次成功都再記一次。
  assert.equal(await harness.service.refresh(), true);
  assert.equal(
    harness.logger.entries.filter(
      ({ event }) => event === "auth.revocation.recovered"
    ).length,
    1
  );
});

test("a first-ever successful refresh is not reported as a recovery", async () => {
  const harness = stalableService();
  await harness.service.initialize();

  assert.equal(await harness.service.refresh(), true);
  assert.equal(
    harness.logger.entries.some(
      ({ event }) => event === "auth.revocation.recovered"
    ),
    false
  );
});

test("a successful refresh picks up another instance's revocation", async () => {
  const database = fakeDatabase();
  const { service } = createService({ database });
  await service.initialize();

  assert.equal(service.isRevoked({ sub: "42", ver: 0 }), false);

  // 另一個實例寫進了資料庫。
  database.state.rows.push({ subject: "42", version: 1 });
  assert.equal(await service.refresh(), true);

  assert.equal(service.isRevoked({ sub: "42", ver: 0 }), true);
});

test("the load query caps rows at maxCachedSubjects + 1, not the whole table", async () => {
  const database = fakeDatabase({ rows: [{ subject: "42", version: 1 }] });
  const { service } = createService({ database, config: { maxCachedSubjects: 5 } });

  await service.initialize();

  const [loadQuery] = database.state.queries.filter(({ sql }) =>
    sql.includes("SELECT subject, version")
  );
  // +1 是用來分辨「剛好等於上限」與「超過上限」，不是給快照用的：真正超過
  // 預算時，這一列永遠不會被放進 Map。
  assert.match(loadQuery.sql, /LIMIT 6\b/);
});

test("a snapshot exactly at the limit still loads", async () => {
  const database = fakeDatabase({
    rows: [
      { subject: "1", version: 1 },
      { subject: "2", version: 2 }
    ]
  });
  const { service } = createService({ database, config: { maxCachedSubjects: 2 } });

  await service.initialize();

  assert.equal(service.snapshot.size, 2);
});

test("startup fails when the snapshot exceeds maxCachedSubjects", async () => {
  const database = fakeDatabase({
    rows: [
      { subject: "1", version: 1 },
      { subject: "2", version: 2 }
    ]
  });
  const { service, logger } = createService({
    database,
    config: { maxCachedSubjects: 1 }
  });

  // 截斷的快照比沒有快照更糟：界外的 subject 會靜默地免疫於撤銷。所以這是
  // 啟動失敗，跟資料庫打不通時的規則一致——啟動成功就代表狀態穩定。
  await assert.rejects(
    () => service.initialize(),
    /exceeds maxCachedSubjects \(1\)/
  );
  assert.equal(service.loadedAtMs, null);

  const entry = logger.entries.find(
    ({ event }) => event === "auth.revocation.snapshot_oversized"
  );
  assert.equal(entry.level, "error");
  assert.equal(entry.context.maxCachedSubjects, 1);
});

test("a refresh that would exceed maxCachedSubjects fails open and leaves the old snapshot untouched", async () => {
  const database = fakeDatabase({ rows: [{ subject: "42", version: 3 }] });
  const { service, logger } = createService({
    database,
    config: { maxCachedSubjects: 1 }
  });
  await service.initialize();
  const loadedAtMs = service.loadedAtMs;

  // 另一個實例的名單長過了預算——不代表這個實例已經知道的撤銷要跟著消失。
  database.state.rows.push({ subject: "43", version: 1 });

  assert.equal(await service.refresh(), false);

  // 舊快照原封不動，跟資料庫打不通時的 fail open 是同一條路徑。
  assert.equal(service.snapshot.get("42"), 3);
  assert.equal(service.loadedAtMs, loadedAtMs);
  assert.equal(service.isRevoked({ sub: "42", ver: 2 }), true);

  assert.ok(
    logger.entries.some(({ event }) => event === "auth.revocation.snapshot_oversized")
  );
  assert.ok(
    logger.entries.some(({ event }) => event === "auth.revocation.refresh_failed")
  );
});

// --- 簽發時要拿到的版本號 ----------------------------------------------------

test("currentVersion reads the database, not the snapshot", async () => {
  const database = fakeDatabase({ rows: [{ subject: "42", version: 4 }] });
  const { service } = createService({ database });
  await service.initialize();

  // 快照落後一輪：另一個實例已經撤銷過，這台還沒刷新。
  database.state.rows.find((row) => row.subject === "42").version = 5;
  assert.equal(service.snapshot.get("42"), 4);

  // 讀快照的話會簽出 ver: 4 的 token，而它在下一次刷新之後立刻被自己的實例
  // 判成已撤銷——使用者剛登入就被登出，而且沒有任何錯誤說得出為什麼。
  assert.equal(await service.currentVersion("42"), 5);
});

test("a subject that was never revoked is version 0, not a missing value", async () => {
  const database = fakeDatabase();
  const { service } = createService({ database });
  await service.initialize();

  // undefined 或 null 傳進 issue() 會被擋下來（version 必須是整數），於是
  // 「從未撤銷過的人登不進來」。0 讓它與 isRevoked() 的 ?? 0 對得起來。
  assert.equal(await service.currentVersion("nobody"), 0);
});

test("currentVersion needs a subject, for the same reason revoke does", async () => {
  const database = fakeDatabase();
  const { service } = createService({ database });
  await service.initialize();

  await assert.rejects(() => service.currentVersion(""), /requires a subject/);
  await assert.rejects(() => service.currentVersion(null), /requires a subject/);
});

test("a missing table says which SQL file creates it, even when found via currentVersion", async () => {
  // load() 有這條路徑的測試，但 currentVersion() 是第二個打這張表的入口，同一段
  // catch 邏輯換了一個呼叫路徑，缺表的錯誤訊息不能只在其中一條路上是可讀的
  // ——登入這條路遠比刷新常走，缺表時第一個看到爛錯誤訊息的地方很可能是這裡。
  const database = fakeDatabase();
  const { service } = createService({ database });
  await service.initialize();

  database.query = async () => {
    throw Object.assign(new Error("MySQL database execute failed"), {
      cause: Object.assign(new Error("Table 'erp_dev.fr_token_versions' doesn't exist"), {
        code: "ER_NO_SUCH_TABLE"
      })
    });
  };

  await assert.rejects(
    () => service.currentVersion("42"),
    /Table "fr_token_versions" does not exist\. Run server\/database\/framework\/jwt\.sql/
  );
});

// --- 設定 --------------------------------------------------------------------

test("the configuration rejects values that would silently weaken revocation", () => {
  assert.throws(
    () => normalizeTokenRevocationConfig({ maxStalenessSeconds: 0 }),
    /"maxStalenessSeconds" must be a positive integer/
  );
  assert.throws(
    () => normalizeTokenRevocationConfig({ maxCachedSubjects: -1 }),
    /"maxCachedSubjects" must be a positive integer/
  );
  assert.throws(() => normalizeTokenRevocationConfig(null), /must be an object/);

  const defaults = normalizeTokenRevocationConfig({});
  assert.equal(defaults.maxStalenessSeconds, 60);
  // 版本表永久保留，所以沒有 retentionSeconds——那個設定連同「保留期蓋不過
  // token 壽命就會讓已撤銷的 token 復活」的整個失效模式一起消失了。
  assert.equal(Object.hasOwn(defaults, "retentionSeconds"), false);
  assert.equal(defaults.maxFailOpenSeconds, 300);
  assert.equal(defaults.maxClockSkewSeconds, 60);
  // 預設熔斷，跟啟動時的立場一致：首載失敗就是啟動失敗。
  assert.equal(defaults.failureMode, "closed");
});

test("a zero clock skew allowance is legal, a negative one is not", () => {
  // 0 是一個有意義的選擇：單機部署、或 iat 也取自資料庫時鐘時，偏差保證是零，
  // 沒有理由為它付出保留期的邊界。所以它不能套 positiveInteger。
  assert.equal(
    normalizeTokenRevocationConfig({ maxClockSkewSeconds: 0 }).maxClockSkewSeconds,
    0
  );
  assert.throws(
    () => normalizeTokenRevocationConfig({ maxClockSkewSeconds: -1 }),
    /"maxClockSkewSeconds" must be a non-negative integer/
  );
  assert.throws(
    () => normalizeTokenRevocationConfig({ maxClockSkewSeconds: 1.5 }),
    /"maxClockSkewSeconds" must be a non-negative integer/
  );
});

test("a clock inside the allowance is not reported", async () => {
  const database = fakeDatabase({ dbNowSeconds: 5_000 });
  // 本機落後 59 秒，仍在 60 秒的容許範圍內。
  const time = createTestTime({ clock: () => new Date((5_000 - 59) * 1000) });
  const { service, logger } = createService({ database, time });

  await service.initialize();

  // 對時正常的機器每 30 秒記一筆 error 的話，這則日誌會在兩週內被靜音，然後
  // 真正的偏差就沒人看見。
  assert.equal(
    logger.entries.some(({ event }) => event === "auth.revocation.clock_skew"),
    false
  );
});

test("a clock behind the database is reported too", async () => {
  const database = fakeDatabase({ dbNowSeconds: 5_000 });
  // 落後的時鐘不會繞過切線，但它同樣代表機器沒有在對時——而下一次偏移可能是
  // 往另一個方向。所以報的是絕對值，不是只有偏快那一側。
  const time = createTestTime({ clock: () => new Date((5_000 - 600) * 1000) });
  const { service, logger } = createService({ database, time });

  await service.initialize();

  const entry = logger.entries.find(
    ({ event }) => event === "auth.revocation.clock_skew"
  );
  assert.equal(entry.context.skewSeconds, -600);
});

test("the fail open cap must not be tighter than the staleness guarantee", () => {
  // 上界小於 SLA 的話，快照在正常運作時就會超過它——熔斷會在資料庫完全健康
  // 的情況下觸發。那不是保護，是設定錯誤。
  assert.throws(
    () =>
      normalizeTokenRevocationConfig({
        maxStalenessSeconds: 600,
        maxFailOpenSeconds: 300
      }),
    /"maxFailOpenSeconds" \(300s\) must be at least "maxStalenessSeconds" \(600s\)/
  );

  // 相等是允許的：容忍零次刷新失敗，嚴格但自洽。
  assert.equal(
    normalizeTokenRevocationConfig({
      maxStalenessSeconds: 300,
      maxFailOpenSeconds: 300
    }).maxFailOpenSeconds,
    300
  );

  assert.throws(
    () => normalizeTokenRevocationConfig({ maxFailOpenSeconds: 0 }),
    /"maxFailOpenSeconds" must be a positive integer/
  );
});

test("the failure mode has to be one of the two modes that exist", () => {
  // 打錯字不能靜默退回某個預設——那正好是「以為熔斷開著，其實沒有」。
  assert.throws(
    () => normalizeTokenRevocationConfig({ failureMode: "fail-closed" }),
    /"failureMode" must be one of: closed, open/
  );
  assert.throws(
    () => normalizeTokenRevocationConfig({ failureMode: true }),
    /"failureMode" must be one of: closed, open/
  );

  assert.equal(
    normalizeTokenRevocationConfig({ failureMode: "open" }).failureMode,
    "open"
  );
});

// --- 認證策略的整合 ----------------------------------------------------------

function strategyWith({
  claims,
  isRevoked,
  snapshotAgeSeconds = 5,
  snapshotUsable = true,
  verify,
  requestId = "req-1"
}) {
  const logger = collectingLogger();
  const strategy = new JwtAuthStrategy({
    config: {},
    services: {
      require: (name) =>
        ({
          jwt: {
            headerName: "authorization",
            authScheme: "Bearer",
            verify: verify ?? (() => claims)
          },
          tokenRevocation: {
            isRevoked,
            snapshotAgeSeconds: () => snapshotAgeSeconds,
            snapshotUsable: () => snapshotUsable
          }
        })[name],
      get: (name) => (name === "logging" ? { logger } : undefined)
    }
  });
  const req = {
    requestId,
    get: (name) => (name === "authorization" ? "Bearer some.token.value" : undefined)
  };

  return { strategy, req, logger };
}

test("a revoked token is rejected with the same opaque code as any other failure", async () => {
  const { strategy, req, logger } = strategyWith({
    claims: { sub: "42", iat: 100, ver: 2 },
    isRevoked: () => true
  });

  await assert.rejects(
    () => strategy.authenticate(req),
    (error) => {
      assert.ok(error instanceof AuthenticationError);
      // 「已撤銷」與「簽章錯誤」對客戶端必須無法區分，否則等於confirm了
      // 這個 token 曾經是真的。
      assert.equal(error.code, "JWT_INVALID");
      assert.doesNotMatch(error.publicMessage, /revoke/i);
      return true;
    }
  );

  const entry = logger.entries.find(({ event }) => event === "auth.jwt.revoked");
  assert.equal(entry.level, "warn");
  assert.equal(entry.context.subject, "42");
  assert.equal(entry.context.issuedAt, 100);
  // 判定的依據要記下來。缺 ver 的 token 會記成 null，那是相容性斷點而不是
  // 一次真的撤銷，兩者在排查時必須分得開。
  assert.equal(entry.context.tokenVersion, 2);
  assert.equal(entry.context.snapshotAgeSeconds, 5);

  // 撤銷判定是最終結論，不該再被記成一次驗證失敗。
  assert.equal(
    logger.entries.some(({ event }) => event === "auth.jwt.rejected"),
    false
  );
});

test("an unusable snapshot rejects with 503, not 401", async () => {
  const { strategy, req, logger } = strategyWith({
    claims: { sub: "42", iat: 100 },
    isRevoked: () => false,
    snapshotUsable: false,
    snapshotAgeSeconds: 3600
  });

  await assert.rejects(
    () => strategy.authenticate(req),
    (error) => {
      // 401 是錯的答案：token 本身沒問題，是伺服器沒辦法判斷。回 401 會讓
      // 客戶端丟掉憑證去重登，把一次撤銷故障放大成一場登入風暴。
      assert.equal(error.statusCode, 503);
      assert.equal(error.code, "REVOCATION_UNAVAILABLE");
      assert.equal(error.publicCode, "SERVICE_UNAVAILABLE");
      // 而且不能是 AuthenticationError，否則 catch 會把它降級回 401。
      assert.equal(error instanceof AuthenticationError, false);
      return true;
    }
  );

  const entry = logger.entries.find(
    ({ event }) => event === "auth.revocation.circuit_open"
  );
  assert.equal(entry.level, "error");
  assert.equal(entry.context.snapshotAgeSeconds, 3600);

  // 熔斷不是一次驗證失敗，不該混進 auth.jwt.rejected 的計數裡。
  assert.equal(
    logger.entries.some(({ event }) => event === "auth.jwt.rejected"),
    false
  );
});

test("a known-revoked subject still gets 401 while the circuit is open", async () => {
  // 過期的快照仍然可能已經記著這個 subject。那時「已撤銷」是比「無法判斷」
  // 更準確的答案，而且是終局——沒有理由請對方稍後再試。
  const { strategy, req } = strategyWith({
    claims: { sub: "42", iat: 100 },
    isRevoked: () => true,
    snapshotUsable: false
  });

  await assert.rejects(
    () => strategy.authenticate(req),
    (error) => {
      assert.equal(error instanceof AuthenticationError, true);
      assert.equal(error.code, "JWT_INVALID");
      assert.equal(error.statusCode, 401);
      return true;
    }
  );
});

test("a rejection logs a null request id rather than dropping the entry", async () => {
  // requestId 由中間件掛上，但策略不能假設它一定在——內部呼叫、或中間件順序
  // 被改動時就沒有。這則日誌是「有人在偽造 token」唯一的紀錄，少了關聯 id
  // 還是要記下來，不能整筆消失或炸掉。
  const { strategy, req, logger } = strategyWith({
    claims: { sub: "42", iat: 100 },
    isRevoked: () => false,
    requestId: null,
    verify: () => {
      const error = new Error("invalid signature");
      error.name = "JsonWebTokenError";
      throw error;
    }
  });

  await assert.rejects(() => strategy.authenticate(req), (error) => {
    assert.equal(error.code, "JWT_INVALID");
    return true;
  });

  const entry = logger.entries.find(({ event }) => event === "auth.jwt.rejected");
  assert.equal(entry.context.requestId, null);
  assert.equal(entry.context.error.name, "JsonWebTokenError");
});

test("a token that is not revoked passes through untouched", async () => {
  const claims = { sub: "42", iat: 100 };
  const { strategy, req, logger } = strategyWith({
    claims,
    isRevoked: () => false
  });

  assert.deepEqual(await strategy.authenticate(req), {
    type: "jwt",
    claims
  });
  assert.deepEqual(logger.entries, []);
});
