import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultConfigurationSource,
  validateApplicationConfiguration
} from "../src/framework/configuration/applicationConfiguration.js";
import { ConfigurationError } from "../src/framework/configuration/ConfigurationError.js";
import { MySqlDatabaseService } from "../src/services/mysqldatabase/MySqlDatabaseService.js";
import { RequestContextService } from "../src/services/context/RequestContextService.js";
import { createTestTime, servicesWithTime } from "../test-support/createTestTime.js";

// 交易的期限先前只蓋到 work 為止：clearTimeout 排在 commit 之前，連 route 的
// signal 都一併解除。於是一個永不回應的 COMMIT 沒有任何東西中斷得了——實測
// timeoutMs=10 的交易在 50ms 後仍未結束，finally 跑不到，連線既沒還也沒毀，
// 直接從池子裡消失，累積到 connectionLimit 條整個池子就死了。
//
// COMMIT 還有一件別的階段沒有的事：它逾時的時候，交易到底成不成功是不知道的。

const config = { queryTimeoutMs: 2500, transactionTimeoutMs: 50 };
const never = () => new Promise(() => {});

function collectingLogger() {
  const entries = [];
  const record = (level) => async (event, message, context) => {
    entries.push({ level, event, message, context });
  };

  return {
    entries,
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error")
  };
}

function fakeConnection(overrides = {}) {
  const calls = [];
  const connection = {
    calls,
    query: async () => {
      calls.push("query");
      return [[], []];
    },
    execute: async () => {
      calls.push("execute");
      return [{ affectedRows: 1 }];
    },
    beginTransaction: async () => calls.push("begin"),
    commit: async () => calls.push("commit"),
    rollback: async () => calls.push("rollback"),
    destroy: () => calls.push("destroy"),
    release: () => calls.push("release"),
    ...overrides
  };
  return connection;
}

function createDatabase(connection, overrides = {}) {
  const logger = collectingLogger();
  return {
    logger,
    database: new MySqlDatabaseService({
      pool: {
        query: async () => [[{ ok: 1 }]],
        getConnection: async () => connection,
        end: async () => {}
      },
      config: { ...config, ...overrides },
      logger,
      context: new RequestContextService({
        services: servicesWithTime(createTestTime())
      })
    })
  };
}

/** 呼叫端只等這麼久。期限沒蓋到的話，promise 會停在這裡不 settle。 */
function withinDeadline(promise, ms = 400) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error("交易在期限後仍未 settle")), ms);
    })
  ]);
}

// --- 期限涵蓋整段 ----------------------------------------------------------------

test("a COMMIT that never answers is cut off by the deadline", async () => {
  const connection = fakeConnection({
    commit: async () => {
      connection.calls.push("commit");
      return never();
    }
  });
  const { database } = createDatabase(connection);

  await assert.rejects(
    () => withinDeadline(database.withTransaction(async () => "done")),
    (error) => error.code === "DATABASE_TRANSACTION_INDETERMINATE"
  );

  assert.deepEqual(connection.calls, ["query", "begin", "commit", "destroy"]);
});

test("a ROLLBACK that never answers is cut off too", async () => {
  // 這一條容易看漏：abort 有觸發、連線也被 destroy 了，但 await rollback() 沒有
  // 被 race，promise 還是永遠不會 settle。既有的 abort 機制收得回連線，收不回
  // 控制流。
  const connection = fakeConnection({
    rollback: async () => {
      connection.calls.push("rollback");
      return never();
    }
  });
  const { database } = createDatabase(connection);

  await assert.rejects(
    () =>
      withinDeadline(
        database.withTransaction(async () => {
          throw new Error("business failure");
        })
      ),
    (error) => error.code === "DATABASE_TRANSACTION_FAILED"
  );

  assert.equal(connection.calls.includes("release"), false);
});

test("a BEGIN that never answers is cut off as well", async () => {
  const connection = fakeConnection({
    beginTransaction: async () => {
      connection.calls.push("begin");
      return never();
    }
  });
  const { database } = createDatabase(connection);

  await assert.rejects(
    () => withinDeadline(database.withTransaction(async () => "done")),
    (error) => error.code === "DATABASE_TRANSACTION_TIMEOUT"
  );
});

test("a commit inside the deadline is untouched", async () => {
  const connection = fakeConnection();
  const { database } = createDatabase(connection, { transactionTimeoutMs: 500 });

  assert.equal(await database.withTransaction(async () => "ok"), "ok");
  assert.deepEqual(connection.calls, ["query", "begin", "commit", "release"]);
});

// --- 不確定 ---------------------------------------------------------------------

test("an indeterminate commit is a different error from a clean timeout", async () => {
  // work 階段逾時代表交易確定沒有提交，呼叫端可以直接重試。COMMIT 逾時的結果
  // 是未知的，盲目重試就是重複執行。兩者共用一個 code 的話，這個區別就消失了。
  const stuckCommit = fakeConnection({
    commit: async () => {
      stuckCommit.calls.push("commit");
      return never();
    }
  });
  const stuckWork = fakeConnection();

  const commitError = await withinDeadline(
    createDatabase(stuckCommit).database.withTransaction(async () => "x").catch((e) => e)
  );
  const workError = await withinDeadline(
    createDatabase(stuckWork).database.withTransaction(never).catch((e) => e)
  );

  assert.equal(commitError.code, "DATABASE_TRANSACTION_INDETERMINATE");
  assert.equal(workError.code, "DATABASE_TRANSACTION_TIMEOUT");
  // 對外都是一般的 500。不確定性是講給日誌與呼叫端聽的，不是講給客戶端聽的。
  assert.equal(commitError.statusCode, 500);
  assert.equal(commitError.publicCode, "INTERNAL_SERVER_ERROR");
});

test("an indeterminate commit is reported with what a human needs to reconcile", async () => {
  const connection = fakeConnection({
    commit: async () => {
      connection.calls.push("commit");
      return never();
    }
  });
  const { database, logger } = createDatabase(connection);

  await withinDeadline(
    database.withTransaction(async () => "x", { isolationLevel: "SERIALIZABLE" }).catch(() => {})
  );

  const reported = logger.entries.find(
    (entry) => entry.event === "database.transaction.indeterminate"
  );
  assert.equal(reported.level, "error");
  assert.equal(reported.context.isolationLevel, "SERIALIZABLE");
  assert.equal(reported.context.timedOut, true);
  assert.equal(reported.context.transactionTimeoutMs, 50);
  assert.match(reported.context.note, /Do not retry blindly/);
});

test("a connection lost during COMMIT is indeterminate even without a timeout", async () => {
  // 期限沒到，但話沒送到或回應沒收到——結果一樣是不知道。
  const connection = fakeConnection({
    commit: async () => {
      connection.calls.push("commit");
      const error = new Error("Connection lost: The server closed the connection.");
      error.code = "PROTOCOL_CONNECTION_LOST";
      throw error;
    }
  });
  const { database } = createDatabase(connection, { transactionTimeoutMs: 5000 });

  await assert.rejects(
    () => withinDeadline(database.withTransaction(async () => "x")),
    (error) => error.code === "DATABASE_TRANSACTION_INDETERMINATE"
  );

  assert.deepEqual(connection.calls, ["query", "begin", "commit", "destroy"]);
});

test("a commit the server refuses outright is determinate, not indeterminate", async () => {
  // 伺服器說了「沒有」，交易一定沒有提交。把這種也報成「狀態未知」的話，喊狼
  // 喊多了，真正需要人工對帳的那一筆就沒有人看了。
  const connection = fakeConnection({
    commit: async () => {
      connection.calls.push("commit");
      const error = new Error("Deadlock found when trying to get lock");
      error.code = "ER_LOCK_DEADLOCK";
      throw error;
    }
  });
  const { database, logger } = createDatabase(connection, { transactionTimeoutMs: 5000 });

  await assert.rejects(
    () => withinDeadline(database.withTransaction(async () => "x")),
    (error) => error.code === "DATABASE_TRANSACTION_FAILED"
  );

  assert.equal(
    logger.entries.some((entry) => entry.event === "database.transaction.indeterminate"),
    false
  );
});

// --- COMMIT 之後不再 rollback ------------------------------------------------------

test("a failed COMMIT is not chased by a ROLLBACK", async () => {
  // COMMIT 送出去之後伺服器可能已經提交了。在一條剛剛 commit 失敗的連線上再送
  // rollback，好一點是 no-op，差一點是第二次卡死。
  const connection = fakeConnection({
    commit: async () => {
      connection.calls.push("commit");
      throw new Error("commit refused");
    },
    rollback: async () => {
      connection.calls.push("rollback");
      return never();
    }
  });
  const { database } = createDatabase(connection, { transactionTimeoutMs: 5000 });

  await assert.rejects(
    () => withinDeadline(database.withTransaction(async () => "x")),
    (error) => error.code === "DATABASE_TRANSACTION_FAILED"
  );

  assert.equal(connection.calls.includes("rollback"), false);
});

test("no failed transaction ever puts its connection back in the pool", async () => {
  // mysql2 的 release 預設不重設 session。猜錯的話就是把一個還開著的交易交給
  // 下一個使用者——那是正確性問題，沒有「可以接受的較慢版本」。
  const shapes = {
    "COMMIT 卡住": {
      commit: async function stuck() {
        return never();
      }
    },
    "COMMIT 被拒": {
      commit: async () => {
        throw new Error("commit refused");
      }
    },
    "COMMIT 連線斷掉": {
      commit: async () => {
        const error = new Error("lost");
        error.code = "ECONNRESET";
        throw error;
      }
    }
  };

  for (const [label, overrides] of Object.entries(shapes)) {
    const connection = fakeConnection(overrides);
    const { database } = createDatabase(connection);

    await withinDeadline(database.withTransaction(async () => "x").catch(() => {}));

    assert.equal(connection.calls.includes("release"), false, label);
    assert.equal(connection.calls.includes("destroy"), true, label);
  }
});

test("an operation discarded by an already-aborted signal does not crash the process", async () => {
  // signal 在 raceWithSignal 進來之前就已經 aborted 時，它直接拋出——但 operation
  // 是引數，早就被呼叫了，於是沒有人接它。而 abort 的處理是把連線 destroy 掉，
  // 那正好會讓它 reject：unhandledRejection，整個行程被殺掉。為了修一個卡住而
  // 做出一次崩潰。
  //
  // 這裡讓 work 自己觸發 parent abort：回到 withTransaction 時 signal 已經是
  // aborted 的，接著 rollback() 被呼叫、被丟掉，然後 reject。
  //
  // 連線刻意不提供 destroy——有 destroy 的話 abort 會先把它毀掉，rollback 那一段
  // 就整個跳過了，這條路反而走不到。
  const parent = new AbortController();
  const connection = fakeConnection({
    destroy: undefined,
    rollback: () => {
      connection.calls.push("rollback");
      return Promise.reject(new Error("Connection is closed"));
    }
  });
  delete connection.destroy;
  const { database } = createDatabase(connection, { transactionTimeoutMs: 5000 });
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);

  try {
    await assert.rejects(
      () =>
        withinDeadline(
          database.withTransaction(
            async () => {
              parent.abort(new Error("route timed out"));
              return "x";
            },
            { signal: parent.signal }
          )
        )
    );
    // unhandledRejection 要等 microtask 清空之後才報。
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }

  assert.deepEqual(unhandled, []);
});

// --- 設定 ----------------------------------------------------------------------

test("a transaction budget longer than the request budget fails startup", () => {
  // #38 加的那條檢查看的是 acquireTimeoutMs + queryTimeoutMs，完全蓋不到交易——
  // 交易走自己的 transactionTimeoutMs。出廠設定曾經是 5000 + 30000 > 30000。
  const source = defaultConfigurationSource();

  assert.throws(
    () =>
      validateApplicationConfiguration({
        ...source,
        database: { ...source.database, transactionTimeoutMs: 30000 }
      }),
    (error) =>
      error instanceof ConfigurationError &&
      /"transactionTimeoutMs" \(30000ms\) must be shorter than application\.requestTimeoutMs/.test(
        error.message
      )
  );
});

test("the check counts the wait for a connection, not just the transaction", () => {
  // 借連線的時間也在 route 的預算裡。漏掉它的話，一個「自己看起來還好」的
  // transactionTimeoutMs 加上等待就超過了，而檢查放它過關。
  const source = defaultConfigurationSource();
  const budget = {
    ...source.database,
    acquireTimeoutMs: 5000,
    transactionTimeoutMs: 28000
  };

  // 28000 自己小於 30000，只有加上 acquire 才超過。
  assert.throws(
    () => validateApplicationConfiguration({ ...source, database: budget }),
    /"acquireTimeoutMs" \(5000ms\) plus "transactionTimeoutMs" \(28000ms\)/
  );
});

test("a budget that exactly fills the request timeout is refused", () => {
  // 剛好用完等於沒有餘裕：route 逾時與交易逾時同時到，誰先誰後看排程。
  const source = defaultConfigurationSource();

  assert.throws(
    () =>
      validateApplicationConfiguration({
        ...source,
        database: { ...source.database, acquireTimeoutMs: 5000, transactionTimeoutMs: 25000 }
      }),
    /must be shorter than application\.requestTimeoutMs/
  );

  // 少一毫秒就可以。
  assert.doesNotThrow(() =>
    validateApplicationConfiguration({
      ...source,
      database: { ...source.database, acquireTimeoutMs: 5000, transactionTimeoutMs: 24999 }
    })
  );
});

test("the shipped defaults leave the transaction inside the request budget", () => {
  const configuration = validateApplicationConfiguration(defaultConfigurationSource());
  const { database, application } = configuration;

  assert.ok(
    database.acquireTimeoutMs + database.transactionTimeoutMs <
      application.requestTimeoutMs,
    `${database.acquireTimeoutMs} + ${database.transactionTimeoutMs} 不小於 ${application.requestTimeoutMs}`
  );
});
