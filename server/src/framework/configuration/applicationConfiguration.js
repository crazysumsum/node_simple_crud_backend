import { getHeapStatistics } from "node:v8";
import applicationConfig from "../../../config/application.js";
import apiConfig from "../../../config/api.js";
import databaseConfig from "../../../config/database.js";
import idempotencyConfig from "../../../config/idempotency.js";
import jwtConfig from "../../../config/jwt.js";
import loggingConfig from "../../../config/logging.js";
import requestConfig from "../../../config/request.js";
import requestLimiterConfig from "../../../config/requestLimiter.js";
import schedulerConfig from "../../../config/scheduler.js";
import securityConfig from "../../../config/security.js";
import tokenRevocationConfig from "../../../config/tokenRevocation.js";
import { normalizeLoggingConfig } from "../../services/logging/normalizeLoggingConfig.js";
import { normalizeSecurityConfig } from "../security/normalizeSecurityConfig.js";
import { normalizeApiConfig } from "../api/normalizeApiConfig.js";
import { ConfigurationError } from "./ConfigurationError.js";
import { normalizeApplicationConfig } from "./normalizeApplicationConfig.js";
import { normalizeDatabaseConfig } from "./normalizeDatabaseConfig.js";
import { normalizeIdempotencyConfig } from "../../services/idempotency/normalizeIdempotencyConfig.js";
import { normalizeJwtConfig } from "./normalizeJwtConfig.js";
import { normalizeRequestConfig } from "./normalizeRequestConfig.js";
import { normalizeRequestLimiterConfig } from "../../services/requestLimiter/normalizeRequestLimiterConfig.js";
import { normalizeSchedulerConfig } from "../../services/scheduler/normalizeSchedulerConfig.js";
import { normalizeTokenRevocationConfig } from "../../services/tokenRevocation/normalizeTokenRevocationConfig.js";
import { JOB_NAME as REVOCATION_REFRESH_JOB } from "../../services/tokenRevocation/jobs/TokenRevocationRefreshJob.js";

export function defaultConfigurationSource() {
  return {
    application: applicationConfig,
    api: apiConfig,
    database: databaseConfig,
    idempotency: idempotencyConfig,
    jwt: jwtConfig,
    logging: loggingConfig,
    request: requestConfig,
    requestLimiter: requestLimiterConfig,
    scheduler: schedulerConfig,
    security: securityConfig,
    tokenRevocation: tokenRevocationConfig
  };
}

/**
 * 每筆排隊日誌在 maxQueuedBytes 之外的固定開銷：Buffer 物件、promise、以及
 * 掛在序列化佇列上的 closure。實測 517B（20000 筆最小條目），取 600B 留邊。
 * 這部分不在條目的位元組計價內，所以估算最壞情況時要另外加回去。
 */
const QUEUE_ENTRY_OVERHEAD_BYTES = 600;

/**
 * 日誌佇列可以佔用的 heap 比例。
 *
 * 佇列是純粹的額外開銷——連線池、限流器的 key 空間、正在處理的 request body
 * 全都要用同一個 heap，而日誌堆積得最兇的時候，正是這些東西也吃緊的時候。
 * 刻意不做成設定項：可調的安全邊界最後都會被調成 100%。
 */
const MAX_LOG_QUEUE_HEAP_SHARE = 0.25;

export function validateApplicationConfiguration(
  source = defaultConfigurationSource(),
  {
    environment = process.env.NODE_ENV || "development",
    heapLimitBytes = getHeapStatistics().heap_size_limit
  } = {}
) {
  const details = [];
  const normalized = {};
  const validateSection = (section, validator) => {
    try {
      normalized[section] = validator();
    } catch (error) {
      details.push({ section, message: error.message });
    }
  };

  validateSection("application", () =>
    normalizeApplicationConfig(source?.application)
  );
  validateSection("api", () => normalizeApiConfig(source?.api));
  validateSection("database", () => normalizeDatabaseConfig(source?.database));
  validateSection("idempotency", () =>
    normalizeIdempotencyConfig(source?.idempotency)
  );
  validateSection("jwt", () => normalizeJwtConfig(source?.jwt));
  validateSection("logging", () => normalizeLoggingConfig(source?.logging));
  validateSection("request", () =>
    normalizeRequestConfig(source?.request, { environment })
  );
  validateSection("requestLimiter", () =>
    normalizeRequestLimiterConfig(source?.requestLimiter)
  );
  validateSection("scheduler", () => normalizeSchedulerConfig(source?.scheduler));
  validateSection("security", () => normalizeSecurityConfig(source?.security));
  validateSection("tokenRevocation", () =>
    normalizeTokenRevocationConfig(source?.tokenRevocation)
  );

  if (details.length > 0) {
    throw new ConfigurationError(details);
  }

  crossSectionChecks(normalized, details, { heapLimitBytes });

  if (details.length > 0) {
    throw new ConfigurationError(details);
  }

  return Object.freeze(normalized);
}

/**
 * 跨設定檔的關係。每個 section 自己都合法，湊在一起卻不成立的那些。
 *
 * 這些關係沒有執行期症狀，所以只能擋在啟動：值排錯了不會報錯，只會讓某一段
 * 沒有上限、或讓某個設定值從此是一句空話。
 */
function crossSectionChecks(normalized, details, { heapLimitBytes }) {
  const { application, database, jwt, logging, requestLimiter, scheduler, tokenRevocation } =
    normalized;

  checkLogQueueBudget(logging, heapLimitBytes, details);
  checkRevocationRetention(jwt, tokenRevocation, details);
  checkRevocationRefreshScheduled(scheduler, details);

  if (!application || !database) {
    return;
  }

  // DB 那一側必須先於 route 逾時放棄，而且是帶著清理動作放棄的。反過來的話
  // route 逾時先到，回了 504 也釋放了限流槽位，但被放棄的連線等待者還在
  // mysql2 的隊列裡，吊著整個已經回應完畢的請求——這正是隊列會無上限累積的
  // 原因。
  const databaseBudgetMs = database.acquireTimeoutMs + database.queryTimeoutMs;

  if (databaseBudgetMs >= application.requestTimeoutMs) {
    details.push({
      section: "database",
      message:
        `"acquireTimeoutMs" (${database.acquireTimeoutMs}ms) plus "queryTimeoutMs" ` +
        `(${database.queryTimeoutMs}ms) must be shorter than application.requestTimeoutMs ` +
        `(${application.requestTimeoutMs}ms), so the database gives up first and cleans up ` +
        "its connection instead of leaving an abandoned waiter in the pool queue."
    });
  }

  // 同一條規則的交易版本。交易走的是自己的 transactionTimeoutMs，不受
  // queryTimeoutMs 約束，所以上面那一條完全蓋不到它——出廠設定曾經是
  // 5000 + 30000 > 30000，交易的期限比 route 的還晚到五秒。
  const transactionBudgetMs =
    database.acquireTimeoutMs + database.transactionTimeoutMs;

  if (transactionBudgetMs >= application.requestTimeoutMs) {
    details.push({
      section: "database",
      message:
        `"acquireTimeoutMs" (${database.acquireTimeoutMs}ms) plus "transactionTimeoutMs" ` +
        `(${database.transactionTimeoutMs}ms) must be shorter than application.requestTimeoutMs ` +
        `(${application.requestTimeoutMs}ms), or the route answers 504 while the transaction ` +
        "is still holding its connection."
    });
  }

  if (!requestLimiter) {
    return;
  }

  // 一個請求同一時間最多佔一個連線等待者。隊列容不下滿載的並行請求數，正常
  // 滿載時就會開始回 503——那不是背壓，是設定錯誤。
  const worstCaseWaiters =
    requestLimiter.maxConcurrentRequests - database.connectionLimit;

  // 寬限期是「handler 已經超過期限之後，還願意等它多久才當成洩漏」。它比整個
  // 請求的預算還長的話，每一筆被放棄的請求都要多等一個完整的請求週期才會被
  // 計數與記錄——洩漏偵測遲到得比洩漏本身還久，等於沒有。
  if (requestLimiter.abandonGraceMs >= application.requestTimeoutMs) {
    details.push({
      section: "requestLimiter",
      message:
        `"abandonGraceMs" (${requestLimiter.abandonGraceMs}ms) must be shorter than ` +
        `application.requestTimeoutMs (${application.requestTimeoutMs}ms), or a leaked ` +
        "handler is reported later than it took to give up on the request."
    });
  }

  if (database.queueLimit < worstCaseWaiters) {
    details.push({
      section: "database",
      message:
        `"queueLimit" (${database.queueLimit}) must be at least ` +
        `requestLimiter.maxConcurrentRequests (${requestLimiter.maxConcurrentRequests}) ` +
        `minus "connectionLimit" (${database.connectionLimit}) = ${worstCaseWaiters}, ` +
        "or the pool starts rejecting queries at ordinary full load."
    });
  }
}

/**
 * 撤銷切線的保留期，蓋不蓋得過最長的 token 壽命。
 *
 * 清理工作刪的是 revoked_before < now - retentionSeconds 的列。保留期比 token
 * 壽命短的話，那一列被刪掉時仍然有活著的 token 早於它——已撤銷的 token 重新
 * 有效，而且兩邊各自都在做對的事，不會有任何錯誤浮現。實測 30d 的 token 配
 * 出廠的 7d 保留期，被撤銷的 token 會復活 23 天。
 *
 * 這條關係跨兩個設定檔（config/jwt.js 與 config/tokenRevocation.js），任一邊
 * 單獨看都合法，所以只能擋在啟動。
 */
function checkRevocationRetention(jwt, tokenRevocation, details) {
  if (!jwt || !tokenRevocation) {
    return;
  }

  // iat 來自簽發節點的時鐘、切線來自資料庫時鐘，exp 的驗證還另外帶
  // clockTolerance。邊界要把兩種誤差都算進去，否則剛好卡在邊緣的那一批仍然
  // 會復活。
  const requiredSeconds =
    jwt.expiresInSeconds +
    jwt.clockToleranceSeconds +
    tokenRevocation.maxClockSkewSeconds;

  if (tokenRevocation.retentionSeconds < requiredSeconds) {
    details.push({
      section: "tokenRevocation",
      message:
        `"retentionSeconds" (${tokenRevocation.retentionSeconds}s) must be at least ` +
        `jwt.expiresIn (${jwt.expiresIn} = ${jwt.expiresInSeconds}s) plus ` +
        `jwt.clockToleranceSeconds (${jwt.clockToleranceSeconds}s) plus ` +
        `"maxClockSkewSeconds" (${tokenRevocation.maxClockSkewSeconds}s) = ` +
        `${requiredSeconds}s, or the purge job deletes cut-lines while tokens issued ` +
        "before them are still alive, and revoked tokens become valid again."
    });
  }
}

/**
 * 有沒有人在刷新撤銷快照。
 *
 * 快照活在每個實例的記憶體裡，只有 tokenRevocation.refresh 這件工作會更新它。
 * 關掉它——不論是整個排程器還是單獨覆寫——啟動都照樣成功，然後：
 * failureMode "closed" 會在 maxFailOpenSeconds 之後讓每個帶 JWT 的請求變成
 * 503，一個排程設定造成的全站故障，而且延遲幾分鐘才出現，看起來完全不像設定
 * 問題；failureMode "open" 則是撤銷從啟動那一刻起永遠不再生效，更安靜。
 *
 * 兩種結局都不能接受，所以這裡不看 failureMode。代價是 JWT 認證還在用
 * tokenRevocation 時，scheduler.enabled = false 不再是一個可用的部署選項。
 */
function checkRevocationRefreshScheduled(scheduler, details) {
  if (!scheduler) {
    return;
  }

  const override = scheduler.jobs[REVOCATION_REFRESH_JOB];

  if (scheduler.enabled && override?.enabled !== false) {
    return;
  }

  details.push({
    section: "scheduler",
    message:
      `Job "${REVOCATION_REFRESH_JOB}" is disabled ("enabled" is ${scheduler.enabled} on the ` +
      `scheduler and ${override?.enabled} on the job). Nothing would refresh the JWT ` +
      "revocation snapshot: with tokenRevocation.failureMode \"closed\" every JWT request " +
      "answers 503 once the snapshot passes maxFailOpenSeconds, and with \"open\" revocation " +
      "silently stops applying. Re-enable the job, or stop using JWT authentication."
  });
}

/**
 * 所有 logger 的佇列加起來，塞不塞得進這個 heap。
 *
 * 每個 logger 自己的預算都合法，湊在一起卻可能超過整個程序有的記憶體，而這件
 * 事沒有執行期症狀——一切正常，直到磁碟慢下來的那一次，然後是 OOM。實測 64MB
 * heap 只要排到 400 筆 128KB 的日誌就死，而預設的 10000 筆上限離那裡還有 96%
 * 的空間，丟棄邏輯一次都不會觸發。
 */
function checkLogQueueBudget(logging, heapLimitBytes, details) {
  if (!logging) {
    return;
  }

  const profiles = Object.values(logging.loggers).filter(
    (profile) => profile.enabled
  );
  const worstCaseBytes = profiles.reduce(
    (total, profile) =>
      total +
      profile.maxQueuedBytes +
      profile.maxQueuedEntries * QUEUE_ENTRY_OVERHEAD_BYTES,
    0
  );
  const allowanceBytes = Math.floor(heapLimitBytes * MAX_LOG_QUEUE_HEAP_SHARE);

  if (worstCaseBytes > allowanceBytes) {
    details.push({
      section: "logging",
      message:
        `The log queues can hold ${megabytes(worstCaseBytes)}MB in the worst case ` +
        `(each logger's "maxQueuedBytes" plus "maxQueuedEntries" × ` +
        `${QUEUE_ENTRY_OVERHEAD_BYTES} bytes of per-entry overhead), which exceeds ` +
        `${MAX_LOG_QUEUE_HEAP_SHARE * 100}% of the V8 heap limit ` +
        `(${megabytes(allowanceBytes)}MB of ${megabytes(heapLimitBytes)}MB). Lower ` +
        '"maxQueuedBytes" or "maxQueuedEntries", or raise --max-old-space-size.'
    });
  }
}

function megabytes(bytes) {
  return Math.round(bytes / 1048576);
}
