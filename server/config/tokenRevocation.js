/**
 * JWT 撤銷的全域配置。
 *
 * 撤銷以「版本號」表示：一個使用者一列，記著一個單調遞增的計數器，token 帶著
 * 簽發當下的 ver，比目前版本舊就是已撤銷。每個實例把整張表載入記憶體，請求
 * 路徑只查記憶體不查資料庫。
 *
 * 版本表永久保留（一個使用者一列，不隨撤銷次數增長），所以沒有保留期設定，也
 * 沒有清理工作——上一版的時間切線兩者都需要，而保留期設得比 token 壽命短會讓
 * 已撤銷的 token 復活。
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

  // 容許本機時鐘與資料庫時鐘相差多少秒，超過就在刷新時記一筆 error。
  //
  // 撤銷本身已經不看時鐘——版本號的比較兩邊都不是時間。但 token 的 iat 與 exp
  // 仍然由簽發那台機器的時鐘決定，而驗證是在另一台機器上、只帶
  // jwt.clockToleranceSeconds 的容忍。一台快五分鐘的機器簽出來的 token 在每一
  // 台機器上都多活五分鐘，慢的那台簽出來的則會被提早當成過期。
  //
  // 只記錄，不補償：時鐘該由 NTP 修，不該由應用層猜著補。設成 0 代表每次刷新
  // 都要求兩個時鐘完全一致，適合單機或本來就同源的部署。
  maxClockSkewSeconds: 60,

  // 快照的列數上限，同時也是記憶體預算：載入時查詢帶 LIMIT maxCachedSubjects
  // + 1，超過就整次載入失敗（啟動時是啟動失敗，刷新時是 fail open + 沿用
  // 既有的 maxFailOpenSeconds 熔斷），不會把超出預算的部分讀進記憶體。
  //
  // 版本表本來就有界（一個使用者一列），異常增長代表有人在濫用撤銷接口或
  // subject 取值有問題。調高這個值之前先確認行程的 heap 有沒有餘裕——
  // 100000 約對應 25MB，這個比例可以拿來換算。
  maxCachedSubjects: 100000
};

export default tokenRevocationConfig;
