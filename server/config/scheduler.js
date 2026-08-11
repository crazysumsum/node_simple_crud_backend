/**
 * 背景定時作業的全域配置。
 *
 * 每件工作本身宣告在提供它的 service 的 static jobs 上；這裡只放全域預設值，
 * 以及依名稱覆寫個別工作的部署層設定。此文件只保存配置資料，不應加入 function
 * 或執行任何初始化邏輯。
 */
const schedulerConfig = {
  // 是否啟用排程器。false 時不會註冊或執行任何工作，啟動日誌仍會列出被略過的
  // 工作清單，避免「背景工作為什麼沒跑」變成一個要翻原始碼的問題。
  enabled: true,

  // 工作沒有指定 timeoutMs 時的預設執行時限（毫秒）。逾時會透過 AbortSignal
  // 通知工作中止，並記錄一筆 warn；下一輪照常排程。
  defaultTimeoutMs: 30000,

  // scope: "cluster" 的工作在執行前必須取得租約，租約時長為
  // 該工作的 timeoutMs 加上這個緩衝（毫秒）。持有者若在執行途中崩潰，
  // 租約會在這段時間之後自然過期，讓其他實例得以接手。
  clusterLeaseGraceMs: 30000,

  // 每個實例首次執行前的隨機延遲上限，以 intervalMs 的比例表示。
  // 多實例同時啟動時，這能避免所有實例在同一毫秒一起打資料庫。
  // 設為 0 可關閉抖動，讓執行時間點可預測。
  startupJitterRatio: 0.2,

  // 依工作名稱覆寫。部署時要調整頻率或關掉某件工作，不必改程式碼。
  // 可覆寫的欄位：enabled、intervalMs、timeoutMs。
  jobs: {
    // "report.monthly": { enabled: false },
    // "tokenRevocation.refresh": { intervalMs: 5000 }
  }
};

export default schedulerConfig;
