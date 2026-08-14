// 把一筆日誌條目變成準備落盤的位元組。

// 剪枝每一輪都要把整筆重新序列化一次，所以輪數必須有上限——沒有上限的話，
// 一筆病態的條目自己就是一次 CPU 攻擊。剪不完的交給最小骨架處理。
const MAX_PRUNE_PASSES = 8;

// 骨架裡 event 與 message 各自保留的字元數。
const SKELETON_TEXT_LIMIT = 200;

const EMPTY_LINE = Buffer.alloc(0);

/** 沿用既有的 [NOT_LOGGED]／[FILE_TRANSFER]／[Buffer N bytes] 標記形式。 */
function truncationMarker(bytes) {
  return `[TRUNCATED: ${bytes} bytes]`;
}

function isContainer(value) {
  return value !== null && typeof value === "object";
}

function byteSize(value) {
  // 函式與 undefined 序列化後是 undefined，當成不佔位。
  return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
}

function encode(payload) {
  return Buffer.from(`${JSON.stringify(payload)}\n`, "utf8");
}

function childEntries(node) {
  return Array.isArray(node) ? node.entries() : Object.entries(node);
}

function heaviestChild(node) {
  let heaviest = null;

  for (const [key, value] of childEntries(node)) {
    const bytes = byteSize(value);

    if (heaviest === null || bytes > heaviest.bytes) {
      heaviest = { key, bytes };
    }
  }

  return heaviest;
}

/**
 * 找出該換掉的那個節點。
 *
 * 從 context 往下走最重的那一條路徑，只要走到的孩子自己仍然超標就繼續往下——
 * 換掉一個「剛好也超標」的祖先，會連它底下所有還讀得懂的兄弟欄位一起賠進去。
 * 一筆 5MB 的請求日誌因此一路走到 context.output.body，換掉它，而 statusCode、
 * requestId、url、durationMs 全部留著；那些才是查問題要看的東西。
 *
 * 反過來，走到一個自己已經進得了預算的層就要停手，換掉的是它的父層。少了這一
 * 步，一個 5000 筆的 rows 陣列會變成「每輪換掉一個 30 bytes 的元素」，八輪下來
 * 什麼都沒省到，整筆退成骨架——連 requestId 都沒了。
 */
function locateHeaviestNode(context, maxEntryBytes) {
  if (!isContainer(context)) {
    return null;
  }

  const path = [];
  let node = context;
  let bytes = 0;

  while (isContainer(node)) {
    const heaviest = heaviestChild(node);

    if (heaviest === null) {
      break;
    }

    // 已經往下走過，而這一層最重的孩子自己不再超標：停在上一層。第一層沒有
    // 上一層可停，所以照樣換掉——那是當下唯一能做的一步。
    if (path.length > 0 && heaviest.bytes <= maxEntryBytes) {
      break;
    }

    path.push(heaviest.key);
    bytes = heaviest.bytes;
    node = node[heaviest.key];
  }

  return path.length === 0 ? null : { path, bytes };
}

/**
 * 沿著 path 換掉一個節點，只複製這條路徑上的祖先。
 *
 * 不改動傳進來的物件：Logger 給的是 sanitize() 出來的私有副本，但 writer 是
 * 公開介面，改別人的輸入不是它該做的事。
 */
function replaceAt(node, path, index, replacement) {
  const copy = Array.isArray(node) ? [...node] : { ...node };
  const key = path[index];

  copy[key] =
    index === path.length - 1
      ? replacement
      : replaceAt(node[key], path, index + 1, replacement);

  return copy;
}

/**
 * 剪不動時的最小骨架。
 *
 * 丟掉整筆等於連「這個請求發生過」都沒了，那是查問題時最先要確認的事實。
 * 五欄留著，body 換成一句說明它原本有多大。
 */
function skeletonEntry(entry, originalBytes, maxEntryBytes) {
  return {
    timestamp: entry.timestamp,
    level: entry.level,
    event: String(entry.event ?? "").slice(0, SKELETON_TEXT_LIMIT),
    message: String(entry.message ?? "").slice(0, SKELETON_TEXT_LIMIT),
    context: { logTruncated: { originalBytes, maxEntryBytes } }
  };
}

/**
 * 序列化成 UTF-8 位元組，並保證不超過 maxEntryBytes。
 *
 * 回傳 Buffer 而不是物件或字串有兩個理由。一是精確計價：位元組預算要的就是
 * buffer.length，估算不算數。二是省一半——同一筆含中文的條目實測，物件圖
 * 3447B、JS 字串 2758B（V8 對非 ASCII 字串用 UTF-16 存）、Buffer 1643B。
 *
 * 超標時是截斷不是丟棄，而且是在物件層剪枝再重新序列化，不是把字串切一半：
 * 切一半的 JSON 會讓整個 JSONL 檔案 jq 不動，一筆壞的毀掉整天的日誌。
 */
export function renderLogEntry(entry, maxEntryBytes) {
  let payload = entry;
  let line = encode(payload);

  if (line.length <= maxEntryBytes) {
    return { line, truncated: false };
  }

  const originalBytes = line.length;

  for (let pass = 0; pass < MAX_PRUNE_PASSES; pass += 1) {
    const target = locateHeaviestNode(payload.context, maxEntryBytes);

    if (target === null) {
      break;
    }

    const marker = truncationMarker(target.bytes);

    if (byteSize(marker) >= target.bytes) {
      // 標記不比要換掉的節點短，剪了也不會變小——超標的不是 context 而是外面
      // 那四欄。再剪下去只是反覆換掉同一個小欄位，交給骨架。
      break;
    }

    payload = {
      ...payload,
      context: replaceAt(payload.context, target.path, 0, marker)
    };
    line = encode(payload);

    if (line.length <= maxEntryBytes) {
      return { line, truncated: true };
    }
  }

  return {
    line: encode(skeletonEntry(entry, originalBytes, maxEntryBytes)),
    truncated: true
  };
}

export { EMPTY_LINE };
