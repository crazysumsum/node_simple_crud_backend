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
  const token = service.issue({ role: "admin" }, { subject: "user-42", version: 3 });
  const claims = service.verify(token);

  assert.equal(claims.sub, "user-42");
  assert.equal(claims.role, "admin");
  assert.equal(claims.iss, "erp-api");
  assert.equal(claims.aud, "erp-client");
  // 撤銷的判準。少了它，TokenRevocationService 沒有東西可以比較。
  assert.equal(claims.ver, 3);
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

test("issuing without a subject is refused", () => {
  const service = createService();

  // sub 是撤銷的 key。少了它，那個 token 對登出、改密碼、強制下線全部免疫，
  // 而且沒有任何症狀——簽不出來遠比簽出一個永遠撤銷不掉的 token 好。
  const guest = { role: "guest" };

  assert.throws(() => service.issue(guest), /requires a subject/);
  assert.throws(() => service.issue(guest, { version: 0 }), /requires a subject/);
  assert.throws(
    () => service.issue(guest, { subject: "", version: 0 }),
    /requires a subject/
  );
  assert.throws(
    () => service.issue(guest, { subject: "   ", version: 0 }),
    /requires a subject/
  );
});

test("issuing without a version is refused for the same reason", () => {
  const service = createService();
  const guest = { role: "guest" };

  // ver 是撤銷的判準。忘記傳它的話 token 簽得出來卻永遠撤銷不掉——與忘記傳
  // subject 是同一類錯誤，所以擋在同一個地方，而且訊息要說出去哪裡拿。
  assert.throws(
    () => service.issue(guest, { subject: "u-1" }),
    /requires a version: read it from tokenRevocation\.currentVersion/
  );
  assert.throws(
    () => service.issue(guest, { subject: "u-1", version: null }),
    /requires a version/
  );
  // 字串會讓 isRevoked() 的 Number.isInteger 判定失敗，那個 token 一到就被
  // 當成已撤銷——簽發時就擋掉，比讓使用者登入後立刻被踢好。
  assert.throws(
    () => service.issue(guest, { subject: "u-1", version: "3" }),
    /requires a version/
  );
  assert.throws(
    () => service.issue(guest, { subject: "u-1", version: -1 }),
    /requires a version/
  );

  // 0 是合法的：從未被撤銷過的使用者就是這個值。
  assert.equal(service.verify(service.issue(guest, { subject: "u-1", version: 0 })).ver, 0);
});

test("the caller cannot smuggle a different version through the payload", () => {
  const service = createService();

  // payload 是業務資料，ver 是框架的判準。傳進來的那個必須贏，否則一個把
  // claims 原樣轉發的 handler 就能簽出一個版本號永遠停在舊值的 token。
  const token = service.issue({ role: "admin", ver: 99 }, { subject: "u-1", version: 2 });

  assert.equal(service.verify(token).ver, 2);
});

test("a token that arrives without sub is rejected at verification", () => {
  const service = createService();

  // issue() 擋不到手工造的 token：拿著密鑰的人可以簽一個沒有 sub 的，那正是
  // 撤銷不掉的那一種。驗證端必須自己再看一次。
  const withoutSubject = jwt.sign({ role: "admin" }, secret, {
    algorithm: "HS256",
    issuer: "erp-api",
    audience: "erp-client",
    expiresIn: "2h"
  });

  assert.throws(() => service.verify(withoutSubject), (error) => {
    // JsonWebTokenError 讓 JwtAuthStrategy 現有的 catch 原樣接住：原因進日誌，
    // 對外仍然只有籠統的 JWT_INVALID。
    assert.equal(error.name, "JsonWebTokenError");
    assert.match(error.message, /subject is required/);
    return true;
  });

  const blankSubject = jwt.sign({ role: "admin", sub: "  " }, secret, {
    algorithm: "HS256",
    issuer: "erp-api",
    audience: "erp-client",
    expiresIn: "2h"
  });

  assert.throws(() => service.verify(blankSubject), /subject is required/);
});

test("expiresIn must carry a unit, because a bare number means milliseconds", () => {
  // jsonwebtoken 收到字串時一律走 ms()，而 ms("3600") 是 3600 毫秒——
  // JWT_EXPIRES_IN=3600 會簽出 3 秒壽命的 token，沒有任何地方會說出來。
  assert.throws(() => createService({ expiresIn: "3600" }), /must be a whole number with a unit/);
  assert.throws(() => createService({ expiresIn: "banana" }), /must be a whole number with a unit/);
  assert.throws(() => createService({ expiresIn: "0h" }), /must be greater than zero/);

  // 帶單位的寫法照舊，而且解析出來的秒數與 jsonwebtoken 實際簽出來的一致。
  const service = createService({ expiresIn: "30m" });
  const claims = service.verify(
    service.issue({ role: "admin" }, { subject: "u-1", version: 0 })
  );

  assert.equal(claims.exp - claims.iat, 1800);
});
