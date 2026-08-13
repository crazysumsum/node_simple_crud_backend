import assert from "node:assert/strict";
import test from "node:test";
import { MySqlDatabaseService } from "../src/services/mysqldatabase/MySqlDatabaseService.js";
import { RequestContextService } from "../src/services/context/RequestContextService.js";
import { normalizeDatabaseConfig } from "../src/framework/configuration/normalizeDatabaseConfig.js";
import {
  defaultConfigurationSource,
  validateApplicationConfiguration
} from "../src/framework/configuration/applicationConfiguration.js";
import { createTestTime, servicesWithTime } from "../test-support/createTestTime.js";

// 連線池的壓力失效是安靜的：等連線沒有上限、隊列沒有上限、逾時不歸還容量。
// 三者單獨看都只是「有點慢」，湊在一起就是等待者無上限累積——每一個還吊著
// 一整個已經回應完畢的請求。

const silentLogger = { debug: async () => {}, error: async () => {}, info: async () => {} };
const context = new RequestContextService({
  services: servicesWithTime(createTestTime())
});
const wait = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const baseConfig = Object.freeze({
  connectionLimit: 1,
  queueLimit: 10,
  acquireTimeoutMs: 200,
  queryTimeoutMs: 200,
  transactionTimeoutMs: 1000,
  abandonedConnectionAction: "destroy"
});

/**
 * 一個記錄借還動作的 pool 替身。queryImpl 決定查詢怎麼結束。
 */
function trackingPool({ queryImpl, getConnectionImpl } = {}) {
  const calls = { getConnection: 0, release: 0, destroy: 0 };
  const pool = {
    calls,
    getConnection: async () => {
      calls.getConnection += 1;

      if (getConnectionImpl) {
        return getConnectionImpl(calls);
      }

      return {
        query: queryImpl ?? (async () => [[{ ok: 1 }]]),
        execute: queryImpl ?? (async () => [{ affectedRows: 1 }]),
        release: () => {
          calls.release += 1;
        },
        destroy: () => {
          calls.destroy += 1;
        }
      };
    },
    query: async () => [[{ ok: 1 }]],
    end: async () => {}
  };

  return pool;
}

function service(pool, overrides = {}) {
  return new MySqlDatabaseService({
    pool,
    context,
    logger: silentLogger,
    config: { ...baseConfig, ...overrides }
  });
}

// --- 逾時之後那條連線怎麼處理 ---------------------------------------------------

test("a timed-out query destroys its connection by default", async () => {
  // mysql2 的 pool.query() 是在查詢命令的 'end' 事件才 release，而逾時走的是
  // onResult。呼叫端脫身了，連線還被 checked out 著——實測對真的 MySQL 是
  // 呼叫端 508ms 拿到逾時、下一個查詢等 3506ms。destroy 之後是 7ms。
  const timeout = Object.assign(new Error("Query inactivity timeout"), {
    code: "PROTOCOL_SEQUENCE_TIMEOUT"
  });
  const pool = trackingPool({
    queryImpl: async () => {
      throw timeout;
    }
  });

  await assert.rejects(() => service(pool).query("SELECT SLEEP(9)"), (error) => {
    assert.equal(error.code, "DATABASE_QUERY_TIMEOUT");
    return true;
  });

  assert.deepEqual(
    { destroy: pool.calls.destroy, release: pool.calls.release },
    { destroy: 1, release: 0 }
  );
});

test("release keeps the connection for anyone who opts out of destroying", async () => {
  const timeout = Object.assign(new Error("Query inactivity timeout"), {
    code: "PROTOCOL_SEQUENCE_TIMEOUT"
  });
  const pool = trackingPool({
    queryImpl: async () => {
      throw timeout;
    }
  });

  await assert.rejects(() =>
    service(pool, { abandonedConnectionAction: "release" }).query("SELECT SLEEP(9)")
  );

  assert.deepEqual(
    { destroy: pool.calls.destroy, release: pool.calls.release },
    { destroy: 0, release: 1 }
  );
});

test("an ordinary SQL error releases the connection instead of throwing it away", async () => {
  // 語法錯、ER_DUP_ENTRY 之後連線狀態是明確的。把它 destroy 掉等於每一次
  // 唯一鍵衝突都重建一條連線——而唯一鍵衝突是 idempotency 的正常路徑。
  const duplicate = Object.assign(new Error("Duplicate entry"), {
    code: "ER_DUP_ENTRY"
  });
  const pool = trackingPool({
    queryImpl: async () => {
      throw duplicate;
    }
  });

  await assert.rejects(() => service(pool).execute("INSERT ..."), (error) => {
    assert.equal(error.code, "DATABASE_OPERATION_FAILED");
    assert.equal(error.cause, duplicate);
    return true;
  });

  assert.deepEqual(
    { destroy: pool.calls.destroy, release: pool.calls.release },
    { destroy: 0, release: 1 }
  );
});

test("an aborted query destroys the connection, because the query may still run", async () => {
  const controller = new AbortController();
  const pool = trackingPool({
    queryImpl: async () => {
      controller.abort(
        Object.assign(new Error("Request timed out"), { code: "REQUEST_TIMEOUT" })
      );
      await wait(50);
      return [[{ ok: 1 }]];
    }
  });

  await assert.rejects(
    () => service(pool).query("SELECT 1", [], { signal: controller.signal }),
    (error) => {
      assert.equal(error.code, "REQUEST_TIMEOUT");
      return true;
    }
  );

  assert.equal(pool.calls.destroy, 1);
});

test("a successful query always releases", async () => {
  const pool = trackingPool();
  const [rows] = await service(pool).query("SELECT 1");

  assert.deepEqual(rows, [{ ok: 1 }]);
  assert.deepEqual(
    { destroy: pool.calls.destroy, release: pool.calls.release },
    { destroy: 0, release: 1 }
  );
});

test("a connection that cannot be returned is logged, not thrown", async () => {
  // 這是在 finally 裡跑的。丟出去會蓋掉原本的查詢錯誤，讓呼叫端看到
  // 「還連線失敗」而不是真正的問題。
  const entries = [];
  const pool = trackingPool({
    getConnectionImpl: async () => ({
      query: async () => [[{ ok: 1 }]],
      release: () => {
        throw new Error("pool is closed");
      },
      destroy: () => {}
    })
  });
  const database = new MySqlDatabaseService({
    pool,
    context,
    config: baseConfig,
    logger: {
      ...silentLogger,
      error: async (event, message, ctx) => entries.push({ event, ctx })
    }
  });

  const [rows] = await database.query("SELECT 1");

  assert.deepEqual(rows, [{ ok: 1 }]);
  const entry = entries.find(
    ({ event }) => event === "database.connection.return_failed"
  );
  assert.equal(entry.ctx.action, "release");
});

// --- 等連線 --------------------------------------------------------------------

test("waiting for a connection has a deadline, and it answers 503", async () => {
  // mysql2 的查詢逾時裝在 Query.start()，也就是拿到連線之後才起算。實測把
  // 唯一的連線佔住、再送 20 個 timeout 設 200ms 的查詢，它們在 5708ms「成功」。
  let settle;
  const pending = new Promise((resolve) => {
    settle = resolve;
  });
  let released = 0;
  const pool = trackingPool({
    getConnectionImpl: async () =>
      pending.then(() => ({
        query: async () => [[{ ok: 1 }]],
        release: () => {
          released += 1;
        },
        destroy: () => {}
      }))
  });

  await assert.rejects(() => service(pool).query("SELECT 1"), (error) => {
    assert.equal(error.code, "DATABASE_CONNECTION_TIMEOUT");
    // 負載問題，不是伺服器故障。客戶端該收到可重試的 503。
    assert.equal(error.statusCode, 503);
    assert.equal(error.publicCode, "SERVICE_UNAVAILABLE");
    return true;
  });

  // 我們不等了，但這個等待者還在 mysql2 的隊列裡。將來輪到它時一定要把連線
  // 還回去，否則每次 acquire 逾時就永久少一條連線，池子一路縮到零。
  settle();
  await wait(10);
  assert.equal(released, 1);
});

test("a full pool queue is a 503, not a 500", async () => {
  // mysql2 丟的是 new Error("Queue limit reached.")，沒有 code。不認出來的話
  // 它會變成 DATABASE_OPERATION_FAILED 的 500，在監控上跟真的壞掉分不開。
  const pool = trackingPool({
    getConnectionImpl: async () => {
      throw new Error("Queue limit reached.");
    }
  });

  await assert.rejects(() => service(pool).query("SELECT 1"), (error) => {
    assert.equal(error.code, "DATABASE_POOL_QUEUE_FULL");
    assert.equal(error.statusCode, 503);
    return true;
  });
});

// --- 設定 ----------------------------------------------------------------------

const VALID_DATABASE = Object.freeze({
  host: "127.0.0.1",
  port: 3306,
  user: "erp",
  password: "secret",
  database: "erp_dev",
  connectionLimit: 10,
  queueLimit: 200,
  acquireTimeoutMs: 5000,
  queryTimeoutMs: 10000,
  abandonedConnectionAction: "destroy",
  transactionTimeoutMs: 30000
});

test("an unlimited pool queue cannot be configured at all", () => {
  // 0 是 mysql2 的「不限制」。實測連線上限 2、送進 200 個查詢，198 個全部
  // 被收下排隊，每一個都吊著一整個請求。
  assert.throws(
    () => normalizeDatabaseConfig({ ...VALID_DATABASE, queueLimit: 0 }),
    /"queueLimit" is invalid/
  );
  assert.equal(
    normalizeDatabaseConfig({ ...VALID_DATABASE, queueLimit: 1 }).queueLimit,
    1
  );
});

test("the abandoned connection action has to be one of the two that exist", () => {
  assert.throws(
    () =>
      normalizeDatabaseConfig({
        ...VALID_DATABASE,
        abandonedConnectionAction: "close"
      }),
    /"abandonedConnectionAction" must be one of: destroy, release/
  );

  // 沒寫就是 destroy。
  const defaults = normalizeDatabaseConfig({
    ...VALID_DATABASE,
    abandonedConnectionAction: undefined
  });
  assert.equal(defaults.abandonedConnectionAction, "destroy");
  assert.equal(
    normalizeDatabaseConfig({
      ...VALID_DATABASE,
      abandonedConnectionAction: "release"
    }).abandonedConnectionAction,
    "release"
  );
});

test("the acquire timeout is required and must be usable", () => {
  for (const acquireTimeoutMs of [0, -1, 1.5, "soon", undefined]) {
    assert.throws(
      () => normalizeDatabaseConfig({ ...VALID_DATABASE, acquireTimeoutMs }),
      /"acquireTimeoutMs" is invalid/
    );
  }
});

test("the database must give up before the route timeout does", () => {
  // 反過來的話 route 逾時先到，回了 504 也釋放了限流槽位，但被放棄的等待者
  // 還在 mysql2 的隊列裡吊著整個請求——這正是隊列會無上限累積的原因。
  const source = defaultConfigurationSource();

  assert.throws(
    () =>
      validateApplicationConfiguration({
        ...source,
        application: { ...source.application, requestTimeoutMs: 5000 },
        database: { ...source.database, acquireTimeoutMs: 5000, queryTimeoutMs: 10000 }
      }),
    /plus "queryTimeoutMs" \(10000ms\) must be shorter than application\.requestTimeoutMs \(5000ms\)/
  );

  // 剛好相等也不行：兩者同時到期，route 那一側仍可能先跑完。
  assert.throws(
    () =>
      validateApplicationConfiguration({
        ...source,
        application: { ...source.application, requestTimeoutMs: 10000 },
        database: { ...source.database, acquireTimeoutMs: 4000, queryTimeoutMs: 6000 }
      }),
    /must be shorter than application\.requestTimeoutMs/
  );
});

test("the pool queue must be able to hold a full load of requests", () => {
  const source = defaultConfigurationSource();

  assert.throws(
    () =>
      validateApplicationConfiguration({
        ...source,
        database: { ...source.database, connectionLimit: 10, queueLimit: 20 },
        requestLimiter: { ...source.requestLimiter, maxConcurrentRequests: 100 }
      }),
    /"queueLimit" \(20\) must be at least requestLimiter\.maxConcurrentRequests \(100\) minus "connectionLimit" \(10\) = 90/
  );

  // 剛好夠是可以的。
  assert.ok(
    validateApplicationConfiguration({
      ...source,
      database: { ...source.database, connectionLimit: 10, queueLimit: 90 },
      requestLimiter: { ...source.requestLimiter, maxConcurrentRequests: 100 }
    })
  );
});

test("the shipped defaults satisfy their own cross-section rules", () => {
  const configuration = validateApplicationConfiguration();

  assert.ok(
    configuration.database.acquireTimeoutMs + configuration.database.queryTimeoutMs <
      configuration.application.requestTimeoutMs
  );
  assert.ok(
    configuration.database.queueLimit >=
      configuration.requestLimiter.maxConcurrentRequests -
        configuration.database.connectionLimit
  );
  assert.equal(configuration.database.abandonedConnectionAction, "destroy");
});
