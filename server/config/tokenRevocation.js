/**
 * JWT 撤銷的全域配置。
 *
 * 撤銷以「切線」表示：一個使用者一列，記下「這個時間點之前簽發的 token 全部
 * 作廢」。每個實例把整張表載入記憶體，請求路徑只查記憶體不查資料庫。
 *
 * 撤銷功能的開關由 TokenRevocationService 的 static service.enabled 決定，不在
 * 這裡。停用它會讓 auth.jwt 啟動失敗——JWT 認證從此需要這個 service。
 *
 * 此文件只保存配置資料，不應加入 function 或執行任何初始化邏輯。
 */
const tokenRevocationConfig = {
  // 撤銷最遲多久生效（秒）。這是安全 SLA 而不是實作細節：真正的刷新頻率寫在
  // config/scheduler.js 的 jobs["tokenRevocation.refresh"].intervalMs，啟動時
  // 會交叉檢查兩者，間隔大於這個保證就直接啟動失敗。
  maxStalenessSeconds: 60,

  // 切線比這個秒數還舊的列會被清理工作刪除。
  //
  // 必須大於最長的 token 壽命（config/jwt.js 的 expiresIn）。設得太短的話，
  // 列被刪掉時仍然可能有活著的 token 早於那條切線，已撤銷的 token 會復活。
  // 預設 7 天對應 2h 的 token 壽命，留了很大的餘裕。
  retentionSeconds: 7 * 24 * 60 * 60,

  // 快照的列數上限。超過時記 warn 並繼續載入——撤銷名單本來就有界（一個使用者
  // 一列），異常增長代表有人在濫用撤銷接口或 subject 取值有問題，那是要看見的
  // 訊號，但不是拒絕服務的理由。
  maxCachedSubjects: 100000
};

export default tokenRevocationConfig;
