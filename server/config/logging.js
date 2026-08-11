const loggingConfig = {
  // Logger 配置集合。每個 profile 都由同一個通用 Logger 負責寫入。
  // 可自由增加例如 audit、security 等 profile，框架啟動時會自動建立對應 service。
  loggers: {
    // 框架預設的 HTTP request／response logger。輸出使用通用五欄格式，
    // request／response 詳情只會放在 context 內。
    request: {
      // 是否啟用 HTTP 請求日誌。false 時不會收集請求資料或建立日誌檔案。
      enabled: true,

      // 日誌儲存目錄。相對路徑以 server 目錄為基準；目錄不存在時自動建立。
      directory: "logs",

      // 每日日誌檔案前綴，最終檔名為 <filePrefix>-YYYY-MM-DD.log。
      filePrefix: "requests",

      // 日誌保留天數，最後修改時間超過期限的檔案會被清除。
      retentionDays: 30,

      // 執行過期日誌檢查的最短間隔，單位為小時。
      cleanupIntervalHours: 24,

      // 每個日誌檔案最大容量，單位為 bytes；超過前會建立同日流水號檔案。
      maxFileSizeBytes: 10485760,

      // 等待寫入磁碟的日誌筆數上限。寫入是串行的，磁碟一慢就會堆積；
      // 超過此上限的日誌會被丟棄，以免為了記錄故障而把記憶體吃光。
      // 丟棄不是靜默的：下一筆成功寫入前會補上一筆 logging.entries_lost 統計。
      maxQueuedEntries: 10000,

      // 日誌檔與目錄的權限。預設只有擁有者可讀寫，因為日誌會保留 30 天，
      // 且在錯誤或 route 明確 opt-in 時含有完整 request／response body。
      // 若有以其他帳號執行的 log shipper 需要讀取，可放寬為 0o640 並同群組。
      // 啟動時也會把既有的同前綴日誌檔一併收緊。
      fileMode: 0o600,
      directoryMode: 0o700,

      // 最低記錄級別，可使用 debug、info、warn 或 error。
      // Request middleware 產生 info 級別日誌，因此通常設定為 info。
      minimumLevel: "info",

      // 成功請求是否記錄 request／response body。
      // "none"：不記錄（預設）。業務 body 裝的是身分證號、薪資、銀行帳號這類
      //   個資，而 redactedFields 是黑名單、只擋得住列舉得出的欄位名。
      // "full"：完整記錄，敏感欄位仍依 redactedFields 遮蔽。
      // 個別 API 可在 Handler 的 static api.logging.bodyCapture 覆蓋此預設值。
      bodyCapture: "none",

      // 回應狀態碼大於或等於此值時，一律完整記錄 body 以便重現問題，
      // 不受上面的 bodyCapture 或 route 設定影響。設為 null 可停用此行為。
      // 注意：400 代表驗證失敗的請求也會完整落盤，包含使用者填寫的個資。
      // 這是以除錯便利性換取的取捨；若不接受可改為 500 或 null。
      bodyCaptureErrorStatus: 400,

      // 需要遮蔽的敏感欄位名稱，不分英文字母大小寫比對。
      redactedFields: [
        "password",
        "newPassword",
        // system logger 一直有 secret，request logger 卻漏了。而 request log
        // 在狀態碼 >= 400 時一律完整記錄 body，任何名為 secret 的欄位會明文
        // 落進保留 30 天的檔案。
        "secret",
        "token",
        "accessToken",
        "refreshToken",
        "authorization",
        "cookie",
        "set-cookie"
      ]
    },

    // 框架預設的後台系統運行 logger。
    system: {
      // 是否啟用後台系統運行日誌。false 時不建立或寫入日誌檔案。
      enabled: true,

      // System log 儲存目錄。相對路徑以 server 目錄為基準；timestamp 及檔名
      // 日期一律使用 application.timeZone。
      directory: "logs/system",

      // 每日 system log 檔案前綴；輪替後會加入 -001、-002 等流水號。
      filePrefix: "system",

      // System log 保留天數，過期檔案會自動刪除。
      retentionDays: 30,

      // 執行過期檔案清理的最短間隔，單位為小時。
      cleanupIntervalHours: 24,

      // 每個 system log 檔案最大容量，單位為 bytes。
      maxFileSizeBytes: 10485760,

      // 等待寫入磁碟的日誌筆數上限，超過即丟棄並在恢復後補上統計。
      maxQueuedEntries: 10000,

      // 日誌檔與目錄的權限。預設只有擁有者可讀寫，因為日誌會保留 30 天，
      // 且在錯誤或 route 明確 opt-in 時含有完整 request／response body。
      // 若有以其他帳號執行的 log shipper 需要讀取，可放寬為 0o640 並同群組。
      // 啟動時也會把既有的同前綴日誌檔一併收緊。
      fileMode: 0o600,
      directoryMode: 0o700,

      // 最低記錄級別，可使用 debug、info、warn 或 error。
      // 例如設定為 warn 時，只會寫入 warn 及 error。
      minimumLevel: "info",

      // Context 中需要遮蔽的敏感欄位名稱，不分英文字母大小寫比對。
      redactedFields: [
        "password",
        "newPassword",
        "secret",
        "token",
        "accessToken",
        "refreshToken",
        "authorization",
        "cookie",
        "set-cookie"
      ]
    }
  }
};

export default loggingConfig;
