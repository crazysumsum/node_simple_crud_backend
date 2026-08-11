import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import express from "express";
import { createProxyHeaderCheckMiddleware } from "../src/framework/security/securityMiddleware.js";

// 部署在反向代理後面卻沒設定 trustProxy，目前完全無聲：req.ip 變成代理自己的
// 位址，全體使用者共用同一個值。限流的每客戶端配額因此變成全服務配額，公開
// route 的 idempotency scope 也 collapse 成同一個。修正方法早就存在，缺的只是
// 有人告訴你。

function collectingLogger() {
  const entries = [];
  return {
    entries,
    warn: async (event, message, context) => entries.push({ event, message, context })
  };
}

const securityConfig = (trustProxy) => ({ reverseProxy: { trustProxy } });

async function startServer(t, trustProxy, logger) {
  const app = express();
  app.set("trust proxy", trustProxy);
  app.use(createProxyHeaderCheckMiddleware(securityConfig(trustProxy), logger));
  app.get("/probe", (req, res) => res.json({ ip: req.ip }));

  const server = createServer(app);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(
    () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      })
  );
  return `http://127.0.0.1:${server.address().port}`;
}

test("forwarded headers with trustProxy disabled are reported once", async (t) => {
  const logger = collectingLogger();
  const url = await startServer(t, false, logger);

  const first = await fetch(`${url}/probe`, {
    headers: { "x-forwarded-for": "203.0.113.7" }
  });

  // 這正是問題所在：客戶端宣稱自己是 203.0.113.7，但 req.ip 是連線對端。
  assert.equal((await first.json()).ip, "127.0.0.1");
  assert.equal(logger.entries.length, 1);

  const [entry] = logger.entries;
  assert.equal(entry.event, "security.proxy_headers_untrusted");
  assert.equal(entry.context.forwardedFor, "203.0.113.7");
  assert.equal(entry.context.observedClientIp, "127.0.0.1");
  // 訊號本身分不出是哪一種情況，所以兩種解讀都要寫出來。
  assert.match(entry.context.resolution, /TRUST_PROXY/);
  assert.match(entry.context.resolution, /spoofing/i);

  // 每個請求都寫一筆會把日誌洗掉，只記第一次。
  await fetch(`${url}/probe`, { headers: { "x-forwarded-for": "203.0.113.8" } });
  await fetch(`${url}/probe`, { headers: { forwarded: "for=203.0.113.9" } });
  assert.equal(logger.entries.length, 1);
});

test("the RFC 7239 Forwarded header is detected too", async (t) => {
  const logger = collectingLogger();
  const url = await startServer(t, false, logger);

  await fetch(`${url}/probe`, { headers: { forwarded: 'for="203.0.113.7:1234"' } });

  assert.equal(logger.entries.length, 1);
  assert.equal(logger.entries[0].context.forwarded, 'for="203.0.113.7:1234"');
  assert.equal(logger.entries[0].context.forwardedFor, null);
});

test("a correctly configured proxy produces no warning", async (t) => {
  const logger = collectingLogger();
  const url = await startServer(t, 1, logger);

  const response = await fetch(`${url}/probe`, {
    headers: { "x-forwarded-for": "203.0.113.7" }
  });

  // trustProxy 設對之後 req.ip 就是真正的客戶端，沒有東西需要警告。
  assert.equal((await response.json()).ip, "203.0.113.7");
  assert.deepEqual(logger.entries, []);
});

test("traffic without forwarded headers is silent", async (t) => {
  const logger = collectingLogger();
  const url = await startServer(t, false, logger);

  await fetch(`${url}/probe`);

  assert.deepEqual(logger.entries, []);
});

test("all callers share one rate-limit bucket when the proxy is not trusted", async (t) => {
  // 這是設定錯誤的實際後果，值得直接測出來而不是只靠註解描述。
  const seen = [];
  const app = express();
  app.set("trust proxy", false);
  app.use((req, _res, next) => {
    seen.push(req.ip);
    next();
  });
  app.get("/probe", (_req, res) => res.json({ ok: true }));

  const server = createServer(app);
  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
      })
  );
  const url = `http://127.0.0.1:${server.address().port}`;

  for (let index = 0; index < 5; index += 1) {
    await fetch(`${url}/probe`, {
      headers: { "x-forwarded-for": `203.0.113.${index}` }
    });
  }

  // 五個不同的宣稱來源，限流看到的卻是同一個 key。
  assert.equal(new Set(seen).size, 1);
});
