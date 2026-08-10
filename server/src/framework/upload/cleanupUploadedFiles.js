import { unlink } from "node:fs/promises";

/**
 * 刪除本次請求已落盤、但沒有任何東西接手的上傳檔案。
 *
 * 上傳一定要在 schema 驗證與 handler 之前完成——文字欄位得先解析出來才有東西
 * 可驗證。代價是「檔案已經在磁碟上，請求卻還可能失敗」：驗證失敗、handler 拋
 * 錯、idempotency 重播，全都會留下沒有任何紀錄指向它的孤兒檔。這裡負責在那些
 * 路徑上收尾。
 *
 * 只在 handler 沒有成功回應時呼叫。handler 成功即代表檔案已經被接手（通常是把
 * path 寫進資料庫），此時刪檔會刪掉正在使用中的資料。
 */
export async function cleanupUploadedFiles(req, logger, reason) {
  const files = Array.isArray(req.files) ? req.files : [];

  if (files.length === 0) {
    return [];
  }

  // 先清空再刪除：同一個請求上不會有第二次清理，也不會有 handler 在事後
  // 讀到已經不存在的路徑。
  req.files = Object.freeze([]);

  const removed = [];
  const failures = [];

  await Promise.all(
    files.map(async (file) => {
      try {
        await unlink(file.path);
        removed.push(file.storedName);
      } catch (error) {
        // ENOENT 代表 handler 已經把檔案搬走或改名，那是正常結果。
        if (error.code !== "ENOENT") {
          failures.push({ storedName: file.storedName, message: error.message });
        }
      }
    })
  );

  if (removed.length > 0) {
    void logger?.info?.("upload.cleaned_up", "Uploaded files removed after a failed request", {
      requestId: req.requestId || null,
      reason: reason || "request_failed",
      files: removed
    });
  }

  if (failures.length > 0) {
    // 刪不掉就是磁碟上真的留了垃圾，必須看得見，否則只會靜靜長大。
    void logger?.error?.("upload.cleanup_failed", "Uploaded files could not be removed", {
      requestId: req.requestId || null,
      reason: reason || "request_failed",
      failures
    });
  }

  return removed;
}
