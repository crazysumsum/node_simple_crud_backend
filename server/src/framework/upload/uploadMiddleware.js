import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import busboy from "busboy";
import { ApplicationError } from "../errors/ApplicationError.js";
import { cleanupUploadedFiles } from "./cleanupUploadedFiles.js";

export class UploadError extends ApplicationError {
  constructor(code, message, statusCode = 400) {
    super(message, { code, statusCode, publicMessage: message });
  }
}

/**
 * 產生落盤用的檔名。客戶端提供的檔名一律不使用——"../../.ssh/authorized_keys"
 * 是合法的 multipart filename，直接採用等於把寫入位置交給呼叫方。原始檔名只
 * 保留在回傳的中介資料裡，由 handler 自行決定是否存進資料庫。
 */
function storedFileName(mimeType, fileTypes) {
  const extension = fileTypes.extensionsFor(mimeType)[0] || "";
  return `${randomUUID()}${extension}`;
}

function collect(stream, limitBytes, onLimit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    stream.on("data", (chunk) => {
      size += chunk.length;

      if (size > limitBytes) {
        // 立刻停止讀取，不把超限內容繼續收進記憶體或磁碟。
        onLimit();
        return;
      }

      chunks.push(chunk);
    });
    stream.on("limit", onLimit);
    stream.on("error", reject);
    stream.on("end", () => {
      // concat 之後 chunks 仍被上面的 data 監聽器閉包參照著，而閉包活到 stream
      // 本身被回收為止——於是同一份內容有兩份拷貝並存，一份是要用的 buffer，
      // 一份是純粹的垃圾。並行上傳時這會讓實際佔用逼近 api.upload_budget 所
      // 報數字的兩倍。concat 當下的瞬間峰值無法避免（要用它才能做尾端特徵
      // 校驗），但持續佔用的那一份可以立刻放掉。
      //
      // 不傳 totalLength：size 在超限時會把沒收進 chunks 的位元組也算進去
      // （見上）。那條路徑上的 buffer 一定會被丟掉，所以目前看不出差別，但
      // 讓長度與內容出自同一個來源，之後改動這裡時少一個要記住的前提。
      const buffer = Buffer.concat(chunks);
      chunks.length = 0;
      resolve({ buffer, size });
    });
  });
}

/**
 * 建立單一 route 的 multipart 上傳中間件。
 *
 * 檔案先在記憶體中累積並完成校驗，通過後才寫入磁碟——避免把未經驗證的內容
 * 落盤後再刪除，也避免部分寫入的檔案殘留。校驗需要完整內容（OLE2 的目錄扇區
 * 與 OOXML 的 [Content_Types].xml 都可能落在檔案尾端），所以這個取捨的代價
 * 就是記憶體。
 *
 * 因此記憶體上限由三道限制共同決定，缺一不可：
 *
 *   maxRequestBytes   單一請求的位元組總量，檔案與文字欄位都算
 *   maxTotalFileBytes 單一請求的檔案總量（每個檔案另受 maxFileSizeBytes 限制）
 *   gate              全域同時解析數，跨 route 共用
 *
 * 前兩者限制一個請求，只有 gate 限制得住整個程序——而程序才是被 OOM killer
 * 殺掉的那個單位。
 */
export function createUploadMiddleware({ config, logger, fileTypes, gate = null }) {
  if (!fileTypes || typeof fileTypes.rejectionReason !== "function") {
    throw new TypeError("Upload middleware requires the filetypes service");
  }

  return function uploadMiddleware(req, res, next) {
    const contentType = String(req.get("content-type") || "");

    if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
      next(
        new UploadError(
          "UPLOAD_CONTENT_TYPE_INVALID",
          "Request must use multipart/form-data",
          415
        )
      );
      return;
    }

    // 誠實的客戶端會宣告 Content-Length，那就能在讀進任何一個位元組之前、也在
    // 佔用一個併發槽位之前就拒絕。不誠實的客戶端由下面的逐位元組計數擋下。
    const declaredLength = Number(req.get("content-length"));

    if (Number.isFinite(declaredLength) && declaredLength > config.maxRequestBytes) {
      next(
        new UploadError(
          "UPLOAD_REQUEST_TOO_LARGE",
          `Request exceeds the ${config.maxRequestBytes} byte limit`,
          413
        )
      );
      return;
    }

    const releaseSlot = gate ? gate.acquire() : () => {};

    if (!releaseSlot) {
      void logger?.warn?.("upload.rejected", "Multipart upload rejected", {
        requestId: req.requestId || null,
        code: "UPLOAD_CAPACITY_EXCEEDED",
        reason: "The upload concurrency gate is full",
        ...gate.stats()
      });
      res.setHeader?.("Retry-After", "1");
      next(
        new UploadError(
          "UPLOAD_CAPACITY_EXCEEDED",
          "The server is handling too many uploads",
          503
        )
      );
      return;
    }

    let parser;

    try {
      parser = busboy({
        headers: req.headers,
        limits: {
          fileSize: config.maxFileSizeBytes,
          files: config.maxFiles,
          fields: config.maxFieldCount,
          // 沒有這一項時 busboy 會套用自己的 1MiB 預設值，於是 maxFieldCount
          // 個文字欄位可以夾帶遠超過 maxFileSizeBytes 的資料進來——設定看起來
          // 限制了請求大小，實際上沒有。
          fieldSize: config.maxFieldSizeBytes
        }
      });
    } catch (error) {
      releaseSlot();
      next(
        new UploadError("UPLOAD_MALFORMED", "Malformed multipart request", 400)
      );
      return;
    }

    const fields = Object.create(null);
    const pending = [];
    const accepted = [];
    let failure = null;
    let settled = false;
    let requestBytes = 0;
    let acceptedFileBytes = 0;

    // 只記錄第一個失敗原因。串流仍必須讀完——busboy 在任何一個 file stream 未被
    // 消耗時就不會發出 close，請求會一路掛到 request timeout。
    const fail = (error) => {
      failure = failure || error;
    };

    // 客戶端在 body 送完之前斷線時 busboy 永遠不會發出 close。少了這個收尾，
    // dispatcher 包住上傳的 Promise 就不會 settle：並行槽位與 request scope
    // 會一路卡到 request timeout，只要開一批半途中斷的連線就能佔滿服務。
    const onRequestClose = () => {
      if (settled || req.complete) {
        // req.complete 的情況下解析仍在進行，槽位要留到 close 事件那裡才放。
        return;
      }

      settled = true;
      releaseSlot();
      req.unpipe(parser);
      parser.destroy();
      next(
        new UploadError(
          "UPLOAD_ABORTED",
          "Upload ended before the request body was fully received",
          400
        )
      );
    };

    req.on("close", onRequestClose);

    // 逐位元組計數，擋下沒有宣告 Content-Length 或宣告不實的客戶端。data 監聽
    // 器與 pipe 並存不會搶走資料，兩邊都收得到同樣的 chunk。
    //
    // 超限就立刻切斷，不是記下來等解析結束——重點正是不要把那些位元組收進來。
    req.on("data", (chunk) => {
      requestBytes += chunk.length;

      if (requestBytes <= config.maxRequestBytes || settled) {
        return;
      }

      settled = true;
      releaseSlot();
      req.unpipe(parser);
      parser.destroy();
      next(
        new UploadError(
          "UPLOAD_REQUEST_TOO_LARGE",
          `Request exceeds the ${config.maxRequestBytes} byte limit`,
          413
        )
      );
    });

    parser.on("field", (name, value, info) => {
      // busboy 對超長欄位是靜默截斷，不會發出任何事件；不主動檢查的話
      // handler 會拿到一個看起來正常、其實少了尾巴的值。
      if (info?.nameTruncated || info?.valueTruncated) {
        fail(
          new UploadError(
            "UPLOAD_FIELD_TOO_LARGE",
            `Form field exceeds the ${config.maxFieldSizeBytes} byte limit`,
            413
          )
        );
        return;
      }

      fields[name] = value;
    });

    parser.on("file", (name, stream, info) => {
      const { filename, mimeType } = info;
      let limitExceeded = false;
      const onLimit = () => {
        limitExceeded = true;
        stream.resume();
      };

      // 每個 promise 在建立當下就掛上處理器，否則校驗失敗會在 close 之前
      // 變成 unhandled rejection。
      pending.push(
        collect(stream, config.maxFileSizeBytes, onLimit).then(
          ({ buffer, size }) => {
            if (limitExceeded) {
              fail(
                new UploadError(
                  "UPLOAD_FILE_TOO_LARGE",
                  `File exceeds the ${config.maxFileSizeBytes} byte limit`,
                  413
                )
              );
              return;
            }

            const declared = String(mimeType || "")
              .toLowerCase()
              .split(";")[0]
              .trim();

            if (!config.allowedMimeTypes.includes(declared)) {
              fail(
                new UploadError(
                  "UPLOAD_TYPE_NOT_ALLOWED",
                  `File type is not allowed: ${declared || "unknown"}`,
                  415
                )
              );
              return;
            }

            const reason = fileTypes.rejectionReason({
              mimeType: declared,
              fileName: filename,
              // 完整內容：OLE2 這類格式的特徵可能落在檔案尾端。
              content: buffer
            });

            if (reason) {
              fail(
                new UploadError(
                  "UPLOAD_TYPE_MISMATCH",
                  `Rejected upload: ${reason}`,
                  415
                )
              );
              return;
            }

            acceptedFileBytes += size;

            // 每個檔案各自貼著 maxFileSizeBytes 是完全合法的，所以單檔上限
            // 限制不住總量。maxFiles 個檔案的總和才是這個請求真正佔用的記憶體。
            if (acceptedFileBytes > config.maxTotalFileBytes) {
              fail(
                new UploadError(
                  "UPLOAD_TOTAL_TOO_LARGE",
                  `Files exceed the ${config.maxTotalFileBytes} byte total limit`,
                  413
                )
              );
              return;
            }

            accepted.push({
              field: name,
              originalName: path.basename(String(filename || "")),
              mimeType: declared,
              size,
              // 內容摘要在這裡算最便宜——buffer 還在手上。Idempotency 需要它
              // 才能分辨「同一個 key 重送同一份檔案」與「換了一份檔案」。
              contentHash: createHash("sha256").update(buffer).digest("hex"),
              buffer
            });
          },
          (error) => fail(error)
        )
      );
    });

    parser.on("filesLimit", () =>
      fail(
        new UploadError(
          "UPLOAD_TOO_MANY_FILES",
          `At most ${config.maxFiles} file(s) may be uploaded`,
          413
        )
      )
    );
    parser.on("fieldsLimit", () =>
      fail(new UploadError("UPLOAD_TOO_MANY_FIELDS", "Too many form fields", 413))
    );
    parser.on("error", () =>
      fail(new UploadError("UPLOAD_MALFORMED", "Malformed multipart request", 400))
    );

    parser.on("close", () => {
      if (settled) {
        return;
      }

      settled = true;
      req.removeListener("close", onRequestClose);

      Promise.all(pending)
        .then(async () => {
          if (failure) {
            throw failure;
          }

          const files = accepted;
          await mkdir(config.directory, {
            recursive: true,
            mode: config.directoryMode
          });
          const stored = [];

          try {
            for (const file of files) {
              const storedName = storedFileName(file.mimeType, fileTypes);
              const filePath = path.join(config.directory, storedName);

              await writeFile(filePath, file.buffer, { mode: config.fileMode });
              // writeFile 的 mode 遇上 umask 或既有檔案不一定生效，所以再收一次。
              // 收不緊代表上傳的檔案權限比宣告的寬，而附件往往就是最敏感的
              // 資料——不能靜靜地放過去。
              await chmod(filePath, config.fileMode).catch((error) => {
                void logger?.error?.(
                  "upload.file_mode_failed",
                  "Stored upload could not be restricted to the configured mode",
                  {
                    requestId: req.requestId || null,
                    storedName,
                    requestedMode: config.fileMode.toString(8),
                    error: { name: error.name, code: error.code ?? null, message: error.message }
                  }
                );
              });
              stored.push(
                Object.freeze({
                  field: file.field,
                  originalName: file.originalName,
                  storedName,
                  path: filePath,
                  mimeType: file.mimeType,
                  size: file.size,
                  contentHash: file.contentHash
                })
              );
            }
          } catch (error) {
            // 部分寫入時清掉已落盤的檔案，不留孤兒。清不掉就是真的留了垃圾，
            // 必須記下來——磁碟上多出來的檔案沒有別的線索可循。
            req.files = stored;
            await cleanupUploadedFiles(req, logger, "partial_write");
            throw error;
          }

          req.files = Object.freeze(stored);
          req.body = { ...fields };

          void logger?.info?.("upload.accepted", "Multipart upload accepted", {
            requestId: req.requestId || null,
            fileCount: stored.length,
            requestBytes,
            totalFileBytes: acceptedFileBytes,
            files: stored.map(({ storedName, mimeType, size }) => ({
              storedName,
              mimeType,
              size
            }))
          });
          next();
        })
        .catch((error) => {
          const uploadError =
            error instanceof ApplicationError
              ? error
              : new UploadError("UPLOAD_FAILED", "Upload could not be processed", 400);

          void logger?.warn?.("upload.rejected", "Multipart upload rejected", {
            requestId: req.requestId || null,
            code: uploadError.code,
            reason: uploadError.message
          });
          next(uploadError);
        })
        // 槽位必須在成功與失敗兩條路上都放掉。漏放一次是單向累積的：上傳會在
        // 某個時點之後全部開始回 503，而且沒有任何錯誤指向原因。
        .finally(releaseSlot);
    });

    req.pipe(parser);
  };
}
