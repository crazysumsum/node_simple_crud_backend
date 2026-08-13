import { isIP } from "node:net";

function positiveInteger(value, key) {
  const number = Number(value);

  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`Security config "${key}" must be a positive integer`);
  }

  return number;
}

// Express 內建的信任範圍名稱，由 proxy-addr 解析。
const TRUST_PROXY_PRESETS = new Set(["loopback", "linklocal", "uniquelocal"]);

/**
 * 驗證一個信任來源：預設名稱、IP 位址，或 CIDR。
 *
 * 這裡真的解析而不是放行任意字串。打錯的網段不會報錯，只會靜默地改變信任
 * 範圍——太窄就是誰都不信（限流失準），太寬就是信了不該信的跳。
 */
function trustedSource(entry) {
  if (TRUST_PROXY_PRESETS.has(entry)) {
    return entry;
  }

  const [address, prefix, ...rest] = entry.split("/");
  const family = isIP(address);

  if (family === 0 || rest.length > 0) {
    throw new Error(
      `Security config "reverseProxy.trustProxy" has an invalid entry: ${entry}. Use a hop count, an IP address, a CIDR range, or one of: ${[...TRUST_PROXY_PRESETS].join(", ")}.`
    );
  }

  if (prefix === undefined) {
    return address;
  }

  const bits = Number(prefix);
  const maximum = family === 4 ? 32 : 128;

  if (!/^\d+$/.test(prefix) || bits > maximum) {
    throw new Error(
      `Security config "reverseProxy.trustProxy" has an invalid CIDR prefix: ${entry}. IPv${family} allows /0 to /${maximum}.`
    );
  }

  return `${address}/${bits}`;
}

/**
 * 誰的 X-Forwarded-For 可以相信。
 *
 * 兩種形式，差別是「信任位置」還是「信任身分」：
 *
 *   跳數    從右邊數 n 跳都信任。單一入口時最簡單，但它數的是位置——只要有
 *           任何一條入口路徑比 n 短，那條路徑上客戶端自己送的那一段就會被
 *           算進信任範圍，req.ip 從此由客戶端指定。CDN 加直連 LB、多區域、
 *           對特定路徑 bypass CDN，都會造成長度不一。
 *   網段    走到第一個不在範圍內的位址就停，與鏈的長度無關。多入口請用這個。
 *
 * true 仍然被拒絕：那等於相信整條 X-Forwarded-For，任何客戶端都能偽造出任意
 * req.ip。要求說出跳數或網段，等於要求部署者講清楚實際的拓撲。
 *
 * req.ip 在這個框架裡餵三個地方——IP 限流、公開 route 的 idempotency scope、
 * 日誌的 clientIp——所以它被污染時三者一起失準，而且沒有任何徵兆。
 */
function normalizeTrustProxy(value) {
  const normalized = String(value ?? "false").trim().toLowerCase();

  if (normalized === "false" || normalized === "0" || normalized === "") {
    return false;
  }

  if (normalized === "true") {
    throw new Error(
      'Security config "trustProxy" must use a proxy hop count or a list of trusted addresses instead of true'
    );
  }

  if (/^\d+$/.test(normalized)) {
    return positiveInteger(normalized, "reverseProxy.trustProxy");
  }

  const entries = normalized
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (entries.length === 0) {
    throw new Error(
      'Security config "reverseProxy.trustProxy" must be a positive integer'
    );
  }

  return Object.freeze(entries.map(trustedSource));
}

export function normalizeSecurityConfig(source) {
  const allowedOrigins = String(source.cors?.allowedOrigins || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (allowedOrigins.length === 0 || allowedOrigins.includes("*")) {
    throw new Error("Security config requires a non-wildcard CORS origin allowlist");
  }

  for (const origin of allowedOrigins) {
    try {
      const parsed = new URL(origin);

      if (!parsed.protocol.startsWith("http")) {
        throw new Error("unsupported protocol");
      }
    } catch {
      throw new Error(`Security config contains an invalid CORS origin: ${origin}`);
    }
  }

  const jsonBodyLimit = String(source.jsonBodyLimit || "100kb").toLowerCase();

  if (!/^\d+(b|kb|mb)$/.test(jsonBodyLimit)) {
    throw new Error(`Security config "jsonBodyLimit" is invalid: ${jsonBodyLimit}`);
  }

  return Object.freeze({
    helmetEnabled: source.helmetEnabled !== false,
    hidePoweredBy: source.hidePoweredBy !== false,
    jsonBodyLimit,
    cors: Object.freeze({
      allowedOrigins,
      allowedMethods: [...(source.cors?.allowedMethods || [])].map(String),
      allowedHeaders: [...(source.cors?.allowedHeaders || [])].map(String),
      exposedHeaders: [...(source.cors?.exposedHeaders || [])].map(String),
      credentials: source.cors?.credentials === true,
      maxAgeSeconds: positiveInteger(
        source.cors?.maxAgeSeconds ?? 600,
        "cors.maxAgeSeconds"
      )
    }),
    reverseProxy: Object.freeze({
      trustProxy: normalizeTrustProxy(source.reverseProxy?.trustProxy),
      enforceHttps: source.reverseProxy?.enforceHttps === true
    })
  });
}
