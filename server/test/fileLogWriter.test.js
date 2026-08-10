import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FileLogWriter } from "../src/services/logging/fileLogWriter.js";
import { normalizeLoggerConfig } from "../src/services/logging/normalizeLoggingConfig.js";
import { createTestTime } from "../test-support/createTestTime.js";

// 寫入是串行的：磁碟一慢，等待中的日誌就會在記憶體裡堆積。堆的還是完整的
// 日誌條目（錯誤時含整個 request／response body），沒有上限等於為了記錄故障
// 而製造一個更大的故障。

const time = createTestTime();

async function createWriter(t, overrides = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "erp-logwriter-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const config = normalizeLoggerConfig(
    {
      directory,
      filePrefix: "test",
      retentionDays: 1,
      cleanupIntervalHours: 1,
      maxFileSizeBytes: 1048576,
      ...overrides
    },
    "test"
  );

  return { writer: new FileLogWriter({ config, time }), directory };
}

function entry(index) {
  return {
    timestamp: time.timestamp(),
    level: "info",
    event: "test.entry",
    message: `entry ${index}`,
    context: { index }
  };
}

async function readEntries(directory) {
  const [fileName] = await readdir(directory);
  const content = await readFile(path.join(directory, fileName), "utf8");
  return content
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("the writer drops entries once the queue is full instead of growing forever", async (t) => {
  const { writer, directory } = await createWriter(t, { maxQueuedEntries: 2 });

  // 同一個 tick 內連續呼叫，任何一筆都還來不及寫出去，佇列因此填滿。
  for (let index = 0; index < 6; index += 1) {
    void writer.write(entry(index));
  }

  assert.equal(writer.droppedEntries, 4);
  await writer.flush();

  const written = await readEntries(directory);
  assert.deepEqual(
    written
      .filter((line) => line.event === "test.entry")
      .map((line) => line.context.index),
    [0, 1]
  );
});

test("dropped entries are reported in the log, not silently swallowed", async (t) => {
  const { writer, directory } = await createWriter(t, { maxQueuedEntries: 1 });

  void writer.write(entry(0));
  void writer.write(entry(1));
  void writer.write(entry(2));
  await writer.flush();

  // 統計會補在下一筆真正寫出去的日誌前面——這裡是還在佇列裡的第 0 筆。
  await writer.write(entry(3));

  const written = await readEntries(directory);
  assert.deepEqual(
    written.map((line) => line.event),
    ["logging.entries_lost", "test.entry", "test.entry"]
  );

  const notice = written[0];
  assert.equal(notice.level, "error");
  assert.equal(notice.context.droppedEntries, 2);
  assert.equal(notice.context.maxQueuedEntries, 1);
  // 統計送出後歸零，不會每一筆都重複報一次。
  assert.equal(writer.droppedEntries, 0);
});

test("a failed write is counted and reported rather than swallowed", async (t) => {
  const { writer, directory } = await createWriter(t);

  // timestamp 缺失會讓寫入在真正落盤之前就失敗。
  await assert.rejects(() => writer.write({ level: "info", event: "broken" }));
  assert.equal(writer.failedEntries, 1);

  await writer.write(entry(1));

  const written = await readEntries(directory);
  assert.deepEqual(
    written.map((line) => line.event),
    ["logging.entries_lost", "test.entry"]
  );
  assert.equal(written[0].context.failedEntries, 1);
});

test("a full queue does not leak its counter once entries drain", async (t) => {
  const { writer } = await createWriter(t, { maxQueuedEntries: 2 });

  for (let round = 0; round < 3; round += 1) {
    void writer.write(entry(round));
    await writer.flush();
  }

  assert.equal(writer.queuedEntries, 0);
  assert.equal(writer.droppedEntries, 0);
});
