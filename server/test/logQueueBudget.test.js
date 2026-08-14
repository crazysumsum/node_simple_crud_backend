import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  defaultConfigurationSource,
  validateApplicationConfiguration
} from "../src/framework/configuration/applicationConfiguration.js";
import { ConfigurationError } from "../src/framework/configuration/ConfigurationError.js";
import { FileLogWriter } from "../src/services/logging/fileLogWriter.js";
import { normalizeLoggerConfig } from "../src/services/logging/normalizeLoggingConfig.js";
import { renderLogEntry } from "../src/services/logging/renderLogEntry.js";
import { createTestTime } from "../test-support/createTestTime.js";

// 佇列的上限必須以位元組計。只數筆數的話，「10000 筆」對佔多少記憶體沒有任何
// 約束——實測出廠設定下，10000 筆各帶一個 100kb 的 body（jsonBodyLimit 的預設
// 值，5xx 時強制記錄）就是 1.28GB heap，而丟棄邏輯一次都不會觸發，因為筆數
// 剛好卡在上限。64MB heap 排到 400 筆 128KB 就 OOM，那時筆數用了 4%。

const time = createTestTime();
const MB = 1024 * 1024;

async function createWriter(t, overrides = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "erp-logqueue-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const config = normalizeLoggerConfig(
    {
      directory,
      filePrefix: "test",
      retentionDays: 1,
      cleanupIntervalHours: 1,
      maxFileSizeBytes: 64 * MB,
      ...overrides
    },
    "test"
  );

  const writer = new FileLogWriter({ config, time });
  // 建構時的目錄準備（mkdir、收緊權限、首次清理）要先跑完，否則它會在測試
  // 結束、暫存目錄被刪掉之後才回頭 readdir。
  await writer.ready;

  return { writer, directory };
}

/** 磁碟永久卡住：每個排隊任務都會停在 await this.ready 上。 */
function stallDisk(writer) {
  writer.ready = new Promise(() => {});
}

function entry(index, payloadBytes = 0) {
  return {
    timestamp: time.timestamp(),
    level: "info",
    event: "test.entry",
    message: `entry ${index}`,
    context: {
      index,
      payload: payloadBytes === 0 ? null : "x".repeat(payloadBytes)
    }
  };
}

/** 一筆真實形狀的請求日誌，body 大到超過單筆上限。 */
function requestEntry(responseBodyBytes) {
  return {
    timestamp: time.timestamp(),
    level: "error",
    event: "http.request.completed",
    message: "HTTP request completed",
    context: {
      requestId: "req-1",
      method: "POST",
      url: "/api/reports/export",
      durationMs: 1234.5,
      clientIp: "203.0.113.7",
      input: { query: {}, params: {}, body: { reportId: 42 } },
      output: {
        statusCode: 500,
        body: { rows: "x".repeat(responseBodyBytes) }
      }
    }
  };
}

async function readEntries(directory) {
  const [fileName] = await readdir(directory);
  const content = await readFile(path.join(directory, fileName), "utf8");
  return content.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

// --- 位元組預算 -----------------------------------------------------------------

test("the queue stops at the byte budget, nowhere near the entry count", async (t) => {
  const { writer } = await createWriter(t, {
    maxQueuedBytes: MB,
    maxQueuedEntries: 10000,
    maxEntryBytes: 256 * 1024
  });
  stallDisk(writer);

  for (let index = 0; index < 200; index += 1) {
    void writer.write(entry(index, 50 * 1024));
  }

  assert.ok(writer.queuedBytes <= MB, `排隊 ${writer.queuedBytes} bytes`);
  // 這是整個問題：擋下來的時候筆數用了不到 1%。舊的上限在這裡完全沒有作用。
  assert.ok(writer.queuedEntries < 30, `排隊 ${writer.queuedEntries} 筆`);
  assert.equal(writer.droppedEntries, 200 - writer.queuedEntries);
  assert.equal(writer.droppedForQueueBytes, writer.droppedEntries);
});

test("an entry that exactly fills the remaining budget is still taken", async (t) => {
  const size = Buffer.byteLength(`${JSON.stringify(entry(0, 2000))}\n`, "utf8");
  const { writer } = await createWriter(t, {
    maxQueuedBytes: size * 2,
    maxEntryBytes: 4096
  });
  stallDisk(writer);

  void writer.write(entry(0, 2000));
  void writer.write(entry(1, 2000));

  assert.equal(writer.queuedEntries, 2);
  assert.equal(writer.queuedBytes, size * 2);
  assert.equal(writer.droppedEntries, 0);
});

test("the count limit still binds when the entries are small", async (t) => {
  const { writer } = await createWriter(t, {
    maxQueuedBytes: 8 * MB,
    maxQueuedEntries: 5
  });
  stallDisk(writer);

  for (let index = 0; index < 12; index += 1) {
    void writer.write(entry(index));
  }

  assert.equal(writer.queuedEntries, 5);
  assert.equal(writer.droppedEntries, 7);
  // 兩種壓力的處置完全不同——位元組滿了是預算太小或條目太肥，筆數滿了是磁碟
  // 跟不上。混在一個總數裡就分不出該調哪個。
  assert.equal(writer.droppedForQueueBytes, 0);
});

test("the byte counter comes back down after a successful write", async (t) => {
  const { writer } = await createWriter(t, { maxQueuedBytes: MB });

  for (let round = 0; round < 3; round += 1) {
    void writer.write(entry(round, 1024));
    await writer.flush();
  }

  // 單向累積的計數器會讓佇列在幾小時後永久性地拒收，而症狀只是日誌慢慢停掉。
  assert.equal(writer.queuedBytes, 0);
  assert.equal(writer.queuedEntries, 0);
  assert.equal(writer.droppedEntries, 0);
});

test("a failed write gives its bytes back too", async (t) => {
  const { writer } = await createWriter(t, { maxQueuedBytes: MB });
  writer.ready = new Promise((_resolve, reject) => {
    setImmediate(() => reject(new Error("disk gone")));
  });

  await assert.rejects(() => writer.write(entry(0, 1024)), /disk gone/);

  assert.equal(writer.queuedBytes, 0);
  assert.equal(writer.queuedEntries, 0);
  assert.equal(writer.failedEntries, 1);
});

test("an entry rejected before it is queued never touches the budget", async (t) => {
  const { writer } = await createWriter(t, { maxQueuedBytes: MB });

  await assert.rejects(
    () => writer.write({ level: "info", event: "broken" }),
    /must contain a valid timestamp/
  );

  assert.equal(writer.queuedBytes, 0);
  assert.equal(writer.queuedEntries, 0);
  assert.equal(writer.failedEntries, 1);
});

test("byte pressure is reported apart from a slow disk", async (t) => {
  const { writer, directory } = await createWriter(t, {
    maxQueuedBytes: 8192,
    maxEntryBytes: 4096
  });

  void writer.write(entry(0, 3000));
  void writer.write(entry(1, 3000));
  void writer.write(entry(2, 3000));
  await writer.flush();
  await writer.write(entry(3));

  const [notice] = await readEntries(directory);
  assert.equal(notice.event, "logging.entries_lost");
  assert.equal(notice.level, "error");
  assert.equal(notice.context.droppedEntries, 1);
  assert.equal(notice.context.droppedForQueueBytes, 1);
  // 三個上限一起報，否則看日誌的人算不出該調哪一個。
  assert.deepEqual(
    {
      bytes: notice.context.maxQueuedBytes,
      entries: notice.context.maxQueuedEntries,
      entry: notice.context.maxEntryBytes
    },
    { bytes: 8192, entries: 10000, entry: 4096 }
  );
});

test("the lost-entries notice counts toward the file size", async (t) => {
  const { writer, directory } = await createWriter(t, { maxQueuedEntries: 1 });

  void writer.write(entry(0));
  void writer.write(entry(1));
  await writer.flush();
  // 這一筆前面會補上一行統計。
  await writer.write(entry(2));

  const [fileName] = await readdir(directory);
  const onDisk = (await stat(path.join(directory, fileName))).size;

  // 少算統計行的話，快取的大小就比實際小，檔案會悄悄長過 maxFileSizeBytes。
  assert.equal(writer.target.size, onDisk);
});

// --- 單筆上限 -------------------------------------------------------------------

test("an oversized entry is truncated, not dropped", async (t) => {
  const { writer, directory } = await createWriter(t, { maxEntryBytes: 8192 });

  await writer.write(requestEntry(100_000));

  const [written] = await readEntries(directory);
  // 丟掉整筆等於連「這個請求發生過」都沒了，而那是查問題時最先要確認的事實。
  assert.equal(written.event, "http.request.completed");
  assert.equal(writer.truncatedEntries, 1);
});

test("truncation cuts the heaviest branch and keeps everything beside it", async (t) => {
  const { writer, directory } = await createWriter(t, { maxEntryBytes: 8192 });

  await writer.write(requestEntry(100_000));

  const [written] = await readEntries(directory);
  assert.match(written.context.output.body.rows, /^\[TRUNCATED: \d+ bytes\]$/);
  // 剪的是 output.body.rows，不是 output——所以查問題真正要看的欄位全都還在。
  assert.equal(written.context.output.statusCode, 500);
  assert.equal(written.context.requestId, "req-1");
  assert.equal(written.context.url, "/api/reports/export");
  assert.equal(written.context.durationMs, 1234.5);
  assert.deepEqual(written.context.input.body, { reportId: 42 });
});

test("a heavy collection is cut whole, not one element at a time", () => {
  // 每輪換掉陣列裡的一個元素等於什麼都沒省到——八輪之後整筆退成骨架，連
  // requestId 都沒了，而真正該剪的那個陣列原封不動。
  const { line } = renderLogEntry(
    {
      timestamp: time.timestamp(),
      level: "info",
      event: "report.generated",
      message: "report generated",
      context: {
        requestId: "req-1",
        rows: Array.from({ length: 5000 }, (_, index) => ({ sku: `S-${index}`, qty: index }))
      }
    },
    8192
  );
  const written = JSON.parse(line.toString("utf8"));

  assert.equal(written.context.requestId, "req-1");
  assert.match(written.context.rows, /^\[TRUNCATED: \d+ bytes\]$/);
});

test("truncation reaches through arrays without rewriting the caller's entry", () => {
  const entry = {
    timestamp: time.timestamp(),
    level: "info",
    event: "batch.processed",
    message: "batch processed",
    context: {
      batchId: "B-9",
      batches: [
        { name: "big", rows: Array.from({ length: 5000 }, (_, i) => ({ sku: `S-${i}` })) },
        { name: "small", rows: [] }
      ]
    }
  };
  const written = JSON.parse(renderLogEntry(entry, 8192).line.toString("utf8"));

  // 陣列要複製成陣列。複製成物件的話 JSON 會變成 {"0":…,"1":…}，欄位還讀得到
  // 但形狀變了，任何按索引處理日誌的工具都會踩空。
  assert.equal(Array.isArray(written.context.batches), true);
  assert.match(written.context.batches[0].rows, /^\[TRUNCATED: \d+ bytes\]$/);
  assert.equal(written.context.batches[0].name, "big");
  assert.equal(written.context.batchId, "B-9");
  // 只複製路徑上的祖先，不改動傳進來的物件——writer 是公開介面，改別人的輸入
  // 會讓同一個物件在下一個 logger 手上已經被剪過。
  assert.equal(entry.context.batches[0].rows.length, 5000);
});

test("the truncation marker says how much was cut", () => {
  const { line } = renderLogEntry(requestEntry(100_000), 8192);
  const written = JSON.parse(line.toString("utf8"));
  const [, bytes] = /^\[TRUNCATED: (\d+) bytes\]$/.exec(
    written.context.output.body.rows
  );

  assert.ok(Number(bytes) > 100_000, `標記說 ${bytes} bytes`);
});

test("both bodies get cut when both are oversized", () => {
  // 5xx 的常態：request body 與 response body 各自都超標，剪掉一個還是進不了
  // 預算。只剪一輪就放棄的話，一筆完全可以救回來的日誌會退成骨架。
  const { line } = renderLogEntry(
    {
      timestamp: time.timestamp(),
      level: "error",
      event: "http.request.completed",
      message: "HTTP request completed",
      context: {
        requestId: "req-1",
        input: { body: { rows: "a".repeat(100_000) } },
        output: { statusCode: 500, body: { rows: "b".repeat(100_000) } }
      }
    },
    8192
  );
  const written = JSON.parse(line.toString("utf8"));

  assert.match(written.context.input.body.rows, /^\[TRUNCATED: \d+ bytes\]$/);
  assert.match(written.context.output.body.rows, /^\[TRUNCATED: \d+ bytes\]$/);
  assert.equal(written.context.output.statusCode, 500);
  assert.equal(written.context.requestId, "req-1");
});

test("a context of several medium fields keeps what it can", () => {
  // 沒有任何單一欄位自己超標，但加起來超標。這時仍然要剪掉最重的那一個——
  // 直接退成骨架的話，一筆本來還讀得懂七成的日誌就只剩五欄。
  const { line } = renderLogEntry(
    {
      timestamp: time.timestamp(),
      level: "info",
      event: "order.created",
      message: "order created",
      context: {
        requestId: "req-1",
        payload: "a".repeat(8000),
        summary: "b".repeat(1000)
      }
    },
    8192
  );
  const written = JSON.parse(line.toString("utf8"));

  assert.match(written.context.payload, /^\[TRUNCATED: \d+ bytes\]$/);
  assert.equal(written.context.summary.length, 1000);
  assert.equal(written.context.requestId, "req-1");
});

test("the cut is measured in UTF-8 bytes, which is what reaches the disk", () => {
  // 中文一個字 UTF-8 是三個 byte。用字元數挑「最重的」節點會挑錯，而標記報出
  // 來的大小也會比實際落盤的少三分之二——那個數字正是別人用來調 maxEntryBytes
  // 的依據。
  const note = "中".repeat(3000);
  const { line } = renderLogEntry(
    {
      timestamp: time.timestamp(),
      level: "info",
      event: "order.created",
      message: "order created",
      context: { note }
    },
    8192
  );
  const written = JSON.parse(line.toString("utf8"));
  const [, reported] = /^\[TRUNCATED: (\d+) bytes\]$/.exec(written.context.note);

  assert.equal(Number(reported), Buffer.byteLength(JSON.stringify(note), "utf8"));
  assert.ok(Number(reported) > note.length * 2, `標記說 ${reported} bytes`);
});

test("no rendered line ever exceeds the entry limit, whatever the shape", () => {
  // 這是讓位元組預算成立的前提。任何一種形狀漏出去，佇列的上限就不是上限。
  const base = { timestamp: time.timestamp(), level: "info", event: "e", message: "m" };
  const shapes = {
    "一個巨大的字串葉節點": { ...base, context: { body: "x".repeat(200_000) } },
    "一個巨大的陣列": {
      ...base,
      context: { rows: Array.from({ length: 5000 }, (_, i) => ({ sku: `S-${i}`, qty: i })) }
    },
    "很多個中等大小的欄位": {
      ...base,
      context: Object.fromEntries(
        Array.from({ length: 100 }, (_, i) => [`field-${i}`, "y".repeat(5000)])
      )
    },
    "深層巢狀": {
      ...base,
      context: { a: { b: { c: { d: { e: { f: "z".repeat(200_000) } } } } } }
    },
    "超標的是 message 本身": { ...base, message: "m".repeat(200_000), context: { id: 1 } },
    "context 根本不是物件": { ...base, message: "m".repeat(200_000), context: null },
    "空的 context": { ...base, message: "m".repeat(200_000), context: {} },
    "context 裡有序列化不出來的值": {
      ...base,
      context: { callback: () => {}, missing: undefined, body: "x".repeat(200_000) }
    },
    "連 event 與 message 都沒有": {
      timestamp: base.timestamp,
      level: "info",
      context: "x".repeat(200_000)
    }
  };

  for (const [name, shape] of Object.entries(shapes)) {
    const { line, truncated } = renderLogEntry(shape, 8192);

    assert.equal(truncated, true, name);
    assert.ok(line.length <= 8192, `${name}：${line.length} bytes`);
    // 切一半的 JSON 會讓整個 JSONL 檔案 jq 不動，一筆壞的毀掉整天的日誌。
    assert.doesNotThrow(() => JSON.parse(line.toString("utf8")), name);
    assert.equal(line.at(-1), 0x0a, `${name}：結尾不是換行`);
  }
});

test("an entry the pruning cannot save keeps its five columns", () => {
  const { line } = renderLogEntry(
    {
      timestamp: time.timestamp(),
      level: "warn",
      event: "job.failed",
      message: "m".repeat(200_000),
      context: { jobName: "cleanup" }
    },
    8192
  );
  const written = JSON.parse(line.toString("utf8"));

  assert.equal(written.level, "warn");
  assert.equal(written.event, "job.failed");
  assert.equal(written.message.length, 200);
  assert.equal(written.context.logTruncated.maxEntryBytes, 8192);
  assert.ok(written.context.logTruncated.originalBytes > 200_000);
});

test("the skeleton copes with an entry that has no event or message", () => {
  const { line } = renderLogEntry(
    { timestamp: time.timestamp(), level: "info", context: "x".repeat(200_000) },
    8192
  );
  const written = JSON.parse(line.toString("utf8"));

  assert.deepEqual(
    { event: written.event, message: written.message },
    { event: "", message: "" }
  );
});

test("an entry that fits is passed through byte for byte", () => {
  const small = entry(1);
  const { line, truncated } = renderLogEntry(small, 8192);

  assert.equal(truncated, false);
  assert.equal(line.toString("utf8"), `${JSON.stringify(small)}\n`);
});

test("the queue is priced in UTF-8 bytes, not characters", async (t) => {
  // 中文一個字 UTF-8 是三個 byte，而 V8 把它存成 UTF-16。用字元數或字串長度
  // 計價，兩個方向都會算錯落盤的實際大小。
  const { writer } = await createWriter(t, { maxQueuedBytes: MB });
  stallDisk(writer);

  const chinese = {
    timestamp: time.timestamp(),
    level: "info",
    event: "test.entry",
    message: "訂單建立",
    context: { note: "香港九龍灣宏開道八號" }
  };

  // 磁碟卡住，這筆永遠不會落盤——所以不能 await 它，只看它入列時怎麼計價。
  void writer.write(chinese);
  assert.equal(
    writer.queuedBytes,
    Buffer.byteLength(`${JSON.stringify(chinese)}\n`, "utf8")
  );
});

// --- 設定 ----------------------------------------------------------------------

test("the byte limits are validated", () => {
  const base = { directory: "logs", filePrefix: "test" };

  for (const maxEntryBytes of [0, -1, 1.5, 4095, "big"]) {
    assert.throws(
      () => normalizeLoggerConfig({ ...base, maxEntryBytes }, "test"),
      /"loggers\.test\.maxEntryBytes" must be a whole number of bytes, at least 4096/
    );
  }

  for (const maxQueuedBytes of [0, -1, 1.5, "big"]) {
    assert.throws(
      () => normalizeLoggerConfig({ ...base, maxQueuedBytes }, "test"),
      /"loggers\.test\.maxQueuedBytes" must be a whole number of bytes, at least 1/
    );
  }

  // 數字字串照收，跟框架其他數值設定一致——環境變數本來就是字串。
  assert.equal(
    normalizeLoggerConfig({ ...base, maxEntryBytes: "8192" }, "test").maxEntryBytes,
    8192
  );

  const defaults = normalizeLoggerConfig(base, "test");
  assert.equal(defaults.maxQueuedBytes, 8388608);
  assert.equal(defaults.maxEntryBytes, 262144);
});

test("a queue budget that cannot hold one entry is refused", () => {
  // 佇列是空的但仍然收不下——那不是背壓，是這個 logger 從此一筆都寫不出去。
  assert.throws(
    () =>
      normalizeLoggerConfig(
        { directory: "logs", filePrefix: "test", maxQueuedBytes: 8192, maxEntryBytes: 65536 },
        "test"
      ),
    /"loggers\.test\.maxQueuedBytes" \(8192\) must be at least "maxEntryBytes" \(65536\)/
  );
});

// --- 啟動時的 heap 交叉檢查 -------------------------------------------------------

test("the shipped defaults fit a modest heap", () => {
  const configuration = validateApplicationConfiguration(
    defaultConfigurationSource(),
    { heapLimitBytes: 256 * MB }
  );

  assert.equal(configuration.logging.loggers.request.maxQueuedBytes, 8388608);
});

test("log queues that cannot fit in the heap fail startup", () => {
  // 這個組合現在開得起來，然後在磁碟慢下來的那一次死掉——沒有執行期症狀，
  // 所以只能擋在啟動。
  assert.throws(
    () => validateApplicationConfiguration(defaultConfigurationSource(), {
      heapLimitBytes: 64 * MB
    }),
    (error) =>
      error instanceof ConfigurationError &&
      /log queues can hold 27MB .* exceeds 25% of the V8 heap limit \(16MB of 64MB\)/s.test(
        error.message
      )
  );
});

test("the per-entry overhead counts, because it is not in maxQueuedBytes", () => {
  const source = defaultConfigurationSource();
  const loggers = {
    request: { ...source.logging.loggers.request, maxQueuedBytes: 4096, maxEntryBytes: 4096 },
    system: { ...source.logging.loggers.system, maxQueuedBytes: 4096, maxEntryBytes: 4096 }
  };

  // payload 只有 8KB，但 20000 個排隊槽位的 Buffer／promise／closure 就是 12MB。
  // 只看 maxQueuedBytes 的話這個設定看起來毫無問題。
  assert.throws(
    () => validateApplicationConfiguration(
      { ...source, logging: { loggers } },
      { heapLimitBytes: 32 * MB }
    ),
    /log queues can hold 11MB/
  );
});

test("a disabled logger does not spend the heap budget", () => {
  const source = defaultConfigurationSource();
  const loggers = {
    request: source.logging.loggers.request,
    system: { ...source.logging.loggers.system, enabled: false }
  };

  const configuration = validateApplicationConfiguration(
    { ...source, logging: { loggers } },
    { heapLimitBytes: 64 * MB }
  );

  assert.equal(configuration.logging.loggers.system.enabled, false);
});
