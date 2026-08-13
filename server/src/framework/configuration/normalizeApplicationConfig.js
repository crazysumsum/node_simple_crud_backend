function integer(value, key, { minimum = 1, maximum } = {}) {
  const number = Number(value);

  if (
    !Number.isInteger(number) ||
    number < minimum ||
    (maximum !== undefined && number > maximum)
  ) {
    const range = maximum
      ? `between ${minimum} and ${maximum}`
      : `greater than or equal to ${minimum}`;
    throw new Error(`Application config "${key}" must be an integer ${range}`);
  }

  return number;
}

function timeZone(value) {
  const normalized = String(value || "").trim();

  try {
    new Intl.DateTimeFormat("en", { timeZone: normalized }).format();
  } catch {
    throw new Error(`Application config "timeZone" is invalid: ${normalized}`);
  }

  return normalized;
}

/**
 * 請求生命週期的四個逾時必須排成一條鏈，否則其中幾個永遠不會生效。
 *
 * 這些關係沒有任何執行期症狀：排錯了不會報錯，只會讓某一段變成沒有上限，或者
 * 讓某個設定值從此是一句空話。所以全部擋在啟動。
 */
function checkTimeoutChain(config) {
  const {
    requestTimeoutMs,
    requestReceiveTimeoutMs,
    headersReceiveTimeoutMs,
    bodyReceiveTimeoutMs,
    connectionsCheckingIntervalMs
  } = config;

  // 上傳的 body 在 route timeout 開始計時之後才被讀取，兩段時間重疊。收取上限
  // 比 route 的逾時短，Node 就會先斷線，route 的 timeoutMs 對任何會讀 body 的
  // route 都變成空話——而且症狀是「大檔案上傳偶爾失敗」，不會指回這裡。
  if (requestReceiveTimeoutMs < requestTimeoutMs) {
    throw new Error(
      `Application config "requestReceiveTimeoutMs" (${requestReceiveTimeoutMs}ms) must be at ` +
        `least "requestTimeoutMs" (${requestTimeoutMs}ms). A request body is still arriving ` +
        "while the route timeout runs, so cutting the connection first would make every " +
        "route's timeoutMs unenforceable."
    );
  }

  // header 是整個請求的一部分，上限比整體還大就永遠輪不到它。
  if (headersReceiveTimeoutMs > requestReceiveTimeoutMs) {
    throw new Error(
      `Application config "headersReceiveTimeoutMs" (${headersReceiveTimeoutMs}ms) must not ` +
        `exceed "requestReceiveTimeoutMs" (${requestReceiveTimeoutMs}ms), or it can never fire.`
    );
  }

  // 看門狗守的是 requestReceiveTimeoutMs 之內的一小段。比它還長就是死碼。
  if (bodyReceiveTimeoutMs > requestReceiveTimeoutMs) {
    throw new Error(
      `Application config "bodyReceiveTimeoutMs" (${bodyReceiveTimeoutMs}ms) must not exceed ` +
        `"requestReceiveTimeoutMs" (${requestReceiveTimeoutMs}ms), or the socket-level timeout ` +
        "always fires first and the watchdog is dead code."
    );
  }

  // 檢查間隔是兩個 socket 層逾時的誤差上界。比較緊的那一個若小於間隔，設定的
  // 數字與實際行為就會差上數倍——Node 預設的 30000 正是這個陷阱。
  if (connectionsCheckingIntervalMs > headersReceiveTimeoutMs) {
    throw new Error(
      `Application config "connectionsCheckingIntervalMs" (${connectionsCheckingIntervalMs}ms) ` +
        `must not exceed "headersReceiveTimeoutMs" (${headersReceiveTimeoutMs}ms). The interval ` +
        "is how late a socket timeout can fire, so a larger one makes the configured timeout " +
        "meaningless."
    );
  }
}

export function normalizeApplicationConfig(source) {
  const host = String(source?.host || "").trim();

  if (!host) {
    throw new Error('Application config "host" must be a non-empty string');
  }

  const config = Object.freeze({
    host,
    port: integer(source.port, "port", { minimum: 0, maximum: 65535 }),
    timeZone: timeZone(source.timeZone),
    requestTimeoutMs: integer(source.requestTimeoutMs, "requestTimeoutMs"),
    requestReceiveTimeoutMs: integer(
      source.requestReceiveTimeoutMs,
      "requestReceiveTimeoutMs"
    ),
    headersReceiveTimeoutMs: integer(
      source.headersReceiveTimeoutMs,
      "headersReceiveTimeoutMs"
    ),
    bodyReceiveTimeoutMs: integer(source.bodyReceiveTimeoutMs, "bodyReceiveTimeoutMs"),
    connectionsCheckingIntervalMs: integer(
      source.connectionsCheckingIntervalMs,
      "connectionsCheckingIntervalMs"
    ),
    shutdownTimeoutMs: integer(source.shutdownTimeoutMs, "shutdownTimeoutMs")
  });

  checkTimeoutChain(config);

  return config;
}
