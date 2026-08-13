import assert from "node:assert/strict";
import test from "node:test";
import { createHandlerServices } from "../src/framework/api/createHandlerServices.js";
import { normalizeApplicationConfig } from "../src/framework/configuration/normalizeApplicationConfig.js";
import { normalizeSecurityConfig } from "../src/framework/security/normalizeSecurityConfig.js";
import { normalizeRequestValidationConfig } from "../src/framework/validation/normalizeRequestValidationConfig.js";
import { normalizeResponseValidationConfig } from "../src/framework/validation/normalizeResponseValidationConfig.js";
import { normalizeApiVersioningConfig } from "../src/framework/versioning/normalizeApiVersioningConfig.js";

// 設定正規化器是「錯誤的設定變成明確的啟動失敗」這條防線的實作。它們幾乎全是
// 分支，而先前只有快樂路徑被走過——分支覆蓋落在 36–50%。
//
// 這裡的每個測試釘的是「哪一種設定會被拒絕」，不是為了走到那一行。分辨得出
// 「拒絕」與「靜默接受」才是重點：一個放行了無效值的正規化器，會把設定錯誤
// 從啟動失敗降級成執行期的怪異行為。

// --- API 版本 ------------------------------------------------------------------

const VALID_VERSIONING = Object.freeze({
  defaultVersion: "v1",
  supportedVersions: ["v1", "v2"],
  responseHeaderName: "X-API-Version"
});

test("API versioning accepts a well-formed config and defaults enabled to true", () => {
  const config = normalizeApiVersioningConfig(VALID_VERSIONING);

  assert.equal(config.enabled, true);
  assert.equal(config.defaultVersion, "v1");
  assert.deepEqual([...config.supportedVersions], ["v1", "v2"]);
  assert.equal(Object.isFrozen(config), true);
  assert.equal(Object.isFrozen(config.supportedVersions), true);
});

test("API versioning can be switched off but still validates its values", () => {
  // enabled: false 不是「跳過檢查」。停用版本標頭之後設定仍然要是對的，否則
  // 重新啟用時才發現壞掉。
  assert.equal(
    normalizeApiVersioningConfig({ ...VALID_VERSIONING, enabled: false }).enabled,
    false
  );
  assert.throws(
    () => normalizeApiVersioningConfig({ ...VALID_VERSIONING, enabled: false, defaultVersion: "x" }),
    /"defaultVersion" must match v<number>/
  );
});

test("API versioning rejects every malformed defaultVersion", () => {
  for (const defaultVersion of [undefined, "", "1", "v0", "V1", "v1.1", "latest", " "]) {
    assert.throws(
      () => normalizeApiVersioningConfig({ ...VALID_VERSIONING, defaultVersion }),
      /"defaultVersion" must match v<number>/,
      `${JSON.stringify(defaultVersion)} 不該被接受`
    );
  }

  // 空白會先被 trim 掉，所以 " v1 " 是合法的。
  assert.equal(
    normalizeApiVersioningConfig({ ...VALID_VERSIONING, defaultVersion: " v1 " }).defaultVersion,
    "v1"
  );
});

test("API versioning rejects a supportedVersions list it cannot rely on", () => {
  const cases = [
    ["缺少", undefined],
    ["不是陣列", "v1"],
    ["空陣列", []],
    ["只有空字串", ["", "  "]],
    ["有重複", ["v1", "v1"]],
    ["有無效成員", ["v1", "v0"]],
    ["有非版本字串", ["v1", "beta"]]
  ];

  for (const [label, supportedVersions] of cases) {
    assert.throws(
      () => normalizeApiVersioningConfig({ ...VALID_VERSIONING, supportedVersions }),
      /"supportedVersions" must contain unique v<number> values/,
      `${label} 不該被接受`
    );
  }
});

test("API versioning rejects a default that is not in the supported list", () => {
  // 這個組合每一半都合法，只有放在一起才錯——所以它需要自己一條檢查。放行的話，
  // 沒有指定版本的請求會被導向一個不存在的版本。
  assert.throws(
    () =>
      normalizeApiVersioningConfig({
        ...VALID_VERSIONING,
        defaultVersion: "v3",
        supportedVersions: ["v1", "v2"]
      }),
    /defaultVersion must be supported/
  );
});

test("API versioning rejects a response header name that is not a header name", () => {
  for (const responseHeaderName of [undefined, "", "X API Version", "X:Version", "X_Version"]) {
    assert.throws(
      () => normalizeApiVersioningConfig({ ...VALID_VERSIONING, responseHeaderName }),
      /"responseHeaderName" is invalid/,
      `${JSON.stringify(responseHeaderName)} 不該被接受`
    );
  }
});

test("API versioning treats a missing config as a malformed one", () => {
  // 整個區塊漏掉時，第一個檢查就該擋下來，而不是讀到 undefined 再往下爆。
  assert.throws(() => normalizeApiVersioningConfig(undefined), /"defaultVersion"/);
  assert.throws(() => normalizeApiVersioningConfig({}), /"defaultVersion"/);
});

// --- 安全性 --------------------------------------------------------------------

const VALID_SECURITY = Object.freeze({
  cors: { allowedOrigins: "https://app.example.com,http://localhost:5173" }
});

test("security config normalizes a valid CORS allowlist", () => {
  const config = normalizeSecurityConfig(VALID_SECURITY);

  assert.deepEqual(config.cors.allowedOrigins, [
    "https://app.example.com",
    "http://localhost:5173"
  ]);
  assert.equal(config.helmetEnabled, true);
  assert.equal(config.hidePoweredBy, true);
  assert.equal(config.jsonBodyLimit, "100kb");
  assert.equal(config.cors.credentials, false);
  assert.equal(config.cors.maxAgeSeconds, 600);
  assert.equal(config.reverseProxy.trustProxy, false);
  assert.equal(config.reverseProxy.enforceHttps, false);
});

test("security config refuses to run without a real CORS allowlist", () => {
  // 萬用字元在這裡是硬性拒絕而不是警告：一個放行所有來源的 API 不該只靠文件
  // 勸阻。空字串同理——那通常是環境變數漏設，而不是刻意不設限。
  for (const allowedOrigins of ["", "   ", ",,", "*", "https://app.example.com,*"]) {
    assert.throws(
      () => normalizeSecurityConfig({ cors: { allowedOrigins } }),
      /non-wildcard CORS origin allowlist/,
      `${JSON.stringify(allowedOrigins)} 不該被接受`
    );
  }

  assert.throws(() => normalizeSecurityConfig({}), /non-wildcard CORS origin allowlist/);
});

test("security config rejects an origin that is not an http origin", () => {
  // 兩條不同的路徑：解析得出來但協定不對，以及根本解析不出來。兩者的修正方式
  // 一樣，但少了任何一條都會讓一個壞掉的 origin 靜靜進到 cors 中間件。
  assert.throws(
    () => normalizeSecurityConfig({ cors: { allowedOrigins: "ftp://files.example.com" } }),
    /invalid CORS origin: ftp:\/\/files\.example\.com/
  );
  assert.throws(
    () => normalizeSecurityConfig({ cors: { allowedOrigins: "app.example.com" } }),
    /invalid CORS origin: app\.example\.com/
  );
  assert.throws(
    () => normalizeSecurityConfig({ cors: { allowedOrigins: "https://ok.example.com,nope" } }),
    /invalid CORS origin: nope/
  );
});

test("security config validates the JSON body limit format", () => {
  for (const jsonBodyLimit of ["100", "1gb", "10 kb", "kb", "-1kb"]) {
    assert.throws(
      () => normalizeSecurityConfig({ ...VALID_SECURITY, jsonBodyLimit }),
      /"jsonBodyLimit" is invalid/,
      `${jsonBodyLimit} 不該被接受`
    );
  }

  // 大小寫不敏感，單位限於 b/kb/mb。
  assert.equal(
    normalizeSecurityConfig({ ...VALID_SECURITY, jsonBodyLimit: "2MB" }).jsonBodyLimit,
    "2mb"
  );
});

test("trustProxy takes a hop count, and true is rejected loudly", () => {
  const trustProxyOf = (trustProxy) =>
    normalizeSecurityConfig({ ...VALID_SECURITY, reverseProxy: { trustProxy } })
      .reverseProxy.trustProxy;

  for (const value of [undefined, "false", "FALSE", "0", "", "  "]) {
    assert.equal(trustProxyOf(value), false, `${JSON.stringify(value)} 應該是關閉`);
  }

  assert.equal(trustProxyOf("1"), 1);
  assert.equal(trustProxyOf(2), 2);

  // Express 的 trust proxy 接受 true，意思是「相信整條 X-Forwarded-For」——
  // 任何客戶端都能偽造出任意 req.ip。要求跳數等於要求部署者說出實際的代理層數。
  assert.throws(
    () => trustProxyOf("true"),
    /must use a proxy hop count instead of true/
  );

  for (const value of ["yes", "-1", "1.5"]) {
    assert.throws(
      () => trustProxyOf(value),
      /"reverseProxy.trustProxy" must be a positive integer/,
      `${value} 不該被接受`
    );
  }
});

test("security config validates the CORS max age", () => {
  assert.throws(
    () => normalizeSecurityConfig({ ...VALID_SECURITY, cors: { ...VALID_SECURITY.cors, maxAgeSeconds: 0 } }),
    /"cors.maxAgeSeconds" must be a positive integer/
  );
  assert.throws(
    () => normalizeSecurityConfig({ ...VALID_SECURITY, cors: { ...VALID_SECURITY.cors, maxAgeSeconds: "soon" } }),
    /"cors.maxAgeSeconds" must be a positive integer/
  );
});

test("security config opt-outs require an explicit false, and opt-ins an explicit true", () => {
  const config = normalizeSecurityConfig({
    ...VALID_SECURITY,
    helmetEnabled: false,
    hidePoweredBy: false,
    cors: { ...VALID_SECURITY.cors, credentials: true },
    reverseProxy: { enforceHttps: true }
  });

  assert.equal(config.helmetEnabled, false);
  assert.equal(config.hidePoweredBy, false);
  assert.equal(config.cors.credentials, true);
  assert.equal(config.reverseProxy.enforceHttps, true);

  // 保護機制用 !== false，所以只有字面上的 false 能關掉它；而放寬限制的開關
  // 用 === true，所以 "true" 這種字串不會意外打開。兩邊的預設都偏向安全。
  const fuzzy = normalizeSecurityConfig({
    ...VALID_SECURITY,
    helmetEnabled: 0,
    cors: { ...VALID_SECURITY.cors, credentials: "true" },
    reverseProxy: { enforceHttps: 1 }
  });

  assert.equal(fuzzy.helmetEnabled, true);
  assert.equal(fuzzy.cors.credentials, false);
  assert.equal(fuzzy.reverseProxy.enforceHttps, false);
});

// --- 應用程式 ------------------------------------------------------------------

const VALID_APPLICATION = Object.freeze({
  host: "127.0.0.1",
  port: 3000,
  timeZone: "Asia/Hong_Kong",
  requestTimeoutMs: 30000,
  shutdownTimeoutMs: 30000
});

test("application config requires a host", () => {
  for (const host of [undefined, "", "   "]) {
    assert.throws(
      () => normalizeApplicationConfig({ ...VALID_APPLICATION, host }),
      /"host" must be a non-empty string/,
      `${JSON.stringify(host)} 不該被接受`
    );
  }

  assert.throws(() => normalizeApplicationConfig(undefined), /"host"/);
});

test("application config rejects a time zone the platform does not know", () => {
  // 時區錯了不會在啟動時有任何症狀，但每一筆日誌時間戳都會是錯的，而那是事後
  // 對照事件順序時唯一的依據。
  for (const timeZone of ["Asia/Hong_Kong_City", "GMT+8", "", "  "]) {
    assert.throws(
      () => normalizeApplicationConfig({ ...VALID_APPLICATION, timeZone }),
      /"timeZone" is invalid/,
      `${JSON.stringify(timeZone)} 不該被接受`
    );
  }

  assert.equal(
    normalizeApplicationConfig({ ...VALID_APPLICATION, timeZone: "UTC" }).timeZone,
    "UTC"
  );
});

test("application config keeps the port inside the range a port can have", () => {
  // port 的下限是 0（測試用，由作業系統分配），其他逾時的下限是 1。這兩種
  // 下限走的是 integer() 的不同分支。
  assert.equal(normalizeApplicationConfig({ ...VALID_APPLICATION, port: 0 }).port, 0);
  assert.equal(normalizeApplicationConfig({ ...VALID_APPLICATION, port: 65535 }).port, 65535);

  for (const port of [-1, 65536, 1.5, "http"]) {
    assert.throws(
      () => normalizeApplicationConfig({ ...VALID_APPLICATION, port }),
      /"port" must be an integer between 0 and 65535/,
      `${port} 不該被接受`
    );
  }
});

test("application config rejects non-positive timeouts", () => {
  for (const key of ["requestTimeoutMs", "shutdownTimeoutMs"]) {
    for (const value of [0, -1, 1.5, "soon", undefined]) {
      assert.throws(
        () => normalizeApplicationConfig({ ...VALID_APPLICATION, [key]: value }),
        new RegExp(`"${key}" must be an integer greater than or equal to 1`),
        `${key}=${value} 不該被接受`
      );
    }
  }
});

// --- 請求驗證 ------------------------------------------------------------------

test("request validation config defaults are the permissive-input ones", () => {
  const config = normalizeRequestValidationConfig({});

  assert.deepEqual({ ...config }, {
    enabled: true,
    allErrors: true,
    coerceTypes: true,
    useDefaults: true,
    // 預設不刪除多餘欄位：靜默丟掉客戶端送來的資料，比明確拒絕更難查。
    removeAdditional: false,
    maxErrors: 20,
    includeErrorDetailsInResponse: true
  });
  assert.equal(Object.isFrozen(config), true);
});

test("request validation booleans need an explicit true to turn on", () => {
  // booleanValue 只認 undefined 與字面上的 true。"false" 這種字串會變成 false，
  // 不會因為是非空字串就意外變成 true。
  const config = normalizeRequestValidationConfig({
    allErrors: "false",
    coerceTypes: 0,
    useDefaults: null,
    removeAdditional: true,
    includeErrorDetailsInResponse: "yes"
  });

  assert.equal(config.allErrors, false);
  assert.equal(config.coerceTypes, false);
  assert.equal(config.useDefaults, false);
  assert.equal(config.removeAdditional, true);
  assert.equal(config.includeErrorDetailsInResponse, false);
});

test("request validation can be disabled outright", () => {
  assert.equal(normalizeRequestValidationConfig({ enabled: false }).enabled, false);
  assert.equal(normalizeRequestValidationConfig({ enabled: 0 }).enabled, true);
});

test("request validation rejects a maxErrors that cannot cap anything", () => {
  for (const maxErrors of [0, -1, 1.5, "many"]) {
    assert.throws(
      () => normalizeRequestValidationConfig({ maxErrors }),
      /"maxErrors" must be a positive integer/,
      `${maxErrors} 不該被接受`
    );
  }

  assert.equal(normalizeRequestValidationConfig({ maxErrors: 1 }).maxErrors, 1);
});

// --- 回應驗證 ------------------------------------------------------------------

test("response validation stays on in production unless explicitly turned off", () => {
  const runtimeEnabledIn = (environment, source) =>
    normalizeResponseValidationConfig(source, { environment }).runtimeEnabled;

  // 回應驗證抓的是「伺服器回了不符合契約的東西」。在 production 關掉它，等於
  // 只在最不需要的地方開著，所以預設是開的。
  assert.equal(runtimeEnabledIn("production", {}), true);
  assert.equal(runtimeEnabledIn("production", { validateInProduction: false }), false);
  // 非 production 環境不看 validateInProduction。
  assert.equal(runtimeEnabledIn("development", { validateInProduction: false }), true);
  // enabled: false 一律關閉，不論環境。
  assert.equal(runtimeEnabledIn("development", { enabled: false }), false);
  assert.equal(runtimeEnabledIn("production", { enabled: false, validateInProduction: true }), false);
});

test("response validation falls back to the process environment", () => {
  const previous = process.env.NODE_ENV;

  try {
    process.env.NODE_ENV = "production";
    assert.equal(
      normalizeResponseValidationConfig({ validateInProduction: false }).runtimeEnabled,
      false
    );

    process.env.NODE_ENV = "";
    // 未設定時落回 "development"，於是驗證是開的——漏設環境變數不該靜默關掉檢查。
    assert.equal(
      normalizeResponseValidationConfig({ validateInProduction: false }).runtimeEnabled,
      true
    );
  } finally {
    if (previous === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = previous;
    }
  }
});

test("response validation rejects a maxErrors that cannot cap anything", () => {
  for (const maxErrors of [0, -1, 1.5, "many"]) {
    assert.throws(
      () => normalizeResponseValidationConfig({ maxErrors }),
      /"maxErrors" must be a positive integer/,
      `${maxErrors} 不該被接受`
    );
  }
});

test("response validation tolerates a missing config block", () => {
  const config = normalizeResponseValidationConfig(undefined, { environment: "test" });

  assert.equal(config.enabled, true);
  assert.equal(config.maxErrors, 20);
  assert.equal(config.allErrors, true);
  assert.equal(config.runtimeEnabled, true);
});

// --- handler services ----------------------------------------------------------

const handlerDependencies = () => ({
  logger: { info: () => {} },
  loggers: {},
  mysqlDatabase: {},
  context: { get: () => ({}) },
  time: { timestamp: () => "2026-01-01T00:00:00.000+08:00" }
});

test("handler services expose the injected dependencies by their service names", () => {
  const dependencies = handlerDependencies();
  const container = createHandlerServices(dependencies);

  assert.equal(container.get("time"), dependencies.time);
  assert.equal(container.get("context"), dependencies.context);
  // handler 用的名字是 mysqldatabase，與容器裡的 service 名稱一致。
  assert.equal(container.get("mysqldatabase"), dependencies.mysqlDatabase);
});

test("handler services accept extra values but not a non-object custom map", () => {
  const marker = { marker: true };

  assert.equal(
    createHandlerServices({ ...handlerDependencies(), custom: { extra: marker } }).get("extra"),
    marker
  );

  for (const custom of [null, [], "extra", 7]) {
    assert.throws(
      () => createHandlerServices({ ...handlerDependencies(), custom }),
      /Custom handler services must be an object/,
      `${JSON.stringify(custom)} 不該被接受`
    );
  }
});

test("handler services refuse to build without context or time", () => {
  // 這兩個是每個 handler 都會用到的：context 決定日誌怎麼關聯，time 決定回應
  // 的時間戳。少了它們，錯誤會在第一個請求進來時才出現在 handler 內部。
  assert.throws(
    () => createHandlerServices({ ...handlerDependencies(), context: undefined }),
    /require a request context service/
  );
  assert.throws(
    () => createHandlerServices({ ...handlerDependencies(), context: {} }),
    /require a request context service/
  );
  assert.throws(
    () => createHandlerServices({ ...handlerDependencies(), time: undefined }),
    /require a time service/
  );
  assert.throws(
    () => createHandlerServices({ ...handlerDependencies(), time: { nowMs: () => 0 } }),
    /require a time service/
  );
  assert.throws(() => createHandlerServices(), /require a request context service/);
});
