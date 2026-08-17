import { Router } from "express";
import apiConfig from "../../../config/api.js";
import applicationConfig from "../../../config/application.js";
import { BaseRequestHandler } from "../api/BaseRequestHandler.js";
import { createAuthorizationPolicyRegistry } from "../authorization/authorizationPolicyRegistry.js";
import { sendError } from "../http/apiResponse.js";
import {
  markRequestProcessingCompleted,
  markRequestProcessingStarted
} from "../http/requestProcessingLifecycle.js";
import { DISABLED_ROUTE_IDEMPOTENCY } from "../../services/idempotency/IdempotencyService.js";
import { createRequestTimeoutMiddleware } from "./requestTimeout.js";
import { cleanupUploadedFiles } from "../upload/cleanupUploadedFiles.js";
import { UploadConcurrencyGate } from "../upload/uploadConcurrencyGate.js";
import { createUploadMiddleware } from "../upload/uploadMiddleware.js";
import {
  normalizeApiUploadConfig,
  normalizeDownloadConfig,
  normalizeUploadConfig
} from "../upload/normalizeUploadConfig.js";
import { RequestValidator } from "../validation/requestValidator.js";
import { ResponseValidator } from "../validation/responseValidator.js";
import { normalizeApiVersioningConfig } from "../versioning/normalizeApiVersioningConfig.js";
import {
  createApiLifecycleMiddleware,
  normalizeApiLifecycle
} from "../versioning/apiLifecycle.js";

const HTTP_METHODS = new Set(["delete", "get", "patch", "post", "put"]);
// Express 5 移除了 :param? 與裸 * 兩種寫法。提早比對可換來清楚的設定錯誤訊息，
// 而不是等 path-to-regexp 在註冊 route 時丟出難以對應到 handler 的例外。
const LEGACY_PATH_SYNTAX = /:[A-Za-z0-9_]+\?|\*(?![A-Za-z_])/;
const BODY_CAPTURE_MODES = new Set(["none", "full"]);

// routes 也可以由呼叫端直接傳入，未必經過 apiDefinitionResolver 補上預設值。
// 這裡收斂成一個一定存在且合法的物件，requestLogger 才能安全讀取。
function normalizeRouteLogging(source, routeKey) {
  if (source === undefined || source === null) {
    return Object.freeze({ bodyCapture: "none" });
  }

  if (typeof source !== "object" || Array.isArray(source)) {
    throw new Error(`logging config must be an object for ${routeKey}`);
  }

  const bodyCapture = String(source.bodyCapture ?? "none").toLowerCase();

  if (!BODY_CAPTURE_MODES.has(bodyCapture)) {
    throw new Error(
      `logging.bodyCapture must be "none" or "full" for ${routeKey}`
    );
  }

  return Object.freeze({ bodyCapture });
}

export function validateApiConfig(
  routes,
  handlers,
  strategies,
  defaultRequestTimeoutMs,
  authorizationPolicies = createAuthorizationPolicyRegistry(),
  versioning = normalizeApiVersioningConfig(apiConfig.versioning),
  idempotency,
  requestReceiveTimeoutMs = Number(applicationConfig.requestReceiveTimeoutMs)
) {
  if (!Array.isArray(routes)) {
    throw new TypeError("API config must export an array");
  }

  const configuredRoutes = new Set();

  for (const route of routes) {
    const method = String(route.method || "").toLowerCase();
    const routeKey = `${method} ${route.path}`;

    if (!HTTP_METHODS.has(method)) {
      throw new Error(`Unsupported HTTP method in API config: ${route.method}`);
    }

    if (typeof route.path !== "string" || !route.path.startsWith("/api/")) {
      throw new Error(`API path must start with /api/: ${route.path}`);
    }

    const removedPathSyntax = LEGACY_PATH_SYNTAX.exec(route.path)?.[0];

    if (removedPathSyntax) {
      throw new Error(
        `API path uses route syntax removed in Express 5 ("${removedPathSyntax}") for ${routeKey}. Write optional segments as {/:name} and wildcards as *name.`
      );
    }

    if (typeof route.description !== "string" || !route.description.trim()) {
      throw new Error(`API description is required for ${routeKey}`);
    }

    if (
      route.requestSchema === null ||
      typeof route.requestSchema !== "object" ||
      Array.isArray(route.requestSchema)
    ) {
      throw new Error(`requestSchema is required for ${routeKey}`);
    }

    if (
      route.responseSchema === null ||
      typeof route.responseSchema !== "object" ||
      Array.isArray(route.responseSchema)
    ) {
      throw new Error(`responseSchema is required for ${routeKey}`);
    }

    if (!strategies.has(route.authType)) {
      throw new Error(`Unsupported authentication type for ${routeKey}: ${route.authType}`);
    }

    authorizationPolicies.normalize(route.authorizationPolicies, routeKey);

    if (
      route.deprecation === null ||
      typeof route.deprecation !== "object" ||
      Array.isArray(route.deprecation)
    ) {
      throw new Error(`deprecation config is required for ${routeKey}`);
    }

    normalizeApiLifecycle(route, versioning, routeKey);

    if (
      route.idempotency === null ||
      typeof route.idempotency !== "object" ||
      Array.isArray(route.idempotency)
    ) {
      throw new Error(`idempotency config is required for ${routeKey}`);
    }

    // 這條 route 要 idempotency，但整個 service 被停用了。靜默降級等於這條
    // route 以為自己防著重複提交，實際上沒有——比啟動不了嚴重得多。
    if (route.idempotency.enabled === true && !idempotency) {
      throw new Error(
        `${routeKey} declares idempotency, but the "idempotency" service is disabled by its static service.enabled flag. Enable it, or turn idempotency off on this route.`
      );
    }

    idempotency?.routeOptions(route.idempotency, routeKey);
    normalizeRouteLogging(route.logging, routeKey);

    if (!(handlers[route.handler] instanceof BaseRequestHandler)) {
      throw new Error(`Handler not found for ${routeKey}: ${route.handler}`);
    }

    const timeoutMs = Number(route.timeoutMs ?? defaultRequestTimeoutMs);

    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error(`Request timeout must be a positive integer for ${routeKey}`);
    }

    // 共享 store 靠租約在實例崩潰後解鎖那一列。租約若短於這條 route 可能的
    // 執行時間，原請求還在跑就會有別的實例接手同一件工作——idempotency 反過來
    // 造成重複執行。這是唯一能在啟動時擋下它的地方，因為只有這裡同時看得到
    // 每條 route 的 timeoutMs 與 service 的租約長度。
    if (
      route.idempotency.enabled === true &&
      timeoutMs >= idempotency.pendingLeaseMs
    ) {
      throw new Error(
        `${routeKey} has timeoutMs ${timeoutMs}, which is not shorter than idempotency.pendingLeaseMs (${idempotency.pendingLeaseMs}). A request could outlive its idempotency lease and be executed twice. Raise pendingLeaseMs, or lower this route's timeout.`
      );
    }

    // 會讀 body 的 route（上傳）是在 route timeout 開始計時之後才收 body 的，
    // 兩段時間重疊。socket 層的收取上限若比這條 route 的逾時短，Node 會先把
    // 連線切掉，這條 route 的 timeoutMs 就永遠到不了——症狀是「大檔案上傳偶爾
    // 失敗」，不會有任何東西指回設定檔。全域檢查擋不住這種 per-route 覆寫。
    if (timeoutMs > requestReceiveTimeoutMs) {
      throw new Error(
        `${routeKey} has timeoutMs ${timeoutMs}, which exceeds application.requestReceiveTimeoutMs (${requestReceiveTimeoutMs}). The socket-level receive timeout would cut the connection before this route's own timeout could fire. Raise requestReceiveTimeoutMs, or lower this route's timeout.`
      );
    }

    // Express 的 Router 預設 caseSensitive:false、strict:false，所以
    // /api/v1/Users 與 /api/v1/users、/api/v1/items 與 /api/v1/items/ 會匹配到
    // 同一層。用原始 path 查重的話兩條都通過驗證，但後註冊的那條永遠收不到
    // 請求——它宣告的 authType 與 authorizationPolicies 靜靜地失效，實際生效的
    // 是先註冊那條的策略。啟動日誌照樣印出兩條，沒有任何訊號指向這件事。
    const canonicalKey = `${method} ${route.path.toLowerCase().replace(/\/+$/, "")}`;

    if (configuredRoutes.has(canonicalKey)) {
      throw new Error(
        `Duplicate API config: ${routeKey}. Express matches paths case-insensitively and ignores a trailing slash, so this route would never receive a request—an earlier equivalent route would handle it, under its own authorization policies.`
      );
    }

    configuredRoutes.add(canonicalKey);
  }
}

export function createApiDispatcher({
  routes,
  handlers,
  strategies,
  validator,
  responseValidator,
  authorizationPolicies,
  versioning,
  idempotency,
  context,
  logger,
  time,
  fileTypes,
  apiUpload = normalizeApiUploadConfig(apiConfig.upload),
  defaultRequestTimeoutMs = Number(applicationConfig.requestTimeoutMs),
  requestReceiveTimeoutMs = Number(applicationConfig.requestReceiveTimeoutMs)
} = {}) {
  if (
    !strategies ||
    typeof strategies.has !== "function" ||
    typeof strategies.authenticate !== "function"
  ) {
    throw new TypeError("API dispatcher requires an authentication strategy registry");
  }

  const activeValidator = validator || new RequestValidator();
  const activeResponseValidator = responseValidator || new ResponseValidator();
  const activeAuthorizationPolicies =
    authorizationPolicies || createAuthorizationPolicyRegistry();
  const activeVersioning =
    versioning || normalizeApiVersioningConfig(apiConfig.versioning);
  const activeLogger = logger;

  if (
    !activeLogger ||
    ["info", "warn", "error"].some(
      (method) => typeof activeLogger[method] !== "function"
    )
  ) {
    throw new TypeError("API dispatcher requires a system logger");
  }

  if (!context || typeof context.update !== "function") {
    throw new TypeError("API dispatcher requires a request context service");
  }

  if (!time || typeof time.timestamp !== "function") {
    throw new TypeError("API dispatcher requires a time service");
  }

  validateApiConfig(
    routes,
    handlers,
    strategies,
    defaultRequestTimeoutMs,
    activeAuthorizationPolicies,
    activeVersioning,
    idempotency,
    requestReceiveTimeoutMs
  );

  const router = Router();
  const registeredApis = [];
  // 一個閘門，所有 route 共用——每條 route 各自一個等於沒有全域上限。
  const uploadGate = new UploadConcurrencyGate({
    maxConcurrentUploads: apiUpload.maxConcurrentUploads
  });

  for (const route of routes) {
    const method = route.method.toLowerCase();
    const handler = handlers[route.handler];
    const routeKey = `${method} ${route.path}`;
    const timeoutMs = Number(route.timeoutMs ?? defaultRequestTimeoutMs);
    const lifecycle = normalizeApiLifecycle(route, activeVersioning, routeKey);
    const policies = activeAuthorizationPolicies.normalize(
      route.authorizationPolicies,
      routeKey
    );
    const routeIdempotency =
      idempotency?.routeOptions(route.idempotency, routeKey) ??
      DISABLED_ROUTE_IDEMPOTENCY;
    const logging = normalizeRouteLogging(route.logging, routeKey);
    const upload = route.upload
      ? normalizeUploadConfig(route.upload, `upload config for ${routeKey}`, fileTypes)
      : null;
    const download = normalizeDownloadConfig(
      route.download || {},
      `download config for ${routeKey}`
    );
    const uploadMiddleware = upload?.enabled
      ? createUploadMiddleware({
          config: upload,
          logger: activeLogger,
          fileTypes,
          gate: uploadGate
        })
      : null;
    const validateRequest = activeValidator.compile(route.requestSchema, routeKey);
    const validateResponse = activeResponseValidator.compile(
      route.responseSchema,
      routeKey
    );
    const registeredApi = {
      method: route.method,
      path: route.path,
      description: route.description,
      authType: route.authType,
      authorizationPolicies: policies,
      handler: route.handler,
      version: lifecycle.version,
      deprecation: lifecycle,
      idempotency: routeIdempotency,
      logging,
      upload: upload?.enabled
        ? Object.freeze({
            enabled: true,
            maxFileSizeBytes: upload.maxFileSizeBytes,
            maxFiles: upload.maxFiles,
            maxFieldCount: upload.maxFieldCount,
            maxFieldSizeBytes: upload.maxFieldSizeBytes,
            maxTotalFileBytes: upload.maxTotalFileBytes,
            maxRequestBytes: upload.maxRequestBytes,
            allowedMimeTypes: upload.allowedMimeTypes
          })
        : Object.freeze({ enabled: false }),
      download,
      timeoutMs,
      requestSchemaLocations: Object.keys(route.requestSchema),
      responseStatusCodes: Object.keys(route.responseSchema)
    };

    registeredApis.push(registeredApi);

    void activeLogger.info("api.registered", "API route registered", registeredApi);

    router[method](
      route.path,
      (req, _res, next) => {
        req.apiRoute = registeredApi;
        req.validateResponse = validateResponse;
        context.update({ apiRoute: registeredApi });
        next();
      },
      createApiLifecycleMiddleware({
        lifecycle,
        config: activeVersioning,
        logger: activeLogger
      }),
      createRequestTimeoutMiddleware({
        timeoutMs,
        logger: activeLogger,
        context,
        time
      }),
      async (req, res, next) => {
        markRequestProcessingStarted(req);

        try {
          req.auth = await strategies.authenticate(route.authType, req);
          context.update({ auth: req.auth });
          await activeAuthorizationPolicies.authorize(
            policies,
            req,
            registeredApi
          );
          context.update({ authorizationPolicies: policies });

          // 上傳解析刻意排在認證與授權之後：先驗證身分，未通過的請求連
          // multipart body 都不會被讀取，避免匿名流量佔用解析與磁碟資源。
          // 解析後表單的文字欄位會進 req.body，接著才做 schema 驗證。
          if (uploadMiddleware) {
            await new Promise((resolve, reject) => {
              uploadMiddleware(req, res, (error) =>
                error ? reject(error) : resolve()
              );
            });
          }

          validateRequest(req);
          // service 缺席時 routeIdempotency.enabled 必為 false——宣告了
          // idempotency 的 route 在 validateApiConfig 就已經擋下啟動。
          if (routeIdempotency.enabled) {
            await idempotency.execute(req, res, routeIdempotency, () =>
              handler.handle(req, res, next)
            );
          } else {
            await handler.handle(req, res, next);
          }

          // 重播回傳的是上一次的回應，handler 根本沒有執行，所以這次帶上來的
          // 檔案不會被任何東西引用。
          if (req.idempotentReplay) {
            await cleanupUploadedFiles(req, activeLogger, "idempotent_replay");
          }
        } catch (error) {
          // 驗證失敗與 handler 拋錯都發生在檔案落盤之後。沒有這一步，每一個
          // 失敗的上傳請求都會在磁碟上留下一個永遠不會被清掉的檔案。
          await cleanupUploadedFiles(req, activeLogger, error.code || error.name);

          // 逾時中斷一個進行中的下載，串流會以 ERR_STREAM_PREMATURE_CLOSE
          // 收場。那不是新的故障——逾時本身已經記錄過了——而且回應早就送出
          // 一半，改不成錯誤回應。往下丟只會讓 express 的 finalhandler 再把
          // 同一件事印一次。
          if (
            req.requestTimeout?.signal?.aborted &&
            (res.writableEnded || res.destroyed || res.headersSent)
          ) {
            return;
          }

          next(error);
        } finally {
          markRequestProcessingCompleted(req);
        }
      }
    );
  }

  void activeLogger.info("api.registration.completed", "API registration completed", {
    registeredApiCount: registeredApis.length,
    registeredApis
  });

  // 上傳的記憶體上界是「同時解析數 × 單一請求的位元組上限」，而那兩個數字先前
  // 分別住在全域設定與各 handler 的 static api.upload 裡，乘積不在任何地方，
  // 也沒有任何人被要求看過它。實測 100 個並行 10MB 上傳是 1088 MB RSS，而且
  // 那些位元組是 Buffer、落在 V8 堆之外——--max-old-space-size 擋不住，程序
  // 只會被 OOM killer 殺掉，沒有例外也沒有堆疊。
  //
  // 所以這裡把乘積算出來，對著 maxUploadMemoryBytes 檢查，再寫進啟動日誌。
  // 乘積本身一直是被強制的（gate 管併發數，每條 route 的 maxRequestBytes 管
  // 單一請求），缺的一直是「這台機器負擔不負擔得起」這個判斷。
  const uploadApis = registeredApis.filter(({ upload }) => upload.enabled);

  if (uploadApis.length > 0) {
    const largestRequestBytes = Math.max(
      ...uploadApis.map(({ upload }) => upload.maxRequestBytes)
    );
    const worstCaseBytes = apiUpload.maxConcurrentUploads * largestRequestBytes;

    // 光是把數字印出來擋不住任何事——設定得離譜的實例照樣啟動，然後在負載下
    // 被 OOM killer 殺掉。這裡把它變成啟動檢查，與這個檔案裡其他守衛同一個
    // 形狀：設定不可行就別啟動。
    if (worstCaseBytes > apiUpload.maxUploadMemoryBytes) {
      throw new Error(
        `Upload configuration allows ${worstCaseBytes} bytes of concurrent buffering (maxConcurrentUploads ${apiUpload.maxConcurrentUploads} × largest maxRequestBytes ${largestRequestBytes}), which exceeds api.upload.maxUploadMemoryBytes (${apiUpload.maxUploadMemoryBytes}). These Buffers live outside the V8 heap, so the process would be OOM-killed without an exception or a stack. Lower maxConcurrentUploads or the route's maxRequestBytes, or raise maxUploadMemoryBytes to match the memory this instance actually has.`
      );
    }

    void activeLogger.info(
      "api.upload_budget",
      "Upload memory budget",
      {
        maxConcurrentUploads: apiUpload.maxConcurrentUploads,
        largestRequestBytes,
        worstCaseBytes,
        maxUploadMemoryBytes: apiUpload.maxUploadMemoryBytes,
        note: "Uploads are buffered in memory until they are verified, so this is the worst-case sustained size. Assembling each file briefly costs twice its size, so short peaks above this number are expected. These Buffers live outside the V8 heap, so --max-old-space-size does not bound them.",
        apis: uploadApis.map(({ method, path, upload }) => ({
          api: `${method.toLowerCase()} ${path}`,
          maxRequestBytes: upload.maxRequestBytes,
          maxTotalFileBytes: upload.maxTotalFileBytes
        }))
      }
    );
  }

  // 未認證請求的 idempotency scope 只能靠 client IP 區分。IP 一旦不可信——
  // 部署在反向代理後面卻沒設 trustProxy 是最常見的情形——所有使用者會共用同一
  // 個 scope：同一個 key 配上不同輸入互相撞成 409，配上完全相同的輸入則會拿到
  // 別人的回應。這個組合本身沒有錯，但它對 IP 正確性的依賴應該在部署前就看得見。
  const publicIdempotentApis = registeredApis
    .filter(({ authType, idempotency }) => authType === "public" && idempotency.enabled)
    .map(({ method, path }) => `${method} ${path}`);

  if (publicIdempotentApis.length > 0) {
    void activeLogger.warn(
      "api.public_idempotency_registered",
      "Unauthenticated routes use client IP as their idempotency scope",
      {
        apis: publicIdempotentApis,
        impact:
          "Every caller sharing a client IP shares one idempotency key namespace",
        resolution:
          "Confirm TRUST_PROXY matches the deployment so req.ip identifies the caller, or require authentication on these routes"
      }
    );
  }

  router.use("/api", (req, res) => {
    void activeLogger.warn("api.not_registered", "Unregistered API request blocked", {
      requestId: req.requestId || null,
      method: req.method,
      url: req.originalUrl || req.url
    });

    sendError(res, {
      statusCode: 401,
      code: "Unauthorized Access",
      message: "Unauthorized Access",
      time
    });
  });

  return router;
}
