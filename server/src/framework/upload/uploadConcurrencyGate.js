/**
 * 全域的同時解析上傳數上限。
 *
 * 上傳在校驗通過之前完整累積在記憶體裡，所以一個實例的上傳記憶體是
 * 「同時解析數 × 每個請求的位元組上限」。這兩個數字先前分別住在
 * config/requestLimiter.js 與各 handler 的 static api.upload 裡，乘積不在任何
 * 地方——實測 100 個並行 10MB 上傳是 1088 MB RSS，而且那些位元組是 Buffer，
 * 落在 V8 堆之外，所以 --max-old-space-size 擋不住它：程序不會拋錯，只會被
 * OOM killer 殺掉。
 *
 * 這個閘門把那個乘積變成一個明確而且被強制的數字。它跨 route 共用，所以由
 * dispatcher 建立一次再交給每條 route 的上傳中間件——與授權策略註冊表同一個
 * 形狀：框架層的共用物件，不是 service。
 *
 * 滿載時回 503 而不是排隊。排隊會讓客戶端握著連線慢慢傳，而佔住槽位正是這裡
 * 要防的事；限流器的佇列之所以安全，是因為排隊中的請求還沒開始解析、手上沒有
 * 任何 buffer。
 */
export class UploadConcurrencyGate {
  constructor({ maxConcurrentUploads }) {
    if (!Number.isInteger(maxConcurrentUploads) || maxConcurrentUploads <= 0) {
      throw new TypeError("Upload concurrency gate requires a positive maxConcurrentUploads");
    }

    this.maxConcurrentUploads = maxConcurrentUploads;
    this.active = 0;
    this.peak = 0;
    this.rejected = 0;
  }

  /**
   * 取得一個槽位。拿不到回 null，呼叫端負責回 503。
   *
   * 回傳的釋放函式是冪等的：中間件有多條結束路徑（正常完成、解析失敗、客戶端
   * 斷線、逾時），漏放一次會讓槽位永久消失，而那個洩漏是單向累積的——上傳會在
   * 某個時點之後全部開始回 503，且沒有任何錯誤指向原因。
   */
  acquire() {
    if (this.active >= this.maxConcurrentUploads) {
      this.rejected += 1;
      return null;
    }

    this.active += 1;
    this.peak = Math.max(this.peak, this.active);
    let released = false;

    return () => {
      if (released) {
        return;
      }

      released = true;
      this.active -= 1;
    };
  }

  stats() {
    return Object.freeze({
      active: this.active,
      peak: this.peak,
      rejected: this.rejected,
      maxConcurrentUploads: this.maxConcurrentUploads
    });
  }
}
