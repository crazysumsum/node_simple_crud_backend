import { appendFile, chmod, mkdir, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { reportInternalFailure } from "../../framework/diagnostics/reportInternalFailure.js";
import { EMPTY_LINE, renderLogEntry } from "./renderLogEntry.js";

// Shared JSONL file writer used by every configured Logger.

const DAY_IN_MS = 24 * 60 * 60 * 1000;

function rotationIndex(fileName, baseName) {
  if (fileName === `${baseName}.log`) {
    return 0;
  }

  if (!fileName.startsWith(`${baseName}-`) || !fileName.endsWith(".log")) {
    return null;
  }

  const suffix = fileName.slice(baseName.length + 1, -4);
  return /^\d+$/.test(suffix) ? Number(suffix) : null;
}

function rotatedFileName(baseName, index) {
  return index === 0
    ? `${baseName}.log`
    : `${baseName}-${String(index).padStart(3, "0")}.log`;
}

export class FileLogWriter {
  constructor({ config, time } = {}) {
    this.config = config;
    this.time = time;

    if (!time || typeof time.nowMs !== "function" || typeof time.fileDate !== "function") {
      throw new TypeError("File log writer requires a time service");
    }

    this.lastCleanupAt = 0;
    this.queue = Promise.resolve();
    // 寫入是串行的，磁碟一慢佇列就會堆積。堆積的是完整的日誌條目（錯誤時含
    // 整個 request／response body），沒有上限就會一路吃掉記憶體直到程序被
    // OOM 殺掉——為了記錄故障而製造更大的故障。
    //
    // 上限必須以位元組計。只數筆數的話，「10000 筆」對佔多少記憶體沒有任何
    // 約束：實測出廠設定下，10000 筆各帶一個 100kb 的 body（jsonBodyLimit 的
    // 預設值，5xx 時強制記錄）就是 1.28GB heap／1.75GB RSS，而丟棄邏輯一次都
    // 沒有觸發，因為筆數剛好卡在上限。
    this.queuedEntries = 0;
    this.queuedBytes = 0;
    this.droppedEntries = 0;
    this.droppedForQueueBytes = 0;
    // 累計值，不隨統計送出而歸零：截斷本身不會觸發統計那一筆日誌（每筆都截斷
    // 的話會讓日誌量翻倍），所以它只在別的原因觸發時順帶報告目前的總數。
    this.truncatedEntries = 0;
    this.failedEntries = 0;
    // 目前寫入中的檔案。快取路徑與大小，避免每一筆日誌都 readdir + stat 整個目錄
    // ——那個成本會隨保留天數累積的檔案數線性上升，而寫入是在請求路徑上。
    this.target = null;
    this.ready = mkdir(config.directory, {
      recursive: true,
      mode: config.directoryMode
    })
      .then(() => this.restrictExistingFiles())
      .then(() => this.cleanup());
  }

  /**
   * appendFile 的 mode 只在建檔時生效，mkdir 的 mode 也只套用在新建目錄上，
   * 所以升級既有安裝時要主動收緊——舊檔案正是裝著個資的那些。
   * 權限調整可能因檔案系統或擁有者不符而失敗，屬於盡力而為，不應讓應用啟動失敗。
   */
  async restrictExistingFiles() {
    const { directory, filePrefix, fileMode, directoryMode } = this.config;

    try {
      await chmod(directory, directoryMode);
    } catch (error) {
      // 收不緊權限代表日誌可能被其他帳號讀走，而日誌裡有完整的 body。
      // 這是安全事件，絕不能只是「盡力而為」地靜靜失敗。
      reportInternalFailure("logging.directory_mode_failed", error, {
        directory,
        requestedMode: directoryMode?.toString(8) ?? null
      });
      return;
    }

    let files;

    try {
      files = await readdir(directory);
    } catch (error) {
      reportInternalFailure("logging.directory_scan_failed", error, { directory });
      return;
    }

    await Promise.all(
      files
        .filter(
          (fileName) =>
            fileName.startsWith(`${filePrefix}-`) && fileName.endsWith(".log")
        )
        .map(async (fileName) => {
          try {
            await chmod(path.join(directory, fileName), fileMode);
          } catch (error) {
            reportInternalFailure("logging.file_mode_failed", error, {
              directory,
              fileName,
              requestedMode: fileMode?.toString(8) ?? null
            });
          }
        })
    );
  }

  /**
   * 佇列滿或寫入失敗時只能把該筆日誌丟掉，但丟棄本身不可以是靜默的——日誌
   * 中間少了一段，看的人無從得知。統計會補在下一筆成功寫入的前面，而且要等
   * appendFile 真的成功才扣減，否則連這筆統計也可能一起消失。
   */
  lostEntriesNotice(timestamp) {
    const droppedEntries = this.droppedEntries;
    const failedEntries = this.failedEntries;

    if (droppedEntries === 0 && failedEntries === 0) {
      return { line: EMPTY_LINE, commit: () => {} };
    }

    const line = Buffer.from(
      `${JSON.stringify({
        timestamp,
        level: "error",
        event: "logging.entries_lost",
        message: "Log entries were dropped because the writer could not keep up",
        context: {
          droppedEntries,
          // 分開報，因為兩者的處置完全不同：位元組滿了是預算太小或條目太肥，
          // 筆數滿了是磁碟跟不上。只有一個總數的話兩者分不出來。
          droppedForQueueBytes: this.droppedForQueueBytes,
          truncatedEntries: this.truncatedEntries,
          failedEntries,
          queuedBytes: this.queuedBytes,
          maxQueuedEntries: this.config.maxQueuedEntries,
          maxQueuedBytes: this.config.maxQueuedBytes,
          maxEntryBytes: this.config.maxEntryBytes
        }
      })}\n`,
      "utf8"
    );

    return {
      line,
      commit: () => {
        // 扣減而非歸零：等待期間可能又累積了新的。
        this.droppedEntries -= droppedEntries;
        this.failedEntries -= failedEntries;
      }
    };
  }

  /**
   * 在入列之前就定型：序列化、必要時截斷、算出精確的位元組數與目標檔案日期。
   *
   * 之所以不留到寫入時才做，是因為位元組預算需要的就是這個數字——要先知道
   * 這筆有多大，才決定得了收不收。
   */
  renderEntry(entry) {
    const timestamp = entry?.timestamp;

    if (!timestamp) {
      throw new Error("Log entry must contain a valid timestamp");
    }

    const { line, truncated } = renderLogEntry(entry, this.config.maxEntryBytes);

    if (truncated) {
      this.truncatedEntries += 1;
    }

    return { line, timestamp, date: this.time.fileDate(timestamp) };
  }

  write(entry) {
    let rendered;

    try {
      rendered = this.renderEntry(entry);
    } catch (error) {
      this.failedEntries += 1;
      return Promise.reject(error);
    }

    const { line, timestamp, date } = rendered;
    const countIsFull = this.queuedEntries >= this.config.maxQueuedEntries;

    if (countIsFull || this.queuedBytes + line.length > this.config.maxQueuedBytes) {
      this.droppedEntries += 1;

      if (!countIsFull) {
        this.droppedForQueueBytes += 1;
      }

      return Promise.resolve();
    }

    this.queuedEntries += 1;
    this.queuedBytes += line.length;
    const task = this.queue.then(async () => {
      try {
        await this.ready;
        await this.cleanupIfDue();

        const notice = this.lostEntriesNotice(timestamp);
        const content =
          notice.line.length === 0 ? line : Buffer.concat([notice.line, line]);
        const filePath = await this.filePathForWrite(date, content.length);

        // mode 只在這一次呼叫實際建立檔案時生效；既有檔案由 restrictExistingFiles 處理。
        await appendFile(filePath, content, { mode: this.config.fileMode });
        notice.commit();
      } finally {
        this.queuedEntries -= 1;
        this.queuedBytes -= line.length;
      }
    });

    this.queue = task.catch(() => {
      this.failedEntries += 1;
    });
    return task;
  }

  /**
   * 排程驅動的清理。
   *
   * 清理原本只掛在 write() 上，所以一台不寫日誌的伺服器永遠不會清理——
   * request logger 有流量才寫，system logger 更是只在啟動、錯誤與關機時才寫。
   * 一個長期安靜、沒有錯誤的實例，過期檔案會一直留著，而 retentionDays 說好了
   * 只留 30 天。
   *
   * 走同一條序列化佇列，否則會與寫入同時改到 this.target。真正是否執行仍由
   * cleanupIfDue() 依 cleanupIntervalHours 決定，設定語意完全不變。
   */
  runCleanup() {
    const task = this.queue.then(async () => {
      await this.ready;
      await this.cleanupIfDue();
    });

    this.queue = task.catch(() => {});
    return task;
  }

  async flush() {
    await this.ready;
    await this.queue;
  }

  async filePathForWrite(date, contentSize) {
    // 只有在第一次寫入、跨日，或清理過後才需要回到磁碟重新對齊。
    if (!this.target || this.target.date !== date) {
      this.target = await this.resolveTarget(date);
    }

    if (
      this.target.size > 0 &&
      this.target.size + contentSize > this.config.maxFileSizeBytes
    ) {
      const index = this.target.index + 1;
      this.target = {
        date,
        index,
        filePath: path.join(
          this.config.directory,
          rotatedFileName(`${this.config.filePrefix}-${date}`, index)
        ),
        size: 0
      };
    }

    this.target.size += contentSize;
    return this.target.filePath;
  }

  async resolveTarget(date) {
    const baseName = `${this.config.filePrefix}-${date}`;
    const files = await readdir(this.config.directory);
    let index = 0;

    for (const fileName of files) {
      const fileIndex = rotationIndex(fileName, baseName);

      if (fileIndex !== null && fileIndex > index) {
        index = fileIndex;
      }
    }

    const filePath = path.join(
      this.config.directory,
      rotatedFileName(baseName, index)
    );
    let size = 0;

    try {
      size = (await stat(filePath)).size;
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }

    return { date, index, filePath, size };
  }

  async cleanupIfDue() {
    const intervalMs = this.config.cleanupIntervalHours * 60 * 60 * 1000;

    if (this.time.nowMs() - this.lastCleanupAt >= intervalMs) {
      await this.cleanup();
    }
  }

  async cleanup() {
    const files = await readdir(this.config.directory);
    const prefix = `${this.config.filePrefix}-`;
    const cutoff = this.time.nowMs() - this.config.retentionDays * DAY_IN_MS;

    await Promise.all(
      files
        .filter((fileName) => fileName.startsWith(prefix) && fileName.endsWith(".log"))
        .map(async (fileName) => {
          const filePath = path.join(this.config.directory, fileName);
          const fileStats = await stat(filePath);

          if (fileStats.mtimeMs < cutoff) {
            await unlink(filePath);
          }
        })
    );

    // cleanup 可能刪掉目前寫入中的檔案，快取的大小便不再可信。
    this.target = null;
    this.lastCleanupAt = this.time.nowMs();
  }
}
