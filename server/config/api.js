const apiConfig = {
  // 大部分 API 共用的 route 預設配置。Handler 的 static api 可按需要覆蓋。
  defaults: {
    // API 沒有指定身份認證方式時預設要求 JWT，避免遺漏配置令接口意外公開。
    authType: "jwt",

    // API 沒有指定授權策略時，預設要求請求已通過 JWT 身份認證。
    // Handler 提供 authorizationPolicies 時會整個取代此 Array。
    authorizationPolicies: [
      {
        name: "authenticated",
        options: {}
      }
    ],

    // API 預設為仍在使用。Handler 只需提供要覆蓋的棄用欄位。
    deprecation: {
      deprecated: false,
      deprecatedAt: null,
      sunsetAt: null,
      replacement: null
    },

    // API 預設不啟用 Idempotency。需要避免重複提交的接口必須明確啟用。
    idempotency: {
      enabled: false,
      ttlMs: null
    },

    // API 預設不記錄 request／response body。需要完整 body 的接口可設為 "full"，
    // 但要先確認該接口不會經手個資。HTTP >= 400 的回應不受此設定影響，
    // 一律完整記錄；檔案上下傳則一律不記錄。詳見 config/logging.js。
    logging: {
      bodyCapture: "none"
    },

    // 檔案上傳。預設關閉，需要的 API 必須在 Handler 的 static api.upload 明確啟用。
    // 所有欄位都可在 Handler 內個別覆蓋。
    upload: {
      // 是否接受 multipart/form-data。啟用後該 route 不再解析 JSON body，
      // 表單的文字欄位會放進 req.body，檔案放進 req.files。
      enabled: false,

      // 檔案落盤目錄。相對路徑以 server 目錄為基準，不存在時自動建立。
      directory: "storage/uploads",

      // 單一檔案大小上限（bytes）。校驗在串流階段進行，超限即中止，
      // 不會把超出的內容收進記憶體或寫入磁碟。
      maxFileSizeBytes: 10485760,

      // 單一請求最多接受的檔案數。
      maxFiles: 1,

      // 表單文字欄位數量上限。
      maxFieldCount: 20,

      // 允許的檔案型別。框架會同時比對「客戶端宣告的 MIME、副檔名、檔案實際
      // 內容的簽章」三者，任何一項不符即拒絕——只比對前兩者等於沒有校驗。
      // 因此只接受框架能做內容比對的型別，清單見 framework/upload/fileSignatures.js。
      allowedMimeTypes: [
        "application/pdf",
        "image/png",
        "image/jpeg",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      ],

      // 落盤檔案與目錄的權限，預設只有擁有者可存取。
      fileMode: 0o600,
      directoryMode: 0o700
    },

    // 檔案下載。啟用後該 route 的 handler 可以回傳 this.file(...)，
    // 回應不套用統一 JSON 信封，也不執行 responseSchema 驗證。
    download: {
      enabled: false
    },

    // null 表示沿用 application.js 的全域 requestTimeoutMs。
    timeoutMs: null
  },

  // API path versioning 及 response version header 的全域配置。
  versioning: {
    // 是否要求所有已註冊 API 使用 /api/<version>/... 路徑格式。
    enabled: true,

    // Handler 沒有指定 version 時使用的版本，也是新增 API 的建議版本。
    defaultVersion: "v1",

    // 框架允許註冊的版本。移除舊版本前應完成 deprecation/sunset 流程。
    supportedVersions: ["v1"],

    // 每個 API response 用來顯示實際命中版本的 header 名稱。
    responseHeaderName: "API-Version"
  },

  // Idempotency middleware、key 規則及 store 的全域配置。
  idempotency: {
    // 是否啟用框架 Idempotency 服務；每條 route 仍需在 static api 明確啟用。
    enabled: true,

    // 客戶端提供 idempotency key 的 HTTP header 名稱。
    headerName: "Idempotency-Key",

    // 接受的 key 最大字元數，避免惡意 key 令共享 store 及日誌無限增長。
    maxKeyLength: 128,

    // Handler 沒有指定 ttlMs 時，已完成 response 在 store 保存的毫秒數。
    defaultTtlMs: 86400000,

    // 可以被保存及重播的 HTTP status code；錯誤 response 預設不會快取。
    cacheableStatusCodes: [200, 201, 202, 204],

    // memory 只適合單一 instance；多實例部署應注入共享原子 adapter。
    storeAdapter: "memory",

    // 共享 store key 前綴，避免不同應用使用同一資料庫時互相覆蓋。
    storeKeyPrefix: "erp-api:idempotency",

    // Memory adapter 最多保留的 entry 數量。
    memoryMaxEntries: 10000
  }
};

export default apiConfig;
