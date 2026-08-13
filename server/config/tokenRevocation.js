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

  // 刷新一直失敗時，舊快照最多還能用多久（秒）。
  //
  // 刷新失敗是 fail open——保留舊快照繼續服務，因為反過來會讓一次資料庫抖動
  // 變成全站登出。但那個判斷只對「抖動」成立。撤銷真正死掉的樣子是這張表單獨
  // 壞掉（migration 改名、權限被收走），此時其他 SQL 照常、/health 是綠的、
  // 每個 handler 都正常，而撤銷可以失效好幾個小時都沒人發現。
  //
  // 所以 fail open 要有時間盒。預設 300 搭配 30 秒的刷新間隔，代表容忍連續
  // 10 次失敗——抖動到不了，死掉一定到得了。必須 >= maxStalenessSeconds，
  // 否則正常運作時就會觸發，啟動時會擋下。
  maxFailOpenSeconds: 300,

  // 超過 maxFailOpenSeconds 之後怎麼辦：
  //
  //   "closed"  帶 JWT 的請求一律 503（public route 不受影響，登入與 /health
  //             照常，恢復手段不會被一起鎖掉）。撤銷不可能失守。
  //   "open"    維持放行，等同沒有上界。
  //
  // 預設 closed 是為了跟啟動時的立場一致：首載失敗已經是啟動失敗了，框架在
  // t=0 就說過「撤銷不能運作就不要服務」，執行期不該偷偷改口。
  //
  // 需要舊行為的話，把這裡設成 "open"。
  failureMode: "closed",

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
