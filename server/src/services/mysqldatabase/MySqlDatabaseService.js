import { ApplicationError } from "../../framework/errors/ApplicationError.js";
import { createMySqlDatabasePool } from "./connection.js";

const ISOLATION_LEVELS = new Set([
  "READ UNCOMMITTED",
  "READ COMMITTED",
  "REPEATABLE READ",
  "SERIALIZABLE"
]);

// 這兩個不是伺服器故障，是負載：連線池滿了、等連線等太久。客戶端該收到的是
// 可重試的 503，而不是一個看起來像 bug 的 500——監控上的意義也完全不同。
const OVERLOADED_CODES = new Set([
  "DATABASE_POOL_QUEUE_FULL",
  "DATABASE_CONNECTION_TIMEOUT"
]);

export class MySqlDatabaseOperationError extends ApplicationError {
  constructor(message, { code = "DATABASE_OPERATION_FAILED", cause } = {}) {
    const overloaded = OVERLOADED_CODES.has(code);

    super(message, {
      code,
      statusCode: overloaded ? 503 : 500,
      publicCode: overloaded ? "SERVICE_UNAVAILABLE" : "INTERNAL_SERVER_ERROR",
      publicMessage: overloaded ? "Service unavailable" : "Internal server error",
      cause
    });
  }
}

function positiveTimeout(value, fallback) {
  const timeoutMs = Number(value ?? fallback);

  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("Database timeout must be a positive integer");
  }

  return timeoutMs;
}

function abortError(signal) {
  return new MySqlDatabaseOperationError("MySQL database operation was aborted", {
    code: signal?.reason?.code || "DATABASE_OPERATION_ABORTED",
    cause: signal?.reason
  });
}

async function raceWithSignal(operation, signal) {
  if (!signal) {
    return operation;
  }

  if (signal.aborted) {
    throw abortError(signal);
  }

  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
  });

  try {
    return await Promise.race([operation, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/**
 * mysql2 在隊列滿的時候丟的是 new Error("Queue limit reached.")——沒有 code。
 * 不認出來的話它會被包成 DATABASE_OPERATION_FAILED 變成 500，但這是負載問題
 * 不是伺服器故障，客戶端該收到的是可重試的 503。
 */
function poolRejection(error) {
  if (error instanceof MySqlDatabaseOperationError) {
    return error;
  }

  if (/queue limit reached/i.test(error?.message ?? "")) {
    return new MySqlDatabaseOperationError(
      "MySQL connection pool queue is full",
      { code: "DATABASE_POOL_QUEUE_FULL", cause: error }
    );
  }

  return error;
}

/**
 * 這個錯誤代表「我們走了，但那條查詢可能還在 MySQL 上跑」。
 *
 * 區分它很重要：語法錯、ER_DUP_ENTRY 這類錯誤留下的連線狀態是明確的，還回
 * 池子完全沒問題。而逾時或 abort 之後，連線上可能還有一個未讀完的結果集、
 * 一個沒關的交易、或一把沒放的鎖——那條連線不能就這樣給下一個人。
 */
function connectionIsAbandoned(error) {
  const code = error?.code ?? error?.cause?.code ?? null;

  if (typeof code !== "string") {
    return false;
  }

  return (
    code === "DATABASE_OPERATION_ABORTED" ||
    code === "DATABASE_QUERY_TIMEOUT" ||
    code === "DATABASE_CONNECTION_TIMEOUT" ||
    code === "REQUEST_TIMEOUT" ||
    code.startsWith("PROTOCOL_") ||
    code === "ECONNRESET" ||
    code === "EPIPE" ||
    code === "ETIMEDOUT"
  );
}

class MySqlDatabaseExecutor {
  constructor({ target, config, logger, context, signal = null, pool = null }) {
    this.target = target;
    this.config = config;
    this.logger = logger;
    this.context = context;
    this.signal = signal;
    // 有 pool 代表每次操作都要自己借還連線。交易的 executor 沒有 pool——它
    // 的連線由 withTransaction 全程持有，中途還回去會拆掉交易。
    this.pool = pool;
  }

  query(sql, parameters = [], options = {}) {
    return this.run("query", sql, parameters, options);
  }

  execute(sql, parameters = [], options = {}) {
    return this.run("execute", sql, parameters, options);
  }

  async run(method, sql, parameters, { timeoutMs, signal, operationName } = {}) {
    if (typeof sql !== "string" || !sql.trim()) {
      throw new TypeError("Database SQL must be a non-empty string");
    }

    const requestContext = this.context.get();
    const activeSignal = signal || this.signal || requestContext?.signal || null;
    const activeTimeoutMs = positiveTimeout(
      timeoutMs,
      this.config.queryTimeoutMs
    );
    const startedAt = process.hrtime.bigint();

    try {
      if (activeSignal?.aborted) {
        throw abortError(activeSignal);
      }

      const result = this.pool
        ? await this.runOnPooledConnection(method, sql, parameters, {
            timeoutMs: activeTimeoutMs,
            signal: activeSignal
          })
        : await raceWithSignal(
            this.target[method]({ sql, timeout: activeTimeoutMs }, parameters),
            activeSignal
          );

      void this.logger?.debug?.("database.operation.completed", "Database operation completed", {
        requestId: requestContext?.requestId || null,
        operationName: operationName || method,
        durationMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000
      });
      return result;
    } catch (error) {
      if (error instanceof MySqlDatabaseOperationError) {
        throw error;
      }

      const code = error?.code === "PROTOCOL_SEQUENCE_TIMEOUT"
        ? "DATABASE_QUERY_TIMEOUT"
        : "DATABASE_OPERATION_FAILED";
      throw new MySqlDatabaseOperationError(`MySQL database ${method} failed`, {
        code,
        cause: error
      });
    }
  }

  /**
   * 明確借一條連線、用完決定怎麼還。
   *
   * 原本這裡是 pool.query()，它在查詢命令的 'end' 事件才 release。逾時走的是
   * onResult，所以呼叫端脫身之後連線仍然被 checked out 著，直到被放棄的查詢
   * 在 MySQL 上自己跑完——實測呼叫端 508ms 拿到逾時，下一個查詢等了 3506ms。
   * 逾時給了呼叫端控制權，卻沒有還回任何容量。
   */
  async runOnPooledConnection(method, sql, parameters, { timeoutMs, signal }) {
    const connection = await this.acquireConnection(signal);
    let abandoned = false;

    try {
      return await raceWithSignal(
        connection[method]({ sql, timeout: timeoutMs }, parameters),
        signal
      );
    } catch (error) {
      abandoned = connectionIsAbandoned(error);
      throw error;
    } finally {
      this.returnConnection(connection, abandoned);
    }
  }

  returnConnection(connection, abandoned) {
    const destroy =
      abandoned && this.config.abandonedConnectionAction === "destroy";

    try {
      if (destroy && typeof connection.destroy === "function") {
        connection.destroy();
        return;
      }

      connection.release();
    } catch (error) {
      void this.logger?.error?.(
        "database.connection.return_failed",
        "Failed to return a database connection to the pool",
        {
          requestId: this.context.get()?.requestId || null,
          action: destroy ? "destroy" : "release",
          error: { name: error.name, message: error.message }
        }
      );
    }
  }

  /**
   * 借一條連線，但不會無限期等下去。
   *
   * mysql2 的查詢逾時裝在 Query.start() 裡——也就是拿到連線之後才起算，所以
   * 「等連線」這一段原本完全沒有上限。實測把唯一的連線佔住、再送 20 個 timeout
   * 設 200ms 的查詢，它們在 5708ms「成功」，那 200ms 從頭到尾沒有作用過。
   */
  async acquireConnection(signal) {
    const pending = this.pool.getConnection();
    let timer = null;
    const expired = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new MySqlDatabaseOperationError(
            "Timed out waiting for a MySQL connection",
            { code: "DATABASE_CONNECTION_TIMEOUT" }
          )
        );
      }, this.config.acquireTimeoutMs);
      timer.unref?.();
    });

    try {
      return await raceWithSignal(Promise.race([pending, expired]), signal);
    } catch (error) {
      // 我們不等了，但這個等待者還在 mysql2 的隊列裡。將來輪到它時一定要把
      // 連線還回去，否則每一次 acquire 逾時就永久少一條連線——池子會一路縮到
      // 零，而症狀只是「越來越慢」。
      void pending.then((connection) => connection.release()).catch(() => {});
      throw poolRejection(error);
    } finally {
      clearTimeout(timer);
    }
  }
}

export class MySqlDatabaseService extends MySqlDatabaseExecutor {
  static service = Object.freeze({
    name: "mysqldatabase",
    lifecycle: "singleton",
    dependencies: ["logging", "context"],
    eager: true
  });

  constructor({ pool, config, logger, context, services, options = {} } = {}) {
    const managed = services && typeof services.require === "function";
    const activeConfig = managed ? config.database : config;
    const logging = managed ? services.require("logging") : null;
    const activeContext = context || (managed ? services.require("context") : null);
    const activePool = pool || options.pool || null;

    if (!managed && (!activePool || typeof activePool.query !== "function")) {
      throw new TypeError("MySqlDatabaseService requires a MySQL connection pool");
    }

    if (
      !activeContext ||
      ["get", "update"].some(
        (method) => typeof activeContext[method] !== "function"
      )
    ) {
      throw new TypeError("MySqlDatabaseService requires a request context service");
    }

    super({
      target: activePool,
      config: activeConfig,
      logger: logger || options.logger || logging?.logger,
      context: activeContext,
      pool: activePool
    });
    this.services = services || null;
    this.pool = activePool;
    this.poolFactory = options.poolFactory || createMySqlDatabasePool;
    this.closed = false;
  }

  async initialize() {
    try {
      if (!this.pool) {
        this.pool = this.poolFactory(this.config);
        this.target = this.pool;
      }

      if (!this.pool || typeof this.pool.query !== "function") {
        throw new TypeError("MySqlDatabaseService requires a MySQL connection pool");
      }

      await this.logger?.info?.(
        "database.pool.created",
        "MySQL connection pool created",
        {
          database: this.config.database,
          connectionLimit: this.config.connectionLimit,
          queueLimit: this.config.queueLimit,
          acquireTimeoutMs: this.config.acquireTimeoutMs,
          queryTimeoutMs: this.config.queryTimeoutMs,
          abandonedConnectionAction: this.config.abandonedConnectionAction,
          transport: this.config.socketPath ? "unix_socket" : "tcp"
        }
      );

      if (!(await this.healthCheck())) {
        throw new MySqlDatabaseOperationError("MySQL health check returned an invalid result", {
          code: "DATABASE_HEALTH_CHECK_FAILED"
        });
      }

      await this.logger?.info?.(
        "database.connection.verified",
        "MySQL database connection verified",
        { database: this.config.database }
      );
    } catch (error) {
      await this.logger?.error?.(
        "database.connection.failed",
        "MySQL database service initialization failed",
        {
          database: this.config.database,
          error: {
            name: error.name,
            message: error.message,
            code: error.code || null
          }
        }
      );
      throw error;
    }
  }

  async healthCheck() {
    const [rows] = await this.query("SELECT 1 AS ok", [], {
      operationName: "healthCheck"
    });
    return rows[0]?.ok === 1;
  }

  async withTransaction(
    work,
    { isolationLevel = "REPEATABLE READ", timeoutMs, signal } = {}
  ) {
    if (typeof work !== "function") {
      throw new TypeError("Database transaction work must be a function");
    }

    const normalizedIsolation = String(isolationLevel).toUpperCase();

    if (!ISOLATION_LEVELS.has(normalizedIsolation)) {
      throw new TypeError(`Unsupported transaction isolation level: ${isolationLevel}`);
    }

    const context = this.context.get();
    const parentSignal = signal || context?.signal || null;
    // 交易也要走同一條借連線的路徑，否則「等連線」在這裡仍然沒有上限。
    const connection = await this.acquireConnection(parentSignal);
    const previousTransaction = context?.databaseTransaction || null;
    const controller = new AbortController();
    const transaction = new MySqlDatabaseExecutor({
      target: connection,
      config: this.config,
      logger: this.logger,
      context: this.context,
      signal: controller.signal
    });
    const activeTimeoutMs = positiveTimeout(
      timeoutMs,
      this.config.transactionTimeoutMs
    );
    const onParentAbort = () => controller.abort(parentSignal.reason);
    let transactionStarted = false;
    let connectionDestroyed = false;
    // 交易中斷一律 destroy，不看 abandonedConnectionAction。那個設定管的是
    // 單句查詢——最壞情況是連線上留著一個沒讀完的結果集，mysql2 的命令佇列
    // 會把下一個人的查詢排在後面，慢但不會錯。中斷的交易不一樣：連線上留著
    // 一個沒有 commit 也沒有 rollback 的交易，還回池子等於把它交給下一個
    // 使用者，那是正確性問題，沒有「可以接受的較慢版本」。
    const onTransactionAbort = () => {
      if (typeof connection.destroy !== "function") {
        return;
      }

      try {
        connection.destroy();
        connectionDestroyed = true;
      } catch (error) {
        void this.logger?.error?.(
          "database.transaction.destroy_failed",
          "Failed to destroy an aborted database connection",
          {
            requestId: context?.requestId || null,
            error: { name: error.name, message: error.message }
          }
        );
      }
    };
    const timer = setTimeout(() => {
      controller.abort(
        new MySqlDatabaseOperationError("MySQL database transaction timed out", {
          code: "DATABASE_TRANSACTION_TIMEOUT"
        })
      );
    }, activeTimeoutMs);

    controller.signal.addEventListener("abort", onTransactionAbort, { once: true });

    if (parentSignal) {
      if (parentSignal.aborted) {
        onParentAbort();
      } else {
        parentSignal.addEventListener("abort", onParentAbort, { once: true });
      }
    }

    try {
      if (controller.signal.aborted) {
        throw abortError(controller.signal);
      }

      await raceWithSignal(
        connection.query(`SET TRANSACTION ISOLATION LEVEL ${normalizedIsolation}`),
        controller.signal
      );
      await raceWithSignal(connection.beginTransaction(), controller.signal);
      transactionStarted = true;
      this.updateContext({ databaseTransaction: transaction });
      const result = await raceWithSignal(
        Promise.resolve(work(transaction, { signal: controller.signal })),
        controller.signal
      );
      clearTimeout(timer);
      parentSignal?.removeEventListener?.("abort", onParentAbort);
      await connection.commit();
      transactionStarted = false;
      return result;
    } catch (error) {
      if (transactionStarted && !connectionDestroyed) {
        try {
          await connection.rollback();
        } catch (rollbackError) {
          void this.logger?.error?.("database.transaction.rollback_failed", "Database rollback failed", {
            requestId: context?.requestId || null,
            error: { name: rollbackError.name, message: rollbackError.message }
          });
        }
      }

      if (error instanceof ApplicationError) {
        throw error;
      }

      throw new MySqlDatabaseOperationError("MySQL database transaction failed", {
        code: "DATABASE_TRANSACTION_FAILED",
        cause: error
      });
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", onTransactionAbort);
      parentSignal?.removeEventListener?.("abort", onParentAbort);
      this.updateContext({ databaseTransaction: previousTransaction });

      if (!connectionDestroyed) {
        connection.release();
      }
    }
  }

  updateContext(values) {
    return this.context.update(values);
  }

  async shutdown() {
    if (this.closed) {
      return;
    }

    this.closed = true;
    await this.pool?.end?.();
  }

  close() {
    return this.shutdown();
  }
}
