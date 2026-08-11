import { ApplicationError } from "../errors/ApplicationError.js";

export class CorsOriginError extends ApplicationError {
  constructor(origin) {
    super(`CORS origin is not allowed: ${origin}`, {
      code: "CORS_ORIGIN_DENIED",
      statusCode: 403,
      publicMessage: "Origin is not allowed"
    });
  }
}

export function createCorsOptions(config) {
  const allowedOrigins = new Set(config.cors.allowedOrigins);

  return {
    origin(origin, callback) {
      if (!origin || allowedOrigins.has(origin)) {
        callback(null, true);
        return;
      }

      callback(new CorsOriginError(origin));
    },
    methods: config.cors.allowedMethods,
    allowedHeaders: config.cors.allowedHeaders,
    exposedHeaders: config.cors.exposedHeaders,
    credentials: config.cors.credentials,
    maxAge: config.cors.maxAgeSeconds,
    optionsSuccessStatus: 204
  };
}

/**
 * 偵測「部署在反向代理後面，卻沒有設定 trustProxy」。
 *
 * 這種設定錯誤目前完全無聲。req.ip 會變成代理自己的位址，於是全體使用者共用
 * 同一個值——限流的 maxRequestsPerIpPerWindow 從「每個客戶端」變成「整個服務」，
 * 一個人正常操作就能把其他所有人擋在門外；公開 route 的 idempotency scope 也
 * 跟著collapse 成同一個；日誌裡的 clientIp 則全部相同，事後無從追查。
 *
 * 修正方法早就存在（TRUST_PROXY 設成代理層數），缺的只是有人告訴你。
 *
 * 訊息刻意同時給出兩種解讀，因為這個訊號本身無法區分：可能是你在代理後面卻沒
 * 設定，也可能是你直接對外而有客戶端在偽造這個 header。兩件事操作者都該知道。
 * 只在第一次出現時記錄，否則每個請求都會寫一筆。
 */
export function createProxyHeaderCheckMiddleware(config, logger) {
  let reported = false;

  return function checkProxyHeaders(req, _res, next) {
    if (reported || config.reverseProxy.trustProxy !== false) {
      next();
      return;
    }

    const forwardedFor = req.get("x-forwarded-for");
    const forwarded = req.get("forwarded");

    if (!forwardedFor && !forwarded) {
      next();
      return;
    }

    reported = true;
    void logger?.warn?.(
      "security.proxy_headers_untrusted",
      "Forwarded headers received while trustProxy is disabled",
      {
        // 記下實際看到的值，判斷是哪一種情況時用得上。
        forwardedFor: forwardedFor || null,
        forwarded: forwarded || null,
        observedClientIp: req.ip || req.socket?.remoteAddress || null,
        impact:
          "req.ip is the direct peer, so rate limiting, public idempotency scope and clientIp logging all collapse onto one value",
        resolution:
          "If this application runs behind a reverse proxy, set TRUST_PROXY to the number of proxy hops. If it is directly exposed, a client is spoofing these headers and they should be stripped at the edge."
      }
    );
    next();
  };
}

export function createHttpsEnforcementMiddleware(config) {
  return function enforceHttps(req, _res, next) {
    if (!config.reverseProxy.enforceHttps || req.secure) {
      next();
      return;
    }

    next(
      new ApplicationError("HTTPS is required", {
        code: "HTTPS_REQUIRED",
        statusCode: 426,
        publicMessage: "HTTPS is required"
      })
    );
  };
}
