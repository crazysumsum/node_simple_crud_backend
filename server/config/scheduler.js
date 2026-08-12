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

  // 排程統計的發佈。每個實例週期性地把自己的統計寫進 fr_job_stats，並輸出一
  // 筆彙總日誌。
  //
  // 這裡沒有 enabled：發佈統計是 job.schedulerStatsFlush 這個 service 在做，
  // 要關掉它就把那個 service 的 static service.enabled 設成 false。發佈頻率也
  // 不在這裡，它就是那件工作的 intervalMs，用下面的 jobs 覆寫即可。
  stats: {
    // 這個實例的對外位址，純粹是給人看的附註。一台機器有多張網卡、容器裡拿到
    // 的又通常是無意義的臨時位址，所以框架不去猜——沒設就留空，識別本來就是
    // 由 instance_id（= 租約的 owner）負責的。
    address: process.env.APP_INSTANCE_ADDRESS || "",

    // 一列連續幾輪沒有更新就視為死掉的實例並刪除。用「輪數」而不是毫秒，是
    // 為了讓它跟著 scheduler.statsFlush 的 intervalMs 一起變——寫死毫秒的話，
    // 有人把間隔調成一小時就會讓活著的實例被自己的清理刪掉。
    staleAfterRuns: 3,

    // 一件工作連續失敗幾次就把彙總日誌升級成 error。表本身不會叫醒任何人，
    // 這一行才會。
    consecutiveFailureAlertThreshold: 3
  },

  // 依工作名稱覆寫。部署時要調整頻率或關掉某件工作，不必改程式碼。
  // 可覆寫的欄位：enabled、intervalMs、timeoutMs。
  jobs: {
    // "report.monthly": { enabled: false },

    // JWT 撤銷的刷新間隔。調大它等於延後撤銷生效的時間，所以啟動時會與
    // config/tokenRevocation.js 的 maxStalenessSeconds 交叉檢查——超過那個
    // 保證就直接啟動失敗，不會靜默地放寬安全承諾。
    // "tokenRevocation.refresh": { intervalMs: 5000 }
  }
};

export default schedulerConfig;
