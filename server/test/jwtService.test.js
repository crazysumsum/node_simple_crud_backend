import assert from "node:assert/strict";
import test from "node:test";
import jwt from "jsonwebtoken";
import { JwtService } from "../src/services/auth/JwtService.js";

const secret = "test-only-jwt-secret-with-at-least-32-characters";
const baseJwtConfig = {
  secret,
  issuer: "erp-api",
  audience: "erp-client",
  algorithm: "HS256",
  expiresIn: "2h",
  clockToleranceSeconds: 5,
  headerName: "Authorization",
  authScheme: "Bearer"
};

function createService(overrides = {}) {
  // 與容器一致：service 拿到的是整份設定，自己取 jwt 那一節。
  return new JwtService({ config: { jwt: { ...baseJwtConfig, ...overrides } } });
}

test("a token issued by the service verifies back to its claims", () => {
  const service = createService();
  const token = service.issue({ role: "admin" }, { subject: "user-42" });
  const claims = service.verify(token);

  assert.equal(claims.sub, "user-42");
  assert.equal(claims.role, "admin");
  assert.equal(claims.iss, "erp-api");
  assert.equal(claims.aud, "erp-client");
});

test("the service surface is issue, verify and the header settings", () => {
  const service = createService();

  assert.equal(service.headerName, "authorization");
  assert.equal(service.authScheme, "Bearer");
  assert.equal(service.expiresIn, "2h");

  // 正規化後的設定是私有欄位，所以這個 service 自己的介面上沒有密鑰。
  // 注意這只收窄了它自己：每個 service 都會收到整份應用設定，config.jwt.secret
  // 本來就到處讀得到。
  assert.equal(service.secret, undefined);
  assert.equal(service.jwtConfig, undefined);
  assert.deepEqual(
    Object.getOwnPropertyNames(Object.getPrototypeOf(service)).sort(),
    ["authScheme", "constructor", "expiresIn", "headerName", "issue", "verify"]
  );
});

test("verification pins the algorithm, issuer and audience", () => {
  const service = createService();

  // 別人簽的 token：內容看起來對，但 issuer 不符。
  const foreign = jwt.sign({ role: "admin" }, secret, {
    algorithm: "HS256",
    issuer: "someone-else",
    audience: "erp-client",
    expiresIn: "2h"
  });
  assert.throws(() => service.verify(foreign), /issuer/i);

  const wrongAudience = jwt.sign({ role: "admin" }, secret, {
    algorithm: "HS256",
    issuer: "erp-api",
    audience: "another-client",
    expiresIn: "2h"
  });
  assert.throws(() => service.verify(wrongAudience), /audience/i);

  // 換一把密鑰重簽，簽章就對不上。
  const forged = jwt.sign({ role: "admin" }, `${secret}-tampered`, {
    algorithm: "HS256",
    issuer: "erp-api",
    audience: "erp-client",
    expiresIn: "2h"
  });
  assert.throws(() => service.verify(forged), /signature/i);
});

test("an expired token is rejected once it falls outside the clock tolerance", () => {
  const service = createService();
  // 簽發於一小時前、一分鐘後到期，遠超過 5 秒的容許誤差。exp 直接放進 payload，
  // jsonwebtoken 不允許同時使用 expiresIn。
  const issuedAt = Math.floor(Date.now() / 1000) - 3600;
  const expired = jwt.sign(
    { role: "admin", iat: issuedAt, exp: issuedAt + 60 },
    secret,
    { algorithm: "HS256", issuer: "erp-api", audience: "erp-client" }
  );

  assert.throws(() => service.verify(expired), (error) => {
    assert.equal(error.name, "TokenExpiredError");
    return true;
  });
});

test("the service refuses to start on an invalid jwt config", () => {
  // service 自己正規化設定，所以半套設定在啟動時就會失敗，而不是等到第一次
  // 有人送 token 進來。
  assert.throws(() => createService({ secret: "" }), /JWT_SECRET is required/);
  assert.throws(() => createService({ secret: "too-short" }), /at least 32 characters/);
  assert.throws(() => createService({ algorithm: "none" }), /algorithm is unsupported/);
  assert.throws(
    () => new JwtService({ config: {} }),
    /JWT_SECRET is required/
  );
});

test("issuing without a subject leaves sub unset", () => {
  const service = createService();
  const claims = service.verify(service.issue({ role: "guest" }));

  assert.equal(claims.sub, undefined);
  assert.equal(claims.role, "guest");
});
