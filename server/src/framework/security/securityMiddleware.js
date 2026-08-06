import { ApplicationError } from "../errors/ApplicationError.js";

export class CorsOriginError extends ApplicationError {
  constructor(origin) {
    super(`CORS origin is not allowed: ${origin}`, {
      code: "CORS_ORIGIN_DENIED",
      statusCode: 403,
      publicMessage: "Origin is not allowed"
    });
  }
}

export function createCorsOptions(config) {
  const allowedOrigins = new Set(config.cors.allowedOrigins);

  return {
    origin(origin, callback) {
      if (!origin || allowedOrigins.has(origin)) {
        callback(null, true);
        return;
      }

      callback(new CorsOriginError(origin));
    },
    methods: config.cors.allowedMethods,
    allowedHeaders: config.cors.allowedHeaders,
    exposedHeaders: config.cors.exposedHeaders,
    credentials: config.cors.credentials,
    maxAge: config.cors.maxAgeSeconds,
    optionsSuccessStatus: 204
  };
}

export function createHttpsEnforcementMiddleware(config) {
  return function enforceHttps(req, _res, next) {
    if (!config.reverseProxy.enforceHttps || req.secure) {
      next();
      return;
    }

    next(
      new ApplicationError("HTTPS is required", {
        code: "HTTPS_REQUIRED",
        statusCode: 426,
        publicMessage: "HTTPS is required"
      })
    );
  };
}
