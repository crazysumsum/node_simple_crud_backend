function errorContext(error) {
  const normalizedError = error instanceof Error ? error : new Error(String(error));

  return {
    name: normalizedError.name,
    message: normalizedError.message,
    stack: normalizedError.stack
  };
}

export function registerProcessLifecycle({
  application,
  processTarget = process,
  exit = (code) => processTarget.exit(code),
  consoleTarget = console
} = {}) {
  if (!application || typeof application.shutdown !== "function") {
    throw new TypeError("Process lifecycle requires an application instance");
  }

  let terminationPromise = null;

  const terminate = (
    reason,
    { requestedExitCode = 0, error, exitAfterShutdown = false } = {}
  ) => {
    if (terminationPromise) {
      exit(1);
      return terminationPromise;
    }

    terminationPromise = (async () => {
      processTarget.exitCode = requestedExitCode;
      let fatalLog = Promise.resolve();

      if (error !== undefined) {
        const context = errorContext(error);
        consoleTarget.error(`[${reason}] ${context.stack || context.message}`);
        fatalLog = Promise.resolve(
          application.logger.error(
            "process.fatal_error",
            "Fatal process error detected",
            { origin: reason, error: context }
          )
        ).catch((logError) => {
          consoleTarget.error(`Failed to record fatal process error: ${logError.message}`);
        });
      }

      try {
        const shutdown = application.shutdown(reason, requestedExitCode);
        const [, result] = await Promise.all([fatalLog, shutdown]);
        processTarget.exitCode = result.exitCode;

        if (exitAfterShutdown) {
          exit(result.exitCode || 1);
        }

        return result;
      } catch (shutdownError) {
        consoleTarget.error(`Application shutdown failed: ${shutdownError.stack}`);
        processTarget.exitCode = 1;
        exit(1);
        return null;
      }
    })();

    return terminationPromise;
  };

  const onSigterm = () => {
    void terminate("SIGTERM");
  };
  const onSigint = () => {
    void terminate("SIGINT");
  };
  const onUncaughtException = (error, origin = "uncaughtException") => {
    void terminate(origin, {
      requestedExitCode: 1,
      error,
      exitAfterShutdown: true
    });
  };
  const onUnhandledRejection = (reason) => {
    void terminate("unhandledRejection", {
      requestedExitCode: 1,
      error: reason,
      exitAfterShutdown: true
    });
  };

  processTarget.on("SIGTERM", onSigterm);
  processTarget.on("SIGINT", onSigint);
  processTarget.on("uncaughtException", onUncaughtException);
  processTarget.on("unhandledRejection", onUnhandledRejection);

  return Object.freeze({
    terminate,
    waitForTermination: () => terminationPromise || Promise.resolve(null),
    dispose() {
      processTarget.off("SIGTERM", onSigterm);
      processTarget.off("SIGINT", onSigint);
      processTarget.off("uncaughtException", onUncaughtException);
      processTarget.off("unhandledRejection", onUnhandledRejection);
    }
  });
}
