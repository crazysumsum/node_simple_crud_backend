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
      //
      // 上限 100MB：校驗需要完整內容（OLE2 的目錄扇區與 OOXML 的
      // [Content_Types].xml 都可能落在檔案尾端），所以每個進行中的檔案都完整
      // 佔著記憶體。要支援更大的檔案得改成串流落盤，而那需要連比對器的介面
      // 一起改成分塊掃描，不是調大這個數字就行。
      maxFileSizeBytes: 10485760,

      // 單一請求最多接受的檔案數。上限 20，理由與上面相同：它們相乘。
      maxFiles: 1,

      // 表單文字欄位數量上限。
      maxFieldCount: 20,

      // 單一表單文字欄位的大小上限（bytes）。超限的欄位會讓整個請求被拒絕，
      // 而不是靜默截斷。maxFieldCount × maxFieldSizeBytes 決定了檔案以外
      // 的請求體上限，調高前請一併考慮這個乘積。
      maxFieldSizeBytes: 65536,

      // 單一請求的檔案總量上限（bytes）。null 代表 maxFiles × maxFileSizeBytes。
      //
      // 需要它是因為單檔上限限制不住總和：maxFiles 個檔案各自都剛好貼著
      // maxFileSizeBytes 是完全合法的請求。
      maxTotalFileBytes: null,

      // 單一請求的位元組總量上限，檔案與文字欄位都算在內。
      // null 代表 maxTotalFileBytes + maxFieldCount × maxFieldSizeBytes。
      //
      // 這是唯一一個不必自己做乘法就讀得懂的數字，也是唯一能在 Content-Length
      // 階段、還沒讀進任何位元組之前就擋下請求的一個。
      maxRequestBytes: null,

      // 允許的檔案型別。框架會同時比對「客戶端宣告的 MIME、副檔名、檔案實際
      // 內容的簽章」三者，任何一項不符即拒絕——只比對前兩者等於沒有校驗。
      // 因此只接受已在 FileTypeService 註冊的型別；要新增型別請在
      // src/services/filetype/FileTypeService.js 的 registerCustomTypes() 內註冊。
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

    // 檔案下載。啟用後該 route 的 handler 可以回傳 this.file(...)，回應不套用
    // 統一 JSON 信封，也不執行 responseSchema 驗證。磁碟 path response 必須在
    // route 另設 root，且 handler 只能回傳相對於該 root 的路徑；buffer／stream
    // response 不需要 root。
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

  // 全域的上傳限制。這一節不屬於任何一條 route，因為它限制的是整個程序。
  upload: {
    // 同時解析中的上傳數上限，跨所有 route 共用。滿載時回 503 與 Retry-After。
    //
    // 上傳在校驗通過之前完整累積在記憶體裡，所以這個數字乘上單一請求的
    // maxRequestBytes 就是這個程序的上傳記憶體上界。啟動時會把乘積寫進
    // api.upload_budget 這筆日誌，並與下面的 maxUploadMemoryBytes 比對。
    //
    // 滿載時不排隊是刻意的：排隊會讓客戶端握著連線慢慢傳，而佔住槽位正是這裡
    // 要防的事。限流器的佇列之所以安全，是因為排隊中的請求還沒開始解析、
    // 手上沒有任何 buffer。
    maxConcurrentUploads: 10,

    // 這個實例願意花在上傳緩衝上的記憶體上限（bytes）。
    //
    // 上面那個乘積是真的被強制的，但先前沒有任何東西檢查它是否負擔得起：
    // maxConcurrentUploads: 500 配 100MB 的 route 會安靜地啟動，日誌印出 50GB，
    // 然後在負載下被 OOM killer 殺掉——那些位元組是 Buffer，落在 V8 堆之外，
    // --max-old-space-size 擋不住，不會有例外也不會有堆疊。
    //
    // 啟動時若乘積超過這個數字就拒絕啟動。調整時請對著容器的記憶體上限來設，
    // 並留出應用程式本身的用量。
    maxUploadMemoryBytes: 268435456
  }
};

export default apiConfig;
