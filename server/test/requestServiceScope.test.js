import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createRequestServiceScopeMiddleware } from "../src/framework/services/requestServiceScope.js";
import {
  markRequestProcessingCompleted,
  markRequestProcessingStarted
} from "../src/framework/http/requestProcessingLifecycle.js";

// 每個請求會拿到自己的 service scope，並在請求結束時拆掉。這裡的失敗全都是
// 安靜且累積的：scope 沒關就是 request-scoped 的資源一路留著，症狀要等到跑了
// 幾天之後才看得出來，而那時已經沒有任何線索指向這個中間件。
//
// 拆解本身也不能變成新的故障點——它跑在回應已經送出之後，這時候拋錯只會變成
// unhandled rejection。

function fakeScope({ shutdown } = {}) {
  const calls = [];
  const scope = {
    calls,
    async shutdown(options) {
      calls.push(options);
      return shutdown
        ? shutdown(options)
        : Object.freeze({ closed: true, failures: Object.freeze([]) });
    }
  };
  return scope;
}

function fakeServices(scope, { runInScope } = {}) {
  return {
    createScope: () => scope,
    runInScope: runInScope || ((_scope, callback) => callback())
  };
}

function collectingLogger() {
  const entries = [];
  return {
    entries,
    error: (event, message, context) => {
      entries.push({ event, message, context });
    }
  };
}

function fakeContext() {
  const updates = [];
  return { updates, update: (values) => updates.push(values) };
}

function createMiddleware({
  scope = fakeScope(),
  services,
  context = fakeContext(),
  logger = collectingLogger(),
  shutdownTimeoutMs = 5000
} = {}) {
  const middleware = createRequestServiceScopeMiddleware({
    services: services || fakeServices(scope),
    context,
    logger,
    shutdownTimeoutMs
  });
  return { middleware, scope, context, logger };
}

function fakeRequest() {
  return { requestId: "req-1" };
}

function fakeResponse() {
  return new EventEmitter();
}

// --- 建構時的檢查 --------------------------------------------------------------

test("the middleware refuses to build without the collaborators it needs", () => {
  const complete = {
    services: fakeServices(fakeScope()),
    context: fakeContext(),
    logger: collectingLogger()
  };

  // 每一個缺席都會在第一個請求進來時才炸，而且炸在 express 的中間件堆疊裡，
  // 錯誤訊息不會指向這裡。啟動時擋下來便宜得多。
  assert.throws(() => createRequestServiceScopeMiddleware(), /requires a service container/);
  assert.throws(
    () => createRequestServiceScopeMiddleware({ ...complete, services: {} }),
    /requires a service container/
  );
  assert.throws(
    // createScope 有、runInScope 沒有：半套的容器也要擋。
    () => createRequestServiceScopeMiddleware({ ...complete, services: { createScope: () => {} } }),
    /requires a service container/
  );
  assert.throws(
    () => createRequestServiceScopeMiddleware({ ...complete, context: undefined }),
    /requires request context/
  );
  assert.throws(
    () => createRequestServiceScopeMiddleware({ ...complete, context: {} }),
    /requires request context/
  );
  assert.throws(
    () => createRequestServiceScopeMiddleware({ ...complete, logger: undefined }),
    /requires a system logger/
  );
  assert.throws(
    () => createRequestServiceScopeMiddleware({ ...complete, logger: {} }),
    /requires a system logger/
  );
});

// --- 快樂路徑 ------------------------------------------------------------------

test("the scope is published to the request and to the context, then torn down", async () => {
  const { middleware, scope, context } = createMiddleware();
  const req = fakeRequest();
  const res = fakeResponse();
  let nextCalled = false;

  middleware(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.equal(req.services, scope);
  assert.deepEqual(context.updates, [{ serviceScope: scope }]);
  // next() 只是進入 scope，拆解要等請求真的結束。
  assert.deepEqual(scope.calls, []);

  markRequestProcessingStarted(req);
  markRequestProcessingCompleted(req);
  await Promise.resolve();

  assert.deepEqual(scope.calls, [{ timeoutMs: 5000 }]);
});

test("a response that ends before any handler ran still tears the scope down", async () => {
  const { middleware, scope } = createMiddleware();
  const req = fakeRequest();
  const res = fakeResponse();

  middleware(req, res, () => {});
  // 沒有 markRequestProcessingStarted：請求在到達 handler 之前就結束了（限流
  // 拒絕、404、客戶端斷線）。少了 res 的收尾，這種請求的 scope 永遠不會關。
  res.emit("finish");
  await Promise.resolve();

  assert.deepEqual(scope.calls, [{ timeoutMs: 5000 }]);
});

test("a closed connection tears the scope down as well as a finished one", async () => {
  const { middleware, scope } = createMiddleware();
  const req = fakeRequest();
  const res = fakeResponse();

  middleware(req, res, () => {});
  res.emit("close");
  await Promise.resolve();

  assert.deepEqual(scope.calls, [{ timeoutMs: 5000 }]);
});

test("the scope is only torn down once, however many times the request ends", async () => {
  const { middleware, scope } = createMiddleware();
  const req = fakeRequest();
  const res = fakeResponse();

  middleware(req, res, () => {});
  // finish 與 close 在真實環境裡經常都會觸發。重複拆解會對每個 service 呼叫
  // 第二次 shutdown()，而不是每個 service 都寫得冪等。
  res.emit("finish");
  res.emit("close");
  markRequestProcessingCompleted(req);
  await Promise.resolve();

  assert.deepEqual(scope.calls, [{ timeoutMs: 5000 }]);
});

// --- 拆解失敗 ------------------------------------------------------------------

test("a scope that reports unclosed services names them in the log", async () => {
  const logger = collectingLogger();
  const scope = fakeScope({
    shutdown: () =>
      Object.freeze({
        closed: false,
        failures: Object.freeze([
          { name: "reportBuilder", error: new Error("still writing") },
          { name: "exportStream", error: new Error("pipe broken") }
        ])
      })
  });
  const { middleware } = createMiddleware({ scope, logger });
  const req = fakeRequest();

  middleware(req, fakeResponse(), () => {});
  markRequestProcessingCompleted(req);
  await Promise.resolve();
  await Promise.resolve();

  const [entry] = logger.entries;
  assert.equal(entry.event, "service.scope.shutdown_failed");
  // 哪些 service 沒關掉是唯一的線索——洩漏本身沒有其他症狀。
  assert.deepEqual(entry.context.services, ["reportBuilder", "exportStream"]);
  assert.equal(entry.context.requestId, "req-1");
});

test("a shutdown that throws is logged instead of becoming an unhandled rejection", async () => {
  const logger = collectingLogger();
  const scope = fakeScope({
    shutdown: () => {
      throw new Error("scope registry is gone");
    }
  });
  const { middleware } = createMiddleware({ scope, logger });
  const req = fakeRequest();

  middleware(req, fakeResponse(), () => {});
  markRequestProcessingCompleted(req);
  await Promise.resolve();
  await Promise.resolve();

  // 這條路徑跑在回應送出之後，沒有人接得住拋出的錯誤。
  const [entry] = logger.entries;
  assert.equal(entry.event, "service.scope.shutdown_failed");
  assert.equal(entry.context.error.message, "scope registry is gone");
});

test("a request with no requestId still produces a usable failure log", async () => {
  // 兩條失敗路徑各自組自己的日誌 context，所以「沒有 requestId」要分別確認。
  // 未匹配任何 route 的請求（限流拒絕、404）正是既沒有 requestId、又最可能
  // 在拆解時出事的那一類。
  const reported = [
    Object.freeze({
      closed: false,
      failures: Object.freeze([{ name: "x", error: new Error("y") }])
    }),
    null
  ];

  for (const result of reported) {
    const logger = collectingLogger();
    const scope = fakeScope({
      shutdown: () => {
        if (result === null) {
          throw new Error("scope registry is gone");
        }

        return result;
      }
    });
    const { middleware } = createMiddleware({ scope, logger });
    const req = {};

    middleware(req, fakeResponse(), () => {});
    markRequestProcessingCompleted(req);
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(logger.entries[0].event, "service.scope.shutdown_failed");
    assert.equal(logger.entries[0].context.requestId, null);
  }
});

// --- next() 拋錯 ---------------------------------------------------------------

test("a synchronous failure downstream still closes the scope and forwards the error", async () => {
  const scope = fakeScope();
  const failure = new Error("middleware exploded");
  const { middleware } = createMiddleware({
    scope,
    services: fakeServices(scope, {
      runInScope: () => {
        throw failure;
      }
    })
  });
  const req = fakeRequest();
  const forwarded = [];

  middleware(req, fakeResponse(), (error) => forwarded.push(error));
  await Promise.resolve();

  // 同步拋錯的請求永遠不會發出 finish/close，所以生命週期的收尾接不到它。
  // 少了這條路徑，每一個這樣的請求都會洩漏一個 scope。
  assert.deepEqual(scope.calls, [{ timeoutMs: 5000 }]);
  assert.deepEqual(forwarded, [failure]);
});

test("a downstream failure does not tear the scope down twice", async () => {
  const scope = fakeScope();
  const { middleware } = createMiddleware({
    scope,
    services: fakeServices(scope, {
      runInScope: () => {
        throw new Error("middleware exploded");
      }
    })
  });
  const req = fakeRequest();
  const res = fakeResponse();

  middleware(req, res, () => {});
  res.emit("close");
  await Promise.resolve();

  assert.deepEqual(scope.calls, [{ timeoutMs: 5000 }]);
});
