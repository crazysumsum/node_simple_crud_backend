import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { registerProcessLifecycle } from "../src/framework/application/processLifecycle.js";

function createFixture() {
  const processTarget = new EventEmitter();
  const shutdownCalls = [];
  const logEntries = [];
  const exitCalls = [];
  const application = {
    logger: {
      error: async (event, message, context) => {
        logEntries.push({ event, message, context });
      }
    },
    async shutdown(reason, requestedExitCode) {
      shutdownCalls.push({ reason, requestedExitCode });
      return { exitCode: requestedExitCode };
    }
  };
  const lifecycle = registerProcessLifecycle({
    application,
    processTarget,
    exit: (code) => exitCalls.push(code),
    consoleTarget: { error: () => {} }
  });

  return {
    application,
    processTarget,
    shutdownCalls,
    logEntries,
    exitCalls,
    lifecycle
  };
}

test("process lifecycle gracefully shuts down on SIGTERM", async () => {
  const fixture = createFixture();

  fixture.processTarget.emit("SIGTERM");
  const result = await fixture.lifecycle.waitForTermination();

  assert.deepEqual(fixture.shutdownCalls, [
    { reason: "SIGTERM", requestedExitCode: 0 }
  ]);
  assert.equal(result.exitCode, 0);
  assert.equal(fixture.processTarget.exitCode, 0);
  assert.deepEqual(fixture.exitCalls, []);
  fixture.lifecycle.dispose();
});

test("process lifecycle logs an unhandled rejection, shuts down and exits", async () => {
  const fixture = createFixture();
  const fatalError = new Error("fatal rejection");

  fixture.processTarget.emit("unhandledRejection", fatalError, Promise.resolve());
  const result = await fixture.lifecycle.waitForTermination();

  assert.deepEqual(fixture.shutdownCalls, [
    { reason: "unhandledRejection", requestedExitCode: 1 }
  ]);
  assert.equal(fixture.logEntries[0].event, "process.fatal_error");
  assert.equal(fixture.logEntries[0].context.error.message, "fatal rejection");
  assert.equal(result.exitCode, 1);
  assert.deepEqual(fixture.exitCalls, [1]);
  fixture.lifecycle.dispose();
});

test("process lifecycle treats an uncaught exception as fatal", async () => {
  const fixture = createFixture();

  fixture.processTarget.emit(
    "uncaughtException",
    new Error("uncaught failure"),
    "uncaughtException"
  );
  const result = await fixture.lifecycle.waitForTermination();

  assert.deepEqual(fixture.shutdownCalls, [
    { reason: "uncaughtException", requestedExitCode: 1 }
  ]);
  assert.equal(fixture.logEntries[0].context.error.message, "uncaught failure");
  assert.equal(result.exitCode, 1);
  assert.deepEqual(fixture.exitCalls, [1]);
  fixture.lifecycle.dispose();
});
