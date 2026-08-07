import { ApplicationError } from "../errors/ApplicationError.js";
import { sendError } from "../http/apiResponse.js";

function normalizeError(error) {
  if (error instanceof ApplicationError) {
    return error;
  }

  if (error?.type === "entity.too.large") {
    return new ApplicationError("JSON request body is too large", {
      code: "REQUEST_BODY_TOO_LARGE",
      statusCode: 413,
      publicMessage: "Request body is too large",
      cause: error
    });
  }

  if (error instanceof SyntaxError && error.status === 400 && "body" in error) {
    return new ApplicationError("Malformed JSON request body", {
      code: "INVALID_JSON",
      statusCode: 400,
      publicMessage: "Invalid JSON request body",
      cause: error
    });
  }

  return new ApplicationError(error?.message || "Unhandled application error", {
    code: "INTERNAL_SERVER_ERROR",
    statusCode: 500,
    publicCode: "INTERNAL_SERVER_ERROR",
    publicMessage: "Internal server error",
    cause: error
  });
}

export function createErrorHandler({ logger, time } = {}) {
  if (!logger || typeof logger.error !== "function") {
    throw new TypeError("Error handler requires a system logger");
  }

  if (!time || typeof time.timestamp !== "function") {
    throw new TypeError("Error handler requires a time service");
  }

  return function errorHandler(error, req, res, next) {
    const applicationError = normalizeError(error);

    void logger.error("http.request_failed", "HTTP request failed", {
      requestId: req.requestId || null,
      method: req.method,
      url: req.originalUrl || req.url,
      api: req.apiRoute || null,
      error: {
        name: applicationError.name,
        code: applicationError.code,
        message: applicationError.message,
        details: applicationError.details,
        stack: applicationError.stack
      }
    });

    if (res.headersSent) {
      next(error);
      return;
    }

    sendError(res, {
      statusCode: applicationError.statusCode,
      code: applicationError.publicCode,
      message: applicationError.publicMessage,
      details: applicationError.publicDetails,
      time
    });
  };
}
