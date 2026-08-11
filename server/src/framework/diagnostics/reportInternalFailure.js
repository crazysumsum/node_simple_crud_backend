/**
 * 日誌管道本身失效時的最後手段。
 *
 * 「寫日誌失敗」不能再寫一筆日誌——不是無限遞迴，就是同樣被丟掉。這類失敗
 * 只剩 stderr 這條還能信任的通道：容器執行環境、systemd、PM2 都會收，而且
 * 不依賴應用內任何已經壞掉的東西。
 *
 * 這個模組要解決的是原本散落各處的 console.error 的兩個缺點：
 *
 * 1. 純文字。日誌收集端無法解析，也就無法對它告警——等於看得見卻沒人看。
 *    這裡輸出的 JSONL 與其他日誌同一個五欄格式，可以直接進同一條管道。
 * 2. 沒有上限。磁碟寫滿是持續性故障，每筆請求印一行會把 stderr 也一起埋掉，
 *    真正的第一筆錯誤反而被沖走。同一個 event 會被壓成計數。
 *
 * 時間戳刻意用 UTC 而不是 time service：故障當下不保證拿得到容器內的服務，
 * 而這裡不能有任何依賴。
 */

const THROTTLE_MS = 60000;
const reported = new Map();

function errorShape(error) {
  if (!error) {
    return null;
  }

  if (!(error instanceof Error)) {
    return { message: String(error) };
  }

  return {
    name: error.name,
    code: error.code ?? null,
    message: error.message
  };
}

/**
 * @returns {boolean} 是否真的輸出（false 代表被節流壓成計數）
 */
export function reportInternalFailure(event, error, context = {}) {
  const now = Date.now();
  const state = reported.get(event) || { suppressed: 0, lastReportedAt: 0 };

  if (state.lastReportedAt !== 0 && now - state.lastReportedAt < THROTTLE_MS) {
    state.suppressed += 1;
    reported.set(event, state);
    return false;
  }

  state.lastReportedAt = now;
  const suppressedSinceLastReport = state.suppressed;
  state.suppressed = 0;
  reported.set(event, state);

  // 這個函式全部都跑在別人的 catch 區塊裡。它自己拋出例外，會把「日誌寫不
  // 進去」升級成請求失敗甚至未捕捉例外——正是它要防的那種事。所以連序列化
  // 與 stderr 寫入都要包起來，寧可少一筆診斷也不能反過來製造故障。
  try {
    const line = {
      timestamp: new Date(now).toISOString(),
      level: "error",
      event,
      message: "Internal failure reported outside the logging pipeline",
      context: {
        ...context,
        error: errorShape(error),
        // 上一次輸出之後被壓掉的次數，讓持續性故障的規模仍然看得出來。
        suppressedSinceLastReport,
        throttleMs: THROTTLE_MS
      }
    };

    process.stderr.write(`${JSON.stringify(line)}\n`);
    return true;
  } catch {
    return false;
  }
}

/** 測試用：清掉節流狀態，讓每個測試從乾淨的狀態開始。 */
export function resetInternalFailureReports() {
  reported.clear();
}
