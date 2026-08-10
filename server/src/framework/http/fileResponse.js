import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
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

/**
 * 確認目標檔案位於允許的目錄內。直接把 handler 算出來的路徑交給 sendFile，
 * 只要那個路徑有一部分來自請求參數，就是路徑穿越漏洞。
 */
export function resolveWithinDirectory(directory, target) {
  const root = path.resolve(directory);
  const resolved = path.resolve(root, target);

  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new ApplicationError("Resolved file path escapes its directory", {
      code: "FILE_PATH_OUTSIDE_ROOT",
      statusCode: 400,
      publicCode: "NOT_FOUND",
      publicMessage: "Not found"
    });
  }

  return resolved;
}

export async function sendFileResponse(res, descriptor) {
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
    const stats = await stat(filePath).catch(() => null);

    if (!stats?.isFile()) {
      throw new ApplicationError(`Download target is not a file: ${filePath}`, {
        code: "FILE_NOT_FOUND",
        statusCode: 404,
        publicCode: "NOT_FOUND",
        publicMessage: "Not found"
      });
    }

    res.setHeader("Content-Length", String(stats.size));
    await pipeline(createReadStream(filePath), res);
    return;
  }

  await pipeline(stream, res);
}
