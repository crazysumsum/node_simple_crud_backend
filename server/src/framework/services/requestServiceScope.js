import {
  markRequestResponseEnded,
  onRequestProcessingComplete
} from "../http/requestProcessingLifecycle.js";

export function createRequestServiceScopeMiddleware({
  services,
  context,
  logger,
  shutdownTimeoutMs
} = {}) {
  if (
    !services ||
    typeof services.createScope !== "function" ||
    typeof services.runInScope !== "function"
  ) {
    throw new TypeError("Request service scope middleware requires a service container");
  }

  if (!context || typeof context.update !== "function") {
    throw new TypeError("Request service scope middleware requires request context");
  }

  if (!logger || typeof logger.error !== "function") {
    throw new TypeError("Request service scope middleware requires a system logger");
  }

  return function requestServiceScope(req, res, next) {
    const scope = services.createScope();
    let shutdownPromise = null;

    req.services = scope;
    context.update({ serviceScope: scope });

    const shutdown = () => {
      if (shutdownPromise) {
        return shutdownPromise;
      }

      shutdownPromise = scope.shutdown({ timeoutMs: shutdownTimeoutMs }).then((result) => {
        if (!result.closed) {
          void logger.error(
            "service.scope.shutdown_failed",
            "Request service scope shutdown failed",
            {
              requestId: req.requestId || null,
              services: result.failures.map(({ name }) => name)
            }
          );
        }

        return result;
      }).catch((error) => {
        void logger.error(
          "service.scope.shutdown_failed",
          "Request service scope shutdown failed",
          {
            requestId: req.requestId || null,
            error: { name: error.name, message: error.message }
          }
        );
      });

      return shutdownPromise;
    };

    onRequestProcessingComplete(req, shutdown);
    res.once("finish", () => markRequestResponseEnded(req));
    res.once("close", () => markRequestResponseEnded(req));

    try {
      services.runInScope(scope, next);
    } catch (error) {
      void shutdown();
      next(error);
    }
  };
}
