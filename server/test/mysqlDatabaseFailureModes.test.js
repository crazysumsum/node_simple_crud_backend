import assert from "node:assert/strict";
import test from "node:test";
import { ApplicationError } from "../src/framework/errors/ApplicationError.js";
import {
  MySqlDatabaseOperationError,
  MySqlDatabaseService
} from "../src/services/mysqldatabase/MySqlDatabaseService.js";
import { RequestContextService } from "../src/services/context/RequestContextService.js";
import { createTestTime, servicesWithTime } from "../test-support/createTestTime.js";

// 這一組測的全是降級行為：連線斷掉、交易被取消、rollback 也失敗。這些路徑只在
// 正式環境、最糟的時刻才會跑到，所以只能靠測試把它們釘住。

const config = { queryTimeoutMs: 2500, transactionTimeoutMs: 5000 };

function createContext() {
  return new RequestContextService({ services: servicesWithTime(createTestTime()) });
}

function collectingLogger() {
  const entries = [];
  const record = (level) => async (event, message, context) => {
    entries.push({ level, event, message, context });
  };

  return { entries, debug: record("debug"), error: record("error"), info: record("info") };
}

/** 記錄每一次呼叫的假連線，測試靠呼叫順序來斷言生命週期。 */
function fakeConnection(overrides = {}) {
  const calls = [];
  const connection = {
    calls,
    query: async (...args) => {
      calls.push(["query", ...args]);
      return [[], []];
    },
    execute: async () => {
      calls.push(["execute"]);
      return [{ affectedRows: 1 }];
    },
    beginTransaction: async () => calls.push(["begin"]),
    commit: async () => calls.push(["commit"]),
    rollback: async () => calls.push(["rollback"]),
    destroy: () => calls.push(["destroy"]),
    release: () => calls.push(["release"]),
    ...overrides
  };
  return connection;
}

function createDatabase(connection, logger = collectingLogger()) {
  const pool = {
    query: async () => [[{ ok: 1 }]],
    getConnection: async () => connection,
    end: async () => {}
  };
  return {
    logger,
    database: new MySqlDatabaseService({
      pool,
      config,
      logger,
      context: createContext()
    })
  };
}

const names = (connection) => connection.calls.map(([name]) => name);

// --- 第一層：錯了會靜默且嚴重 ------------------------------------------------

test("an unsupported isolation level is rejected before any SQL is issued", async () => {
  const connection = fakeConnection();
  const { database } = createDatabase(connection);
  let workRan = false;

  // isolationLevel 是全系統唯一一個被直接拼進 SQL 字串的值：
  //   connection.query(`SET TRANSACTION ISOLATION LEVEL ${normalizedIsolation}`)
  // 白名單比對是它唯一的防線。少了這個測試，重構時刪掉那個 has() 檢查不會有
  // 任何測試變紅。
  for (const level of [
    "READ COMMITTED; DROP TABLE orders",
    "SERIALIZABLE--",
    "'; SELECT 1; --",
    "REPEATABLE",
    "",
    "read commited"
  ]) {
    await assert.rejects(
      () =>
        database.withTransaction(
          () => {
            workRan = true;
          },
          { isolationLevel: level }
        ),
      (error) => {
        assert.ok(error instanceof TypeError);
        assert.match(error.message, /Unsupported transaction isolation level/);
        return true;
      },
      `isolation level 應被拒絕：${level}`
    );
  }

  assert.equal(workRan, false);
  // 連線都不該被取得，更不用說發出 SQL。
  assert.deepEqual(connection.calls, []);
});

test("the four standard isolation levels are accepted and interpolated verbatim", async () => {
  for (const level of [
    "READ UNCOMMITTED",
    "READ COMMITTED",
    "REPEATABLE READ",
    "SERIALIZABLE"
  ]) {
    const connection = fakeConnection();
    const { database } = createDatabase(connection);

    await database.withTransaction(() => "ok", { isolationLevel: level.toLowerCase() });

    assert.equal(
      connection.calls[0][1],
      `SET TRANSACTION ISOLATION LEVEL ${level}`,
      `${level} 應被接受並以大寫拼入`
    );
  }
});

test("a connection destroyed on abort is never released back to the pool", async () => {
  const connection = fakeConnection({
    execute: async () => {
      // 永不完成的工作，讓交易只能靠中止收場。
      return new Promise(() => {});
    }
  });
  const { database } = createDatabase(connection);
  const controller = new AbortController();

  const pending = database.withTransaction(
    (transaction) => transaction.execute("INSERT INTO orders (name) VALUES (?)", ["x"]),
    { signal: controller.signal }
  );
  await new Promise((resolve) => { setImmediate(resolve); });
  controller.abort(new Error("client disconnected"));

  await assert.rejects(pending);

  // 重複 release 會把一條已經銷毀的連線還進池子，之後每一個拿到它的請求都會壞。
  assert.equal(names(connection).includes("destroy"), true);
  assert.equal(names(connection).includes("release"), false);
});

test("a destroy that itself fails is logged rather than swallowed", async () => {
  const connection = fakeConnection({
    execute: async () => new Promise(() => {}),
    destroy: () => {
      throw new Error("socket already gone");
    }
  });
  const { database, logger } = createDatabase(connection);
  const controller = new AbortController();

  const pending = database.withTransaction(
    (transaction) => transaction.execute("INSERT INTO orders (name) VALUES (?)", ["x"]),
    { signal: controller.signal }
  );
  await new Promise((resolve) => { setImmediate(resolve); });
  controller.abort(new Error("client disconnected"));
  await assert.rejects(pending);

  const entry = logger.entries.find(
    (candidate) => candidate.event === "database.transaction.destroy_failed"
  );
  assert.ok(entry, "銷毀失敗必須留下記錄");
  assert.equal(entry.level, "error");
  assert.equal(entry.context.error.message, "socket already gone");
  // 銷毀失敗代表連線狀態不明，此時仍要走 release 把它交還池子處理。
  assert.equal(names(connection).includes("release"), true);
});

// --- 第二層：客戶端會看到、但目前沒驗證的行為 ---------------------------------

test("a transaction whose parent request is already aborted never begins", async () => {
  const connection = fakeConnection();
  const { database } = createDatabase(connection);
  const controller = new AbortController();
  controller.abort(new Error("request cancelled"));

  await assert.rejects(
    () => database.withTransaction(() => "never", { signal: controller.signal }),
    (error) => {
      assert.ok(error instanceof MySqlDatabaseOperationError);
      return true;
    }
  );

  // 連 SET TRANSACTION 都不該發出去。
  assert.equal(names(connection).includes("begin"), false);
  assert.equal(names(connection).includes("query"), false);
});

test("a rollback failure is logged and the original error still surfaces", async () => {
  const connection = fakeConnection({
    execute: async () => {
      throw new Error("write failed");
    },
    rollback: async () => {
      throw new Error("rollback also failed");
    }
  });
  const { database, logger } = createDatabase(connection);

  await assert.rejects(
    () =>
      database.withTransaction((transaction) =>
        transaction.execute("INSERT INTO orders (name) VALUES (?)", ["x"])
      ),
    // rollback 失敗不得掩蓋原本的錯誤——那才是開發者要看到的。
    (error) => {
      assert.equal(error.code, "DATABASE_OPERATION_FAILED");
      return true;
    }
  );

  const entry = logger.entries.find(
    (candidate) => candidate.event === "database.transaction.rollback_failed"
  );
  assert.ok(entry, "rollback 失敗必須留下記錄");
  assert.equal(entry.context.error.message, "rollback also failed");
  assert.equal(names(connection).includes("release"), true);
});

test("an error thrown by the callback itself is wrapped, not leaked raw", async () => {
  const connection = fakeConnection();
  const { database } = createDatabase(connection);

  await assert.rejects(
    () =>
      database.withTransaction(() => {
        throw new Error("business rule violated");
      }),
    (error) => {
      // 非 ApplicationError 的例外要被包成統一的資料庫錯誤，才不會把內部訊息
      // 直接送到客戶端。
      assert.ok(error instanceof MySqlDatabaseOperationError);
      assert.equal(error.code, "DATABASE_TRANSACTION_FAILED");
      assert.equal(error.publicMessage, "Internal server error");
      assert.equal(error.cause.message, "business rule violated");
      return true;
    }
  );
  assert.deepEqual(names(connection), ["query", "begin", "rollback", "release"]);
});

test("an ApplicationError from the callback passes through unchanged", async () => {
  const connection = fakeConnection();
  const { database } = createDatabase(connection);
  const thrown = new ApplicationError("Order not found", {
    code: "ORDER_NOT_FOUND",
    statusCode: 404,
    publicMessage: "Not found"
  });

  await assert.rejects(
    () =>
      database.withTransaction(() => {
        throw thrown;
      }),
    (error) => {
      // handler 刻意拋出的業務錯誤必須原樣傳出，否則 404 會變成 500。
      assert.equal(error, thrown);
      return true;
    }
  );
});

// --- 第三層：輸入守衛 ---------------------------------------------------------

test("the service rejects malformed calls before touching the database", async () => {
  const connection = fakeConnection();
  const { database } = createDatabase(connection);

  await assert.rejects(() => database.withTransaction("not a function"), TypeError);
  await assert.rejects(() => database.query(""), TypeError);
  await assert.rejects(() => database.query("   "), TypeError);
  await assert.rejects(() => database.query(42), TypeError);
  await assert.rejects(
    () => database.query("SELECT 1", [], { timeoutMs: 0 }),
    TypeError
  );
  await assert.rejects(
    () => database.query("SELECT 1", [], { timeoutMs: -1 }),
    TypeError
  );
  await assert.rejects(
    () => database.query("SELECT 1", [], { timeoutMs: 1.5 }),
    TypeError
  );

  assert.deepEqual(connection.calls, []);
});

test("a query is refused when its signal is already aborted", async () => {
  const connection = fakeConnection();
  const { database } = createDatabase(connection);
  const controller = new AbortController();
  controller.abort(
    new MySqlDatabaseOperationError("cancelled", { code: "REQUEST_TIMEOUT" })
  );

  await assert.rejects(
    () => database.query("SELECT 1", [], { signal: controller.signal }),
    (error) => {
      // 中止原因的 code 要帶出來，日誌才分得出是逾時還是客戶端斷線。
      assert.equal(error.code, "REQUEST_TIMEOUT");
      return true;
    }
  );
});

test("the service refuses to be constructed without a pool or a context", () => {
  assert.throws(
    () => new MySqlDatabaseService({ config, logger: collectingLogger(), context: createContext() }),
    /requires a MySQL connection pool/
  );
  assert.throws(
    () =>
      new MySqlDatabaseService({
        pool: { query: async () => [[{ ok: 1 }]] },
        config,
        logger: collectingLogger()
      }),
    /requires a request context service/
  );
  assert.throws(
    () =>
      new MySqlDatabaseService({
        pool: { query: async () => [[{ ok: 1 }]] },
        config,
        logger: collectingLogger(),
        context: { get: () => ({}) }
      }),
    /requires a request context service/
  );
});

test("shutdown closes the pool once and tolerates being called again", async () => {
  let endCalls = 0;
  const database = new MySqlDatabaseService({
    pool: {
      query: async () => [[{ ok: 1 }]],
      end: async () => {
        endCalls += 1;
      }
    },
    config,
    logger: collectingLogger(),
    context: createContext()
  });

  await database.shutdown();
  await database.shutdown();
  await database.close();

  assert.equal(endCalls, 1);
});
