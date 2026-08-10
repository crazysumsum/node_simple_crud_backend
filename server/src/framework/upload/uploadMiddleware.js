import { randomUUID } from "node:crypto";
import { chmod, mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import busboy from "busboy";
import { ApplicationError } from "../errors/ApplicationError.js";

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
    stream.on("end", () => resolve({ buffer: Buffer.concat(chunks), size }));
  });
}

/**
 * 建立單一 route 的 multipart 上傳中間件。
 *
 * 檔案先在記憶體中累積並完成校驗，通過後才寫入磁碟——避免把未經驗證的內容
 * 落盤後再刪除，也避免部分寫入的檔案殘留。maxFileSizeBytes 因此同時是每個
 * 請求的記憶體上限，這也是它預設只有 10MB 的原因。
 */
export function createUploadMiddleware({ config, logger, fileTypes }) {
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

    let parser;

    try {
      parser = busboy({
        headers: req.headers,
        limits: {
          fileSize: config.maxFileSizeBytes,
          files: config.maxFiles,
          fields: config.maxFieldCount
        }
      });
    } catch (error) {
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

    // 只記錄第一個失敗原因。串流仍必須讀完——busboy 在任何一個 file stream 未被
    // 消耗時就不會發出 close，請求會一路掛到 request timeout。
    const fail = (error) => {
      failure = failure || error;
    };

    parser.on("field", (name, value) => {
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

            accepted.push({
              field: name,
              originalName: path.basename(String(filename || "")),
              mimeType: declared,
              size,
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
              await chmod(filePath, config.fileMode).catch(() => {});
              stored.push(
                Object.freeze({
                  field: file.field,
                  originalName: file.originalName,
                  storedName,
                  path: filePath,
                  mimeType: file.mimeType,
                  size: file.size
                })
              );
            }
          } catch (error) {
            // 部分寫入時清掉已落盤的檔案，不留孤兒。
            await Promise.all(
              stored.map(({ path: filePath }) => unlink(filePath).catch(() => {}))
            );
            throw error;
          }

          req.files = Object.freeze(stored);
          req.body = { ...fields };

          void logger?.info?.("upload.accepted", "Multipart upload accepted", {
            requestId: req.requestId || null,
            fileCount: stored.length,
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
        });
    });

    req.pipe(parser);
  };
}
