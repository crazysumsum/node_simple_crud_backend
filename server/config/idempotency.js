/**
 * Idempotency 的全域配置。
 *
 * 功能的開關由 IdempotencyService 的 static service.enabled 決定，不在這裡；
 * 每條 route 仍需在自己的 static api.idempotency 明確啟用。停用整個 service
 * 之後，任何仍宣告 idempotency 的 route 都會讓應用啟動失敗——靜默失去
 * idempotency 保證比啟動不了嚴重得多。
 *
 * 此文件只保存配置資料，不應加入 function 或執行任何初始化邏輯。
 */
const idempotencyConfig = {
  // 客戶端提供 idempotency key 的 HTTP header 名稱。
  headerName: "Idempotency-Key",

  // 接受的 key 最大字元數，避免惡意 key 令共享 store 及日誌無限增長。
  maxKeyLength: 128,

  // Handler 沒有指定 ttlMs 時，已完成 response 可被重播的毫秒數。
  //
  // 這是「容量」與「重播窗口」的取捨：mysql adapter 沒有筆數上限，表的穩態
  // 大小約等於「啟用 idempotency 的請求速率 × 這個時間」。1 小時對應絕大多數
  // 客戶端的重試行為；調到一天請先算過表會長到多大。
  defaultTtlMs: 3600000,

  // 一筆處理中（pending）的 key 最多鎖住多久（毫秒）。
  //
  // 這是正確性參數，不是調校參數。實例在處理途中崩潰時，共享 store 裡的列不會
  // 隨程序消失，這個租約是它唯一的解鎖方式；但租約若短於一個請求可能的最長
  // 執行時間，原請求還在跑就會有別的實例接手同一件工作——那正是 idempotency
  // 要防的事。所以啟動時會強制檢查它大於 application.requestTimeoutMs，以及
  // 每一條啟用 idempotency 的 route 自己的 timeoutMs。
  pendingLeaseMs: 120000,

  // 可以被保存及重播的 HTTP status code；錯誤 response 預設不會快取。
  cacheableStatusCodes: [200, 201, 202, 204],

  // 共享 store 的實作。
  //
  // mysql 是預設值：memory adapter 的狀態在各自的行程裡，多實例部署下同一個
  // key 打到不同實例會各自認為自己是第一個，handler 執行多次——而那是負載
  // 平衡下的常態，不是邊緣情況。單一實例部署可以改回 memory 換取免去一次
  // 資料庫往返。
  storeAdapter: "mysql",

  // 共享 store key 前綴，避免不同應用使用同一資料庫時互相覆蓋。
  storeKeyPrefix: "erp-api:idempotency",

  // Memory adapter 最多保留的 entry 數量。mysql adapter 不使用這個值，
  // 它的大小由 defaultTtlMs 與清理工作決定。
  memoryMaxEntries: 10000,

  // 單筆已完成 response 允許保存的最大位元組數。
  //
  // 超過的回應不會被快取：該 key 直接釋放，重試會重新執行 handler。這是刻意
  // 的取捨——把一個異常大的回應寫進共享表，代價由所有實例一起承擔。
  maxResponseBytes: 1048576
};

export default idempotencyConfig;
