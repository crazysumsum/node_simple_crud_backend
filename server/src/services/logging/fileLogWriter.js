import { appendFile, mkdir, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";

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
    // 目前寫入中的檔案。快取路徑與大小，避免每一筆日誌都 readdir + stat 整個目錄
    // ——那個成本會隨保留天數累積的檔案數線性上升，而寫入是在請求路徑上。
    this.target = null;
    this.ready = mkdir(config.directory, { recursive: true }).then(() => this.cleanup());
  }

  write(entry) {
    const task = this.queue.then(async () => {
      await this.ready;
      await this.cleanupIfDue();

      const entryTimestamp = entry.timestamp;

      if (!entryTimestamp) {
        throw new Error("Log entry must contain a valid timestamp");
      }

      const date = this.time.fileDate(entryTimestamp);
      const content = `${JSON.stringify(entry)}\n`;
      const contentSize = Buffer.byteLength(content, "utf8");
      const filePath = await this.filePathForWrite(date, contentSize);

      await appendFile(filePath, content, "utf8");
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
