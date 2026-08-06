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

      // 日誌 timestamp 及檔名日期採用的 IANA 時區；timestamp 會包含 UTC offset。
      timeZone: "Asia/Hong_Kong",

      // 每個日誌檔案最大容量，單位為 bytes；超過前會建立同日流水號檔案。
      maxFileSizeBytes: 10485760,

      // 最低記錄級別，可使用 debug、info、warn 或 error。
      // Request middleware 產生 info 級別日誌，因此通常設定為 info。
      minimumLevel: "info",

      // 需要遮蔽的敏感欄位名稱，不分英文字母大小寫比對。
      redactedFields: [
        "password",
        "newPassword",
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

      // System log 儲存目錄。相對路徑以 server 目錄為基準。
      directory: "logs/system",

      // 每日 system log 檔案前綴；輪替後會加入 -001、-002 等流水號。
      filePrefix: "system",

      // System log 保留天數，過期檔案會自動刪除。
      retentionDays: 30,

      // 執行過期檔案清理的最短間隔，單位為小時。
      cleanupIntervalHours: 24,

      // 日誌 timestamp 及檔名日期使用的 IANA 時區；timestamp 會包含 UTC offset。
      timeZone: "Asia/Hong_Kong",

      // 每個 system log 檔案最大容量，單位為 bytes。
      maxFileSizeBytes: 10485760,

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
