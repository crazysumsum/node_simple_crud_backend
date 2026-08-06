import { ApplicationError } from "../framework/errors/ApplicationError.js";
import { BaseRequestHandler } from "../framework/api/BaseRequestHandler.js";

export class HealthHandler extends BaseRequestHandler {
  static handlerName = "healthCheck";

  static api = {
    method: "GET",
    path: "/api/v1/health",
    description: "檢查 ERP API 及 MySQL 資料庫連線狀態。",
    authType: "public",
    authorizationPolicies: [
      {
        name: "allowAll",
        options: {}
      }
    ],
    timeoutMs: 5000,
    requestSchema: {
      params: {
        type: "object",
        properties: {},
        additionalProperties: false
      },
      query: {
        type: "object",
        properties: {},
        additionalProperties: false
      }
    },
    responseSchema: {
      200: {
        type: "object",
        required: ["status", "database", "timestamp"],
        additionalProperties: false,
        properties: {
          status: {
            type: "string",
            enum: ["ok"]
          },
          database: {
            type: "string",
            enum: ["connected", "unknown"]
          },
          timestamp: {
            type: "string",
            format: "date-time"
          }
        }
      }
    }
  };

  constructor(services = {}) {
    super(services);

    if (
      !this.mysqlDatabase ||
      typeof this.mysqlDatabase.healthCheck !== "function"
    ) {
      throw new TypeError("HealthHandler requires MySqlDatabaseService");
    }
  }

  async execute() {
    try {
      const databaseConnected = await this.mysqlDatabase.healthCheck();

      return this.response({
        status: "ok",
        database: databaseConnected ? "connected" : "unknown",
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      throw new ApplicationError("Database health check failed", {
        code: "DATABASE_UNAVAILABLE",
        statusCode: 503,
        publicCode: "SERVICE_UNAVAILABLE",
        publicMessage: "Service unavailable",
        cause: error
      });
    }
  }
}
