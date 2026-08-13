import assert from "node:assert/strict";
import test from "node:test";
import { AuthenticationError } from "../src/framework/auth/AuthenticationError.js";
import { JwtAuthStrategy } from "../src/services/auth/jwtAuthStrategy.js";
import { TokenRevocationService } from "../src/services/tokenRevocation/TokenRevocationService.js";
import { normalizeTokenRevocationConfig } from "../src/services/tokenRevocation/normalizeTokenRevocationConfig.js";
import { createTestTime } from "../test-support/createTestTime.js";

// JWT 是自證的：簽章對、還沒過期就有效。撤銷是唯一能在到期前作廢它的機制，
// 而它的每一個失效模式都是安靜的——快照沒更新、切線算錯一秒、清理刪早了，
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
 * dbNowSeconds 與 time 刻意分開，才測得出「切線用的是哪個時鐘」。
 */
function fakeDatabase({ rows = [], dbNowSeconds = 1_000_000, fail = null } = {}) {
  const state = { rows: [...rows], dbNowSeconds, queries: [] };

  const run = async (sql, params = []) => {
    state.queries.push({ sql: sql.replace(/\s+/g, " ").trim(), params });

    if (fail) {
      throw fail;
    }

    if (sql.includes("UNIX_TIMESTAMP() + 1 AS cutoff")) {
      return [[{ cutoff: state.dbNowSeconds + 1 }]];
    }

    if (sql.includes("SELECT subject, revoked_before")) {
      return [state.rows.map((row) => ({ ...row }))];
    }

    if (sql.includes("INSERT INTO fr_token_revocations")) {
      const [subject, revokedBefore, reason, updatedAt] = params;
      const existing = state.rows.find((row) => row.subject === subject);

      if (existing) {
        // GREATEST：切線只能往後推。
        existing.revoked_before = Math.max(existing.revoked_before, revokedBefore);
        existing.reason = reason;
        existing.updated_at = updatedAt;
      } else {
        state.rows.push({
          subject,
          revoked_before: revokedBefore,
          reason,
          updated_at: updatedAt
        });
      }

      return [{ affectedRows: 1 }];
    }

    if (sql.includes("DELETE FROM fr_token_revocations")) {
      const [retentionSeconds] = params;
      const cutoff = state.dbNowSeconds - retentionSeconds;
      const before = state.rows.length;
      state.rows = state.rows.filter((row) => row.revoked_before >= cutoff);
      return [{ affectedRows: before - state.rows.length }];
    }

    throw new Error(`Unexpected SQL: ${sql}`);
  };

  return { state, query: run, execute: run };
}

function createService({ database, time = createTestTime(), logger = collectingLogger(), config } = {}) {
  const service = new TokenRevocationService({
    config: { tokenRevocation: config ?? {} },
    services: {
      require: (name) =>
        ({ mysqldatabase: database, logging: { logger }, time })[name]
    }
  });

  return { service, logger };
}

// --- 快照與熱路徑 ------------------------------------------------------------

test("the first load blocks startup, so no request is served before it finishes", async () => {
  const database = fakeDatabase({
    rows: [{ subject: "42", revoked_before: 500 }]
  });
  const { service } = createService({ database });

  // 建構完成但尚未 initialize：此時什麼都還不知道。
  assert.equal(service.loadedAtMs, null);
  assert.equal(service.snapshotAgeSeconds(), null);

  await service.initialize();

  assert.equal(service.snapshot.get("42"), 500);
});

test("a failed first load fails startup instead of serving an empty snapshot", async () => {
  const database = fakeDatabase({ fail: new Error("database is unreachable") });
  const { service } = createService({ database });

  // 空快照代表「沒有人被撤銷」，如果它是載入失敗的結果，那就是靜默地把所有
  // 已撤銷的 token 全部放行——而那正是撤銷最需要生效的時刻。
  await assert.rejects(() => service.initialize(), /database is unreachable/);
});

test("a token issued before the cutoff is revoked, one issued after is not", async () => {
  const database = fakeDatabase({
    rows: [{ subject: "42", revoked_before: 1000 }]
  });
  const { service } = createService({ database });
  await service.initialize();

  assert.equal(service.isRevoked({ sub: "42", iat: 999 }), true);
  // 邊界：iat === 切線 代表在切線那一刻或之後簽發，仍然有效。
  assert.equal(service.isRevoked({ sub: "42", iat: 1000 }), false);
  assert.equal(service.isRevoked({ sub: "42", iat: 1001 }), false);
  // 沒有被撤銷過的 subject 完全不受影響。
  assert.equal(service.isRevoked({ sub: "99", iat: 1 }), false);
  // 沒有 sub 的 token 不屬於任何人，切線無從套用。
  assert.equal(service.isRevoked({ iat: 1 }), false);
});

test("a token without iat is treated as revoked", async () => {
  const database = fakeDatabase({
    rows: [{ subject: "42", revoked_before: 1000 }]
  });
  const { service } = createService({ database });
  await service.initialize();

  // jsonwebtoken 預設一定會帶 iat。少了它代表這個 token 是用 noTimestamp 簽的
  // 或是手工造的——放行的話它會天然免疫於所有撤銷，正是攻擊者想要的那種。
  assert.equal(service.isRevoked({ sub: "42" }), true);
  assert.equal(service.isRevoked({ sub: "42", iat: null }), true);
  assert.equal(service.isRevoked({ sub: "42", iat: "1500" }), true);
});

// --- 撤銷寫入 ----------------------------------------------------------------

test("the cutoff comes from the database clock, not the local one", async () => {
  const database = fakeDatabase({ dbNowSeconds: 5_000 });
  // 本機時鐘刻意超前資料庫 1000 秒，模擬未同步的機器。
  const time = createTestTime({ clock: () => new Date(6_000_000) });
  const { service } = createService({ database, time });
  await service.initialize();

  const cutoff = await service.revoke("42");

  // 用本機時鐘的話會是 6001，一台機器上簽發的 token 就會逃過另一台的撤銷。
  assert.equal(cutoff, 5_001);
});

test("the cutoff covers tokens issued in the same second", async () => {
  const database = fakeDatabase({ dbNowSeconds: 5_000 });
  const { service } = createService({ database });
  await service.initialize();

  await service.revoke("42");

  // iat 只有秒精度。切線若等於當下這一秒，同一秒簽發的 token 會因為
  // iat < revokedBefore 不成立而存活——所以切線必須是 now + 1。
  assert.equal(service.isRevoked({ sub: "42", iat: 5_000 }), true);
  assert.equal(service.isRevoked({ sub: "42", iat: 5_001 }), false);
});

test("revocation takes effect locally without waiting for the next refresh", async () => {
  const database = fakeDatabase({ dbNowSeconds: 5_000 });
  const { service } = createService({ database });
  await service.initialize();

  await service.revoke("42", { reason: "password changed" });

  // 發起撤銷的那個實例不該還要等一輪刷新才認得自己剛寫下的東西。
  assert.equal(service.isRevoked({ sub: "42", iat: 4_999 }), true);
});

test("a later cutoff wins and an earlier one cannot undo it", async () => {
  const database = fakeDatabase({ dbNowSeconds: 5_000 });
  const { service } = createService({ database });
  await service.initialize();

  await service.revoke("42");
  assert.equal(service.snapshot.get("42"), 5_001);

  // 另一個實例的時鐘落後，或一個遲到的請求——切線只能往後推，不能被蓋回去。
  database.state.dbNowSeconds = 3_000;
  await service.revoke("42");

  assert.equal(service.snapshot.get("42"), 5_001);
  assert.equal(
    database.state.rows.find((row) => row.subject === "42").revoked_before,
    5_001
  );
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
    rows: [{ subject: "42", revoked_before: 1000 }]
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
  assert.equal(service.isRevoked({ sub: "42", iat: 999 }), true);

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
function stalableService({ config, rows = [{ subject: "42", revoked_before: 1000 }] } = {}) {
  let nowMs = 1_000_000;
  const database = fakeDatabase({ rows });
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
  assert.equal(harness.service.isRevoked({ sub: "42", iat: 999 }), true);
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

  assert.equal(service.isRevoked({ sub: "42", iat: 1 }), false);

  // 另一個實例寫進了資料庫。
  database.state.rows.push({ subject: "42", revoked_before: 9_999 });
  assert.equal(await service.refresh(), true);

  assert.equal(service.isRevoked({ sub: "42", iat: 9_998 }), true);
});

test("an oversized snapshot warns but still loads", async () => {
  const database = fakeDatabase({
    rows: [
      { subject: "1", revoked_before: 10 },
      { subject: "2", revoked_before: 20 }
    ]
  });
  const { service, logger } = createService({
    database,
    config: { maxCachedSubjects: 1 }
  });

  await service.initialize();

  // 拒絕載入等於把一個監控問題升級成服務中斷。
  assert.equal(service.snapshot.size, 2);
  const entry = logger.entries.find(
    ({ event }) => event === "auth.revocation.snapshot_oversized"
  );
  assert.equal(entry.level, "warn");
});

// --- 清理 --------------------------------------------------------------------

test("purge removes only cutoffs older than the retention window", async () => {
  const retentionSeconds = 3600;
  const database = fakeDatabase({
    dbNowSeconds: 100_000,
    rows: [
      // 早於保留期：不可能還有活著的 token 早於它。
      { subject: "old", revoked_before: 96_000 },
      // 仍在保留期內：刪掉它會讓已撤銷的 token 復活。
      { subject: "recent", revoked_before: 99_000 }
    ]
  });
  const { service } = createService({ database, config: { retentionSeconds } });
  await service.initialize();

  assert.equal(await service.purge(), 1);
  assert.deepEqual(
    database.state.rows.map(({ subject }) => subject),
    ["recent"]
  );
});

// --- 設定 --------------------------------------------------------------------

test("the configuration rejects values that would silently weaken revocation", () => {
  assert.throws(
    () => normalizeTokenRevocationConfig({ maxStalenessSeconds: 0 }),
    /"maxStalenessSeconds" must be a positive integer/
  );
  assert.throws(
    () => normalizeTokenRevocationConfig({ retentionSeconds: -1 }),
    /"retentionSeconds" must be a positive integer/
  );
  assert.throws(() => normalizeTokenRevocationConfig(null), /must be an object/);

  const defaults = normalizeTokenRevocationConfig({});
  assert.equal(defaults.maxStalenessSeconds, 60);
  assert.equal(defaults.retentionSeconds, 604800);
  assert.equal(defaults.maxFailOpenSeconds, 300);
  // 預設熔斷，跟啟動時的立場一致：首載失敗就是啟動失敗。
  assert.equal(defaults.failureMode, "closed");
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
    claims: { sub: "42", iat: 100 },
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
