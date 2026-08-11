import assert from "node:assert/strict";
import test from "node:test";
import {
  reportInternalFailure,
  resetInternalFailureReports
} from "../src/framework/diagnostics/reportInternalFailure.js";

// 這條通道專門承接「日誌自己壞掉」的故障。它跑在別人的 catch 區塊裡，所以
// 兩件事同等重要：異常一定要輸出得出來，而它自己絕對不能拋。

function captureStderr(t) {
  const lines = [];
  const original = process.stderr.write;

  process.stderr.write = (chunk) => {
    lines.push(String(chunk));
    return true;
  };
  t.after(() => {
    process.stderr.write = original;
  });

  return lines;
}

test.beforeEach(() => resetInternalFailureReports());

test("a failure is written to stderr as a parsable JSONL entry", (t) => {
  const lines = captureStderr(t);
  const error = Object.assign(new Error("disk is full"), { code: "ENOSPC" });

  assert.equal(
    reportInternalFailure("logging.system_write_failed", error, {
      droppedEvent: "user.created"
    }),
    true
  );

  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  // 與其他日誌同一個五欄格式，收集端才解析得了。
  assert.deepEqual(Object.keys(entry), [
    "timestamp",
    "level",
    "event",
    "message",
    "context"
  ]);
  assert.equal(entry.level, "error");
  assert.equal(entry.event, "logging.system_write_failed");
  assert.equal(entry.context.droppedEvent, "user.created");
  assert.deepEqual(entry.context.error, {
    name: "Error",
    code: "ENOSPC",
    message: "disk is full"
  });
  assert.equal(entry.context.suppressedSinceLastReport, 0);
});

test("a repeating failure is throttled into a count instead of flooding stderr", (t) => {
  const lines = captureStderr(t);

  for (let index = 0; index < 500; index += 1) {
    reportInternalFailure("logging.request_write_failed", new Error("nope"));
  }

  // 磁碟寫滿是持續性故障：每筆請求印一行只會把第一筆真正的錯誤沖走。
  assert.equal(lines.length, 1);

  // 不同的 event 各自計算節流，一個吵鬧的故障不會蓋掉另一個。
  reportInternalFailure("logging.system_write_failed", new Error("other"));
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[1]).event, "logging.system_write_failed");
});

test("the suppressed count is carried into the next report", (t) => {
  const lines = captureStderr(t);

  reportInternalFailure("logging.file_mode_failed", new Error("first"));
  reportInternalFailure("logging.file_mode_failed", new Error("second"));
  reportInternalFailure("logging.file_mode_failed", new Error("third"));

  // 節流視窗內的都被壓掉，重置後的下一筆要把規模帶出來。
  assert.equal(lines.length, 1);
  resetInternalFailureReports();
  reportInternalFailure("logging.file_mode_failed", new Error("fourth"));

  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[1]).context.suppressedSinceLastReport, 0);
});

test("the reporter never throws, whatever it is handed", (t) => {
  const lines = captureStderr(t);

  // 循環參照會讓 JSON.stringify 拋出。診斷通道自己拋，等於把「日誌寫不進去」
  // 升級成請求失敗——它要防的正是這種事。
  const circular = {};
  circular.self = circular;

  assert.equal(reportInternalFailure("test.circular", null, circular), false);
  assert.equal(lines.length, 0);

  resetInternalFailureReports();
  // 非 Error 的值也要能收下。
  assert.equal(reportInternalFailure("test.string", "just a string"), true);
  assert.deepEqual(JSON.parse(lines[0]).context.error, { message: "just a string" });

  resetInternalFailureReports();
  assert.equal(reportInternalFailure("test.null", null), true);
  assert.equal(JSON.parse(lines[1]).context.error, null);
});
