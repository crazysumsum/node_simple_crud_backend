const REQUEST_PROCESSING = Symbol("requestProcessingLifecycle");

function lifecycleFor(req) {
  if (!req[REQUEST_PROCESSING]) {
    req[REQUEST_PROCESSING] = {
      started: false,
      completed: false,
      abandoned: false,
      listeners: new Set(),
      abandonListeners: new Set()
    };
  }

  return req[REQUEST_PROCESSING];
}

export function onRequestProcessingComplete(req, listener) {
  if (typeof listener !== "function") {
    throw new TypeError("Request processing completion listener must be a function");
  }

  const lifecycle = lifecycleFor(req);

  if (lifecycle.completed) {
    listener();
    return () => {};
  }

  lifecycle.listeners.add(listener);
  return () => lifecycle.listeners.delete(listener);
}

export function markRequestProcessingStarted(req) {
  const lifecycle = lifecycleFor(req);

  if (!lifecycle.completed) {
    lifecycle.started = true;
  }
}

export function markRequestProcessingCompleted(req) {
  const lifecycle = lifecycleFor(req);

  if (lifecycle.completed) {
    return;
  }

  lifecycle.completed = true;

  for (const listener of lifecycle.listeners) {
    listener();
  }

  lifecycle.listeners.clear();
}

/**
 * 訂閱「這個請求被放棄了」。
 *
 * 被放棄 ≠ 完成。handler 還在跑，只是沒有人在等它的輸出了，所以它不該再佔著
 * 活著的請求需要的東西（限流槽位、request scope 裡的連線）。之後 handler 真的
 * settle 時，completion 監聽器照樣會觸發。
 */
export function onRequestAbandoned(req, listener) {
  if (typeof listener !== "function") {
    throw new TypeError("Request abandonment listener must be a function");
  }

  const lifecycle = lifecycleFor(req);

  if (lifecycle.abandoned) {
    listener();
    return () => {};
  }

  lifecycle.abandonListeners.add(listener);
  return () => lifecycle.abandonListeners.delete(listener);
}

/**
 * 判定一個請求是不是被放棄了。四個條件缺一不可，每一個都在擋一種誤判。
 *
 * started —— 沒走到 handler 的請求（429、404、body 逾時）由 markRequestResponse-
 *   Ended 正常完成，不走這條路。
 *
 * !completed —— handler 已經回來了就沒事。
 *
 * signal.aborted —— 最關鍵的一個。「回應結束了但 handler 還沒 settle」對每一筆
 *   請求都會短暫成立（回應送出到 dispatcher 的 finally 之間永遠有幾個 microtask），
 *   拿它當判定式等於對所有請求提早釋放槽位，會系統性少算在飛的工作。signal 只在
 *   逾時觸發或客戶端提早離開時才被設起來，正常完成走的是 onFinish，不 abort。
 *   所以它精確地區分了「回應結束是因為請求被殺掉」與「因為 handler 做完了」。
 *
 * writableEnded || destroyed —— 回應真的結束了，沒有人在等它。
 */
export function maybeMarkRequestAbandoned(req, res, signal) {
  const lifecycle = lifecycleFor(req);

  if (
    !lifecycle.started ||
    lifecycle.completed ||
    lifecycle.abandoned ||
    signal?.aborted !== true ||
    !(res.writableEnded === true || res.destroyed === true)
  ) {
    return false;
  }

  lifecycle.abandoned = true;

  for (const listener of lifecycle.abandonListeners) {
    listener();
  }

  lifecycle.abandonListeners.clear();
  return true;
}

export function markRequestResponseEnded(req) {
  const lifecycle = lifecycleFor(req);

  // Requests that reached a Handler are completed by the dispatcher, even when
  // a timeout or client disconnect ends the HTTP response first.
  if (!lifecycle.started) {
    markRequestProcessingCompleted(req);
  }
}
