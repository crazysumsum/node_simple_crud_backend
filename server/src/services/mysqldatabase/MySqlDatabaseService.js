import { ApplicationError } from "../../framework/errors/ApplicationError.js";
import { createMySqlDatabasePool } from "./connection.js";

const ISOLATION_LEVELS = new Set([
  "READ UNCOMMITTED",
  "READ COMMITTED",
  "REPEATABLE READ",
  "SERIALIZABLE"
]);

export class MySqlDatabaseOperationError extends ApplicationError {
  constructor(message, { code = "DATABASE_OPERATION_FAILED", cause } = {}) {
    super(message, {
      code,
      statusCode: 500,
      publicCode: "INTERNAL_SERVER_ERROR",
      publicMessage: "Internal server error",
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

class MySqlDatabaseExecutor {
  constructor({ target, config, logger, context, signal = null }) {
    this.target = target;
    this.config = config;
    this.logger = logger;
    this.context = context;
    this.signal = signal;
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

      const result = await raceWithSignal(
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
      context: activeContext
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

    const connection = await this.pool.getConnection();
    const context = this.context.get();
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
    const parentSignal = signal || context?.signal || null;
    const onParentAbort = () => controller.abort(parentSignal.reason);
    let transactionStarted = false;
    let connectionDestroyed = false;
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
