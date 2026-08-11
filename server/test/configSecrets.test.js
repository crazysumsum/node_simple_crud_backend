import assert from "node:assert/strict";
import test from "node:test";
import { inspect } from "node:util";
import {
  SecretValue,
  revealSecret,
  secretValue
} from "../src/framework/configuration/SecretValue.js";
import { normalizeDatabaseConfig } from "../src/framework/configuration/normalizeDatabaseConfig.js";
import { normalizeJwtConfig } from "../src/framework/configuration/normalizeJwtConfig.js";
import { BaseService } from "../src/framework/services/BaseService.js";
import { JwtService } from "../src/services/auth/JwtService.js";
import { mySqlPoolOptions } from "../src/services/mysqldatabase/connection.js";

// 每個 service 都拿得到整份應用設定，所以密鑰從任何地方都讀得到。真正會出事的
// 不是有人刻意去讀，而是有人把設定整包寫進日誌——日誌保留 30 天。這裡守的是：
// 所有檢視路徑都拿不到明文，而取值必須明寫。

const secret = "test-only-jwt-secret-with-at-least-32-characters";
const jwtSource = {
  secret,
  issuer: "erp-api",
  audience: "erp-client",
  algorithm: "HS256",
  expiresIn: "2h",
  clockToleranceSeconds: 5,
  headerName: "Authorization",
  authScheme: "Bearer"
};

test("every way of viewing a secret yields [REDACTED]", () => {
  const value = new SecretValue("super-secret-value", "JWT secret");

  assert.equal(JSON.stringify({ value }), '{"value":"[REDACTED]"}');
  assert.equal(JSON.stringify(value), '"[REDACTED]"');
  assert.match(inspect(value), /\[REDACTED\]/);
  assert.doesNotMatch(inspect({ nested: { value } }, { depth: 5 }), /super-secret-value/);
  // 只有這一條出口。
  assert.equal(value.reveal(), "super-secret-value");
});

test("coercing a secret to a string throws instead of yielding a placeholder", () => {
  const value = new SecretValue("super-secret-value", "JWT secret");

  // 若強制轉換靜默給出 "[REDACTED]"，漏寫 reveal() 的程式碼會拿那個字面值
  // 去簽 token——全部簽錯、全部驗不過，而且沒有任何線索指向原因。
  assert.throws(() => `${value}`, /cannot be coerced/);
  assert.throws(() => String(value), /cannot be coerced/);
  assert.throws(() => value + "", /cannot be coerced/);
  assert.throws(() => `${value}`, /JWT secret/);
});

test("normalized config wraps the jwt secret and the database password", () => {
  const jwt = normalizeJwtConfig(jwtSource);
  assert.ok(jwt.secret instanceof SecretValue);
  assert.equal(jwt.secret.reveal(), secret);
  assert.equal(JSON.stringify(jwt).includes(secret), false);

  const database = normalizeDatabaseConfig({
    host: "127.0.0.1",
    port: 3306,
    user: "erp_user",
    password: "db-password",
    database: "erp",
    connectionLimit: 10,
    queueLimit: 0,
    queryTimeoutMs: 1000,
    transactionTimeoutMs: 1000
  });
  assert.ok(database.password instanceof SecretValue);
  assert.equal(database.password.reveal(), "db-password");
  assert.equal(JSON.stringify(database).includes("db-password"), false);
});

test("normalizing an already-normalized config does not double-wrap or throw", () => {
  // JwtService 會對容器給的（已正規化）設定再跑一次正規化，所以每個讀取密鑰
  // 的地方都必須同時接受兩種形式。
  const once = normalizeJwtConfig(jwtSource);
  const twice = normalizeJwtConfig(once);

  assert.ok(twice.secret instanceof SecretValue);
  assert.equal(twice.secret.reveal(), secret);
  assert.equal(revealSecret(twice.secret), secret);
  assert.equal(revealSecret("plain-string"), "plain-string");
  assert.equal(secretValue(once.secret), once.secret, "已包裝的值不應再包一層");
});

test("secret validation still runs on the unwrapped value", () => {
  assert.throws(
    () => normalizeJwtConfig({ ...jwtSource, secret: "too-short" }),
    /at least 32 characters/
  );
  assert.throws(
    () => normalizeJwtConfig({ ...jwtSource, secret: new SecretValue("too-short") }),
    /at least 32 characters/
  );
  assert.throws(
    () => normalizeJwtConfig({ ...jwtSource, secret: new SecretValue("") }),
    /JWT_SECRET is required/
  );
});

test("the jwt service still signs and verifies through the wrapper", () => {
  const service = new JwtService({ config: { jwt: jwtSource } });
  const claims = service.verify(service.issue({ role: "admin" }, { subject: "u-1" }));

  assert.equal(claims.sub, "u-1");
  assert.equal(claims.role, "admin");
});

test("the connection pool receives a plain password, not the wrapper", () => {
  const database = normalizeDatabaseConfig({
    host: "127.0.0.1",
    port: 3306,
    user: "erp_user",
    password: "db-password",
    database: "erp",
    connectionLimit: 10,
    queueLimit: 0,
    queryTimeoutMs: 1000,
    transactionTimeoutMs: 1000
  });
  const options = mySqlPoolOptions(database);

  // mysql2 需要字串；傳進包裝物件會在建立連線時才爆，症狀是啟動連不上資料庫。
  assert.equal(options.password, "db-password");
  assert.equal(options.user, "erp_user");
  // 逾時設定是框架自己的，不屬於連線池。
  assert.equal(Object.hasOwn(options, "queryTimeoutMs"), false);
  assert.equal(Object.hasOwn(options, "transactionTimeoutMs"), false);

  // 尚未正規化的設定檔（預設參數走的那條路）也要能處理。
  assert.equal(mySqlPoolOptions({ password: "raw" }).password, "raw");
  assert.equal(mySqlPoolOptions({}).password, "");
});

test("every logger profile redacts the same sensitive field names", async () => {
  const { default: loggingConfig } = await import("../config/logging.js");
  const profiles = Object.entries(loggingConfig.loggers);

  assert.ok(profiles.length >= 2);

  // system logger 一直有 secret，request logger 卻漏了——而 request log 在
  // 狀態碼 >= 400 時一律完整記錄 body。清單分歧本身就是缺口的來源。
  for (const [name, profile] of profiles) {
    const redacted = profile.redactedFields.map((field) => field.toLowerCase());

    for (const required of ["password", "secret", "token", "authorization"]) {
      assert.ok(
        redacted.includes(required),
        `logger "${name}" 未遮蔽 ${required}`
      );
    }
  }
});

test("a service does not carry the application config into serialized output", () => {
  const config = { jwt: normalizeJwtConfig(jwtSource) };
  const service = new BaseService({ config, services: {}, options: {} });

  // 讀寫行為不變，只是不可列舉。
  assert.equal(service.config, config);
  assert.equal(Object.keys(service).includes("config"), false);
  assert.equal(JSON.stringify(service), '{"services":{},"options":{}}');

  // 子類別照常覆寫 config 時也不會把它變回可列舉。
  service.config = { replaced: true };
  assert.deepEqual(service.config, { replaced: true });
  assert.equal(Object.keys(service).includes("config"), false);
});
