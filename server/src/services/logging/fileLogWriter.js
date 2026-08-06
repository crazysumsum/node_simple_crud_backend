import { appendFile, mkdir, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";

// Shared JSONL file writer used by every configured Logger.

const DAY_IN_MS = 24 * 60 * 60 * 1000;

function dateForFile(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));

  return `${values.year}-${values.month}-${values.day}`;
}

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
  constructor(config) {
    this.config = config;
    this.lastCleanupAt = 0;
    this.queue = Promise.resolve();
    this.ready = mkdir(config.directory, { recursive: true }).then(() => this.cleanup());
  }

  write(entry) {
    const task = this.queue.then(async () => {
      await this.ready;
      await this.cleanupIfDue();

      const entryTimestamp = entry.timestamp;

      if (!entryTimestamp || Number.isNaN(new Date(entryTimestamp).getTime())) {
        throw new Error("Log entry must contain a valid timestamp");
      }

      const date = dateForFile(new Date(entryTimestamp), this.config.timeZone);
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
    const baseName = `${this.config.filePrefix}-${date}`;
    const files = await readdir(this.config.directory);
    let latestIndex = 0;

    for (const fileName of files) {
      const index = rotationIndex(fileName, baseName);

      if (index !== null && index > latestIndex) {
        latestIndex = index;
      }
    }

    let filePath = path.join(
      this.config.directory,
      rotatedFileName(baseName, latestIndex)
    );
    let currentSize = 0;

    try {
      currentSize = (await stat(filePath)).size;
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }

    if (
      currentSize > 0 &&
      currentSize + contentSize > this.config.maxFileSizeBytes
    ) {
      filePath = path.join(
        this.config.directory,
        rotatedFileName(baseName, latestIndex + 1)
      );
    }

    return filePath;
  }

  async cleanupIfDue() {
    const intervalMs = this.config.cleanupIntervalHours * 60 * 60 * 1000;

    if (Date.now() - this.lastCleanupAt >= intervalMs) {
      await this.cleanup();
    }
  }

  async cleanup() {
    const files = await readdir(this.config.directory);
    const prefix = `${this.config.filePrefix}-`;
    const cutoff = Date.now() - this.config.retentionDays * DAY_IN_MS;

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

    this.lastCleanupAt = Date.now();
  }
}
