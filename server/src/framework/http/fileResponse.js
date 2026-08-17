import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { ApplicationError } from "../errors/ApplicationError.js";

/**
 * Content-Disposition 的檔名。控制字元、引號與路徑分隔符都必須移除，否則
 * 客戶端提供的名稱可以注入額外的 header 參數。同時附上 RFC 5987 的
 * filename*，讓非 ASCII 檔名（中文報表名）能正確顯示。
 */
function contentDisposition(fileName) {
  const safe = path
    .basename(String(fileName || "download"))
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f"\\]/g, "")
    .trim() || "download";
  const ascii = safe.replace(/[^\x20-\x7e]/g, "_");

  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

function isWithinDirectory(directory, target) {
  return target === directory || target.startsWith(directory + path.sep);
}

function outsideRootError() {
  return new ApplicationError("Resolved file path escapes its directory", {
    code: "FILE_PATH_OUTSIDE_ROOT",
    statusCode: 400,
    publicCode: "NOT_FOUND",
    publicMessage: "Not found"
  });
}

function fileNotFoundError(filePath, cause) {
  return new ApplicationError(`Download target is not a file: ${filePath}`, {
    code: "FILE_NOT_FOUND",
    statusCode: 404,
    publicCode: "NOT_FOUND",
    publicMessage: "Not found",
    cause
  });
}

async function openFileWithinDirectory(directory, target) {
  const root = path.resolve(directory);
  const resolved = path.resolve(root, target);

  if (!isWithinDirectory(root, resolved)) {
    throw outsideRootError();
  }

  let realRoot;

  try {
    realRoot = await realpath(root);
  } catch (cause) {
    throw new ApplicationError(`Download root is unavailable: ${root}`, {
      code: "DOWNLOAD_ROOT_UNAVAILABLE",
      statusCode: 500,
      publicCode: "INTERNAL_SERVER_ERROR",
      publicMessage: "Internal server error",
      cause
    });
  }

  let realTarget;

  try {
    realTarget = await realpath(resolved);
  } catch (cause) {
    throw fileNotFoundError(target, cause);
  }

  if (!isWithinDirectory(realRoot, realTarget)) {
    throw outsideRootError();
  }

  let handle;

  try {
    // realpath containment 擋下既存的 symlink escape；O_NOFOLLOW 再擋住
    // realpath 與 open 之間被換成 symlink 的最後一個 path component。
    handle = await open(realTarget, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stats = await handle.stat();

    if (!stats.isFile()) {
      throw fileNotFoundError(target);
    }

    return { handle, stats };
  } catch (cause) {
    await handle?.close();

    if (cause instanceof ApplicationError) {
      throw cause;
    }

    throw fileNotFoundError(target, cause);
  }
}

export async function sendFileResponse(res, descriptor, { root } = {}) {
  const { path: filePath, buffer, stream, fileName, contentType, statusCode = 200 } = descriptor;

  res.status(statusCode);
  res.setHeader("Content-Type", contentType || "application/octet-stream");
  res.setHeader("Content-Disposition", contentDisposition(fileName));
  // 下載內容不應被中介快取，ERP 檔案往往帶有存取權限。
  res.setHeader("Cache-Control", "private, no-store");

  if (buffer) {
    res.setHeader("Content-Length", String(buffer.length));
    res.end(buffer);
    return;
  }

  if (filePath) {
    if (!root) {
      throw new ApplicationError("File response requires a configured download root", {
        code: "HANDLER_DOWNLOAD_ROOT_REQUIRED",
        statusCode: 500,
        publicCode: "INTERNAL_SERVER_ERROR",
        publicMessage: "Internal server error"
      });
    }

    const { handle, stats } = await openFileWithinDirectory(root, filePath);

    try {
      res.setHeader("Content-Length", String(stats.size));
      // fstat 與串流共用同一個 descriptor，pathname 不會在兩者之間被替換。
      await pipeline(handle.createReadStream({ autoClose: false }), res);
    } finally {
      await handle.close();
    }

    return;
  }

  await pipeline(stream, res);
}
