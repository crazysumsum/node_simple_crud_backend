/**
 * Request 生命週期的全域配置。
 *
 * 此文件只保存配置資料，不應加入 function 或執行任何初始化邏輯。
 * 個別 API 的 Schema 仍在 Handler 的 static api 中配置。
 */
const requestConfig = {
  // 系統層請求限流配置。
  limits: {
    // 是否啟用系統層請求限流。
    enabled: true,

    // 限流狀態儲存介面。memory 適用於單一實例；多實例可使用已註冊的共享 adapter。
    storeAdapter: "memory",

    // 共享限流儲存使用的 key 前綴，避免不同應用互相衝突。
    storeKeyPrefix: "erp-api:rate-limit",

    // 只對此路徑前綴下的請求套用限流。
    apiPathPrefix: "/api",

    // 單一應用實例同一時間最多可執行的請求數量。
    maxConcurrentRequests: 100,

    // 並行請求已滿時，最多容許排隊的請求數量。
    maxQueueSize: 200,

    // 排隊請求最長等待時間（毫秒）；超時後拒絕該請求。
    queueTimeoutMs: 30000,

    // 同一 client IP 在一個時間窗口內最多可接受的請求數量。
    maxRequestsPerIpPerWindow: 20,

    // IP 限流時間窗口長度（毫秒）。1000 代表每秒計算一次。
    ipWindowMs: 1000,

    // 被限流時，Retry-After header 建議客戶端等待的秒數。
    retryAfterSeconds: 1
  },

  // Request／Response Schema 驗證配置。
  validation: {
    // Request 輸入 Schema 驗證配置。
    input: {
      // 是否啟用 Request Schema 驗證。
      enabled: true,

      // 是否一次收集所有輸入錯誤；false 時遇到第一個錯誤便停止。
      allErrors: true,

      // 是否按 Schema 自動轉換基本資料類型，例如將 query string 的 "10" 轉為 number。
      coerceTypes: true,

      // 是否把 Schema 中定義的 default 值自動加入輸入資料。
      useDefaults: true,

      // 是否移除 Schema 未定義的額外欄位。false 代表依 additionalProperties 規則處理。
      removeAdditional: false,

      // 單次驗證最多保留的錯誤數量，避免錯誤 response 過大。
      maxErrors: 20,

      // 是否在統一錯誤 response 中包含欄位級驗證錯誤詳情。
      includeErrorDetailsInResponse: true
    },

    // Response 輸出 Schema 驗證配置。
    output: {
      // 是否啟用 Response Schema 驗證功能。
      enabled: true,

      // production 是否仍驗證輸出。保持啟用以確保所有環境都執行相同輸出契約。
      validateInProduction: true,

      // 是否一次收集所有輸出錯誤；false 時遇到第一個錯誤便停止。
      allErrors: true,

      // 單次驗證最多記錄的輸出錯誤數量，避免 system log 過大。
      maxErrors: 20
    }
  }
};

export default requestConfig;
