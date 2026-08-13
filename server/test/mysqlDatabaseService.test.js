import assert from "node:assert/strict";
import test from "node:test";
import {
  MySqlDatabaseOperationError,
  MySqlDatabaseService
} from "../src/services/mysqldatabase/MySqlDatabaseService.js";
import { RequestContextService } from "../src/services/context/RequestContextService.js";
import { createTestTime, servicesWithTime } from "../test-support/createTestTime.js";

const config = {
  queryTimeoutMs: 2500,
  acquireTimeoutMs: 5000,
  transactionTimeoutMs: 5000,
  abandonedConnectionAction: "destroy"
};

/** 每一句 query/execute 現在都自己借還一條連線，所以 pool 替身要能借出來。 */
function lendable(pool) {
  const lent = { release: 0, destroy: 0 };
  return {
    lent,
    pool: {
      ...pool,
      getConnection: async () => ({
        query: pool.query,
        execute: pool.execute,
        release: () => {
          lent.release += 1;
        },
        destroy: () => {
          lent.destroy += 1;
        }
      })
    }
  };
}

const silentLogger = {
  debug: async () => {},
  error: async () => {}
};
const context = new RequestContextService({
  services: servicesWithTime(createTestTime())
});

test("MySQL database service verifies connectivity during initialization", async () => {
  const calls = [];
  const { pool } = lendable({
    query: async (...args) => {
      calls.push(args);
      return [[{ ok: 1 }]];
    },
    end: async () => {}
  });
  const database = new MySqlDatabaseService({
    pool,
    config,
    logger: silentLogger,
    context
  });

  await database.initialize();

  assert.deepEqual(calls, [
    [{ sql: "SELECT 1 AS ok", timeout: 2500 }, []]
  ]);
});

test("MySQL database service rejects an invalid initialization health result", async () => {
  const database = new MySqlDatabaseService({
    pool: lendable({
      query: async () => [[{ ok: 0 }]],
      end: async () => {}
    }).pool,
    config,
    logger: silentLogger,
    context
  });

  await assert.rejects(
    () => database.initialize(),
    (error) => {
      assert.equal(error.code, "DATABASE_HEALTH_CHECK_FAILED");
      return true;
    }
  );
});

test("MySQL database service applies query timeouts and parameterized execution", async () => {
  const calls = [];
  const { pool, lent } = lendable({
    query: async (...args) => {
      calls.push(["query", ...args]);
      return [[{ id: 7 }]];
    },
    execute: async (...args) => {
      calls.push(["execute", ...args]);
      return [{ affectedRows: 1 }];
    },
    end: async () => {}
  });
  const database = new MySqlDatabaseService({ pool, config, logger: silentLogger, context });

  const [rows] = await database.query("SELECT id FROM users WHERE id = ?", [7]);
  await database.execute("UPDATE users SET active = ? WHERE id = ?", [true, 7], {
    timeoutMs: 1000,
    operationName: "activateUser"
  });

  assert.deepEqual(rows, [{ id: 7 }]);
  assert.deepEqual(calls[0], [
    "query",
    { sql: "SELECT id FROM users WHERE id = ?", timeout: 2500 },
    [7]
  ]);
  assert.deepEqual(calls[1], [
    "execute",
    { sql: "UPDATE users SET active = ? WHERE id = ?", timeout: 1000 },
    [true, 7]
  ]);
  // 成功的查詢一律還回池子，不管 abandonedConnectionAction 設什麼。
  assert.deepEqual(lent, { release: 2, destroy: 0 });
});

test("MySQL database service commits successful transactions and releases connections", async () => {
  const calls = [];
  const connection = {
    query: async (...args) => {
      calls.push(["query", ...args]);
      return [[], []];
    },
    execute: async (...args) => {
      calls.push(["execute", ...args]);
      return [{ insertId: 42 }];
    },
    beginTransaction: async () => calls.push(["begin"]),
    commit: async () => calls.push(["commit"]),
    rollback: async () => calls.push(["rollback"]),
    release: () => calls.push(["release"])
  };
  const pool = {
    query: async () => [[], []],
    getConnection: async () => connection,
    end: async () => {}
  };
  const database = new MySqlDatabaseService({ pool, config, logger: silentLogger, context });

  const result = await database.withTransaction(
    async (transaction, { signal }) => {
      assert.equal(signal.aborted, false);
      const [writeResult] = await transaction.execute(
        "INSERT INTO orders (name) VALUES (?)",
        ["Test"]
      );
      return writeResult.insertId;
    },
    { isolationLevel: "READ COMMITTED" }
  );

  assert.equal(result, 42);
  assert.deepEqual(calls.map(([name]) => name), [
    "query",
    "begin",
    "execute",
    "commit",
    "release"
  ]);
  assert.equal(
    calls[0][1],
    "SET TRANSACTION ISOLATION LEVEL READ COMMITTED"
  );
});

test("MySQL database service rolls back failed transactions", async () => {
  const calls = [];
  const connection = {
    query: async () => [[], []],
    execute: async () => {
      throw new Error("write failed");
    },
    beginTransaction: async () => calls.push("begin"),
    commit: async () => calls.push("commit"),
    rollback: async () => calls.push("rollback"),
    release: () => calls.push("release")
  };
  const pool = {
    query: async () => [[], []],
    getConnection: async () => connection,
    end: async () => {}
  };
  const database = new MySqlDatabaseService({ pool, config, logger: silentLogger, context });

  await assert.rejects(
    () =>
      database.withTransaction((transaction) =>
        transaction.execute("INSERT INTO orders (name) VALUES (?)", ["Fail"])
      ),
    (error) => {
      assert.ok(error instanceof MySqlDatabaseOperationError);
      assert.equal(error.code, "DATABASE_OPERATION_FAILED");
      return true;
    }
  );
  assert.deepEqual(calls, ["begin", "rollback", "release"]);
});

test("transaction queries automatically inherit the transaction timeout signal", async () => {
  const calls = [];
  const connection = {
    query: async () => [[], []],
    execute: async () => {
      calls.push("execute");
      return new Promise(() => {});
    },
    beginTransaction: async () => calls.push("begin"),
    commit: async () => calls.push("commit"),
    rollback: async () => calls.push("rollback"),
    release: () => calls.push("release")
  };
  const pool = {
    query: async () => [[], []],
    getConnection: async () => connection,
    end: async () => {}
  };
  const database = new MySqlDatabaseService({
    pool,
    config: { ...config, transactionTimeoutMs: 10 },
    logger: silentLogger,
    context
  });

  await assert.rejects(
    () =>
      database.withTransaction((transaction) =>
        transaction.execute("SELECT SLEEP(30)")
      ),
    (error) => {
      assert.ok(error instanceof MySqlDatabaseOperationError);
      assert.equal(error.code, "DATABASE_TRANSACTION_TIMEOUT");
      return true;
    }
  );
  assert.deepEqual(calls, ["begin", "execute", "rollback", "release"]);
});

test("transaction timeout is cleared before commit to avoid concurrent rollback", async () => {
  const calls = [];
  const connection = {
    query: async () => [[], []],
    execute: async () => [{ affectedRows: 1 }],
    beginTransaction: async () => calls.push("begin"),
    commit: async () => {
      await new Promise((resolve) => { setTimeout(resolve, 25); });
      calls.push("commit");
    },
    rollback: async () => calls.push("rollback"),
    release: () => calls.push("release")
  };
  const database = new MySqlDatabaseService({
    pool: {
      query: async () => [[], []],
      getConnection: async () => connection,
      end: async () => {}
    },
    config: { ...config, transactionTimeoutMs: 10 },
    logger: silentLogger,
    context
  });

  const result = await database.withTransaction(async (transaction) => {
    await transaction.execute("UPDATE orders SET status = ?", ["created"]);
    return "committed";
  });

  assert.equal(result, "committed");
  assert.deepEqual(calls, ["begin", "commit", "release"]);
});

test("transaction abort destroys a connection with unfinished database work", async () => {
  const calls = [];
  const connection = {
    query: async () => [[], []],
    execute: async () => {
      calls.push("execute");
      return new Promise(() => {});
    },
    beginTransaction: async () => calls.push("begin"),
    commit: async () => calls.push("commit"),
    rollback: async () => calls.push("rollback"),
    destroy: () => calls.push("destroy"),
    release: () => calls.push("release")
  };
  const database = new MySqlDatabaseService({
    pool: {
      query: async () => [[], []],
      getConnection: async () => connection,
      end: async () => {}
    },
    config: { ...config, transactionTimeoutMs: 10 },
    logger: silentLogger,
    context
  });

  await assert.rejects(
    () =>
      database.withTransaction((transaction) =>
        transaction.execute("SELECT SLEEP(30)")
      ),
    (error) => {
      assert.equal(error.code, "DATABASE_TRANSACTION_TIMEOUT");
      return true;
    }
  );

  assert.deepEqual(calls, ["begin", "execute", "destroy"]);
});
