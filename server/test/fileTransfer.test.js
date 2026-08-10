import assert from "node:assert/strict";
import { readdir, readFile, rm, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BaseRequestHandler } from "../src/framework/api/BaseRequestHandler.js";
import { createApplication } from "../src/framework/application/createApplication.js";
import { defaultConfigurationSource } from "../src/framework/configuration/applicationConfiguration.js";
import { resolveWithinDirectory } from "../src/framework/http/fileResponse.js";

// 真實的檔案位元組。內容校驗必須靠簽章，所以測試不能用假資料。
const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(64, 0x20)]);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 0x00)
]);

const silentLogger = {
  debug: async () => {},
  info: async () => {},
  warn: async () => {},
  error: async () => {},
  flush: async () => {}
};

function makeHandlers(uploadDirectory) {
  class UploadHandler extends BaseRequestHandler {
    static handlerName = "uploadDocument";
    static api = {
      method: "POST",
      path: "/api/v1/documents",
      description: "Accept a document upload.",
      authType: "public",
      authorizationPolicies: [{ name: "allowAll", options: {} }],
      upload: {
        enabled: true,
        directory: uploadDirectory,
        maxFileSizeBytes: 1024,
        maxFiles: 2,
        allowedMimeTypes: ["application/pdf", "image/png"]
      },
      requestSchema: {
        body: {
          type: "object",
          required: ["title"],
          additionalProperties: false,
          properties: { title: { type: "string" } }
        }
      },
      responseSchema: { 201: { type: "object", additionalProperties: true } }
    };

    async execute(req) {
      return this.response(
        {
          title: req.input.body.title,
          files: req.files.map(({ originalName, storedName, mimeType, size }) => ({
            originalName,
            storedName,
            mimeType,
            size
          }))
        },
        { statusCode: 201 }
      );
    }
  }

  class DownloadHandler extends BaseRequestHandler {
    static handlerName = "downloadReport";
    static api = {
      method: "GET",
      path: "/api/v1/reports/:name",
      description: "Download a stored report.",
      authType: "public",
      authorizationPolicies: [{ name: "allowAll", options: {} }],
      download: { enabled: true },
      requestSchema: {
        params: {
          type: "object",
          required: ["name"],
          additionalProperties: false,
          properties: { name: { type: "string" } }
        }
      },
      responseSchema: { 200: { type: "object", additionalProperties: true } }
    };

    async execute(req) {
      // 路徑一定要收斂回允許的目錄，name 來自請求。
      const filePath = resolveWithinDirectory(uploadDirectory, req.input.params.name);
      return this.file({
        path: filePath,
        fileName: "季度報表.pdf",
        contentType: "application/pdf"
      });
    }
  }

  class BufferDownloadHandler extends BaseRequestHandler {
    static handlerName = "exportBuffer";
    static api = {
      ...DownloadHandler.api,
      path: "/api/v1/exports",
      description: "Download generated content.",
      requestSchema: {
        query: { type: "object", additionalProperties: false, properties: {} }
      }
    };

    async execute() {
      return this.file({
        buffer: PDF,
        fileName: "generated.pdf",
        contentType: "application/pdf"
      });
    }
  }

  class UndeclaredDownloadHandler extends BaseRequestHandler {
    static handlerName = "undeclaredDownload";
    static api = {
      ...BufferDownloadHandler.api,
      path: "/api/v1/undeclared",
      description: "Return a file without declaring download.",
      download: { enabled: false }
    };

    async execute() {
      return this.file({ buffer: PDF, fileName: "nope.pdf" });
    }
  }

  return { UploadHandler, DownloadHandler, BufferDownloadHandler, UndeclaredDownloadHandler };
}

async function startApplication(t) {
  const uploadDirectory = await mkdtemp(path.join(os.tmpdir(), "erp-upload-"));
  t.after(() => rm(uploadDirectory, { recursive: true, force: true }));

  const handlers = makeHandlers(uploadDirectory);
  const source = defaultConfigurationSource();
  const application = await createApplication({
    configurationSource: {
      ...source,
      application: { ...source.application, port: 0, shutdownTimeoutMs: 1000 }
    },
    handlerRegistryOptions: {
      moduleUrls: ["virtual:fileTransfer"],
      moduleLoader: async () => handlers
    },
    logger: silentLogger,
    requestLogger: (_req, _res, next) => next(),
    serviceOptions: {
      mysqldatabase: { pool: { query: async () => [[{ ok: 1 }]], end: async () => {} } }
    },
    forceExit: () => {
      throw new Error("File transfer test must not force exit");
    }
  });
  t.after(() => application.shutdown("test_cleanup"));

  const { url } = await application.start();
  return { url, uploadDirectory };
}

function form(parts, { title = "Q3" } = {}) {
  const data = new FormData();

  if (title !== null) {
    data.append("title", title);
  }

  for (const { field = "file", bytes, name, type } of parts) {
    data.append(field, new Blob([bytes], { type }), name);
  }

  return data;
}

const upload = (url, data) =>
  fetch(`${url}/api/v1/documents`, { method: "POST", body: data });

test("upload stores a valid file and exposes its metadata to the handler", async (t) => {
  const { url, uploadDirectory } = await startApplication(t);

  const response = await upload(url, form([{ bytes: PDF, name: "invoice.pdf", type: "application/pdf" }]));
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.equal(body.data.title, "Q3");
  assert.equal(body.data.files.length, 1);

  const [file] = body.data.files;
  assert.equal(file.originalName, "invoice.pdf");
  assert.equal(file.mimeType, "application/pdf");
  assert.equal(file.size, PDF.length);
  // 落盤檔名不得沿用客戶端提供的名稱。
  assert.notEqual(file.storedName, "invoice.pdf");
  assert.match(file.storedName, /^[0-9a-f-]{36}\.pdf$/);

  const stored = await readdir(uploadDirectory);
  assert.deepEqual(stored, [file.storedName]);
  assert.deepEqual(await readFile(path.join(uploadDirectory, file.storedName)), PDF);
});

test("upload rejects a file whose content does not match its declared type", async (t) => {
  const { url, uploadDirectory } = await startApplication(t);

  // 可執行內容偽裝成 PDF：MIME 與副檔名都「正確」，只有內容出賣它。
  const disguised = Buffer.from("#!/bin/sh\nrm -rf /\n");
  const response = await upload(
    url,
    form([{ bytes: disguised, name: "invoice.pdf", type: "application/pdf" }])
  );
  const body = await response.json();

  assert.equal(response.status, 415);
  assert.equal(body.error.code, "UPLOAD_TYPE_MISMATCH");
  assert.match(body.error.message, /content does not match/);
  assert.deepEqual(await readdir(uploadDirectory), [], "rejected uploads must not be stored");
});

test("upload rejects a mismatched extension even when the content is genuine", async (t) => {
  const { url, uploadDirectory } = await startApplication(t);

  const response = await upload(
    url,
    form([{ bytes: PNG, name: "logo.pdf", type: "image/png" }])
  );

  assert.equal(response.status, 415);
  assert.equal((await response.json()).error.code, "UPLOAD_TYPE_MISMATCH");
  assert.deepEqual(await readdir(uploadDirectory), []);
});

test("upload rejects a type outside the route allowlist", async (t) => {
  const { url, uploadDirectory } = await startApplication(t);

  // text/plain 是框架支援的型別，但這條 route 只允許 pdf 與 png。
  const response = await upload(
    url,
    form([{ bytes: Buffer.from("plain"), name: "notes.txt", type: "text/plain" }])
  );

  assert.equal(response.status, 415);
  assert.equal((await response.json()).error.code, "UPLOAD_TYPE_NOT_ALLOWED");
  assert.deepEqual(await readdir(uploadDirectory), []);
});

test("upload enforces the per-file size limit", async (t) => {
  const { url, uploadDirectory } = await startApplication(t);

  const oversized = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(4096, 0x20)]);
  const response = await upload(
    url,
    form([{ bytes: oversized, name: "big.pdf", type: "application/pdf" }])
  );

  assert.equal(response.status, 413);
  assert.equal((await response.json()).error.code, "UPLOAD_FILE_TOO_LARGE");
  assert.deepEqual(await readdir(uploadDirectory), []);
});

test("upload rejects more files than the route allows", async (t) => {
  const { url, uploadDirectory } = await startApplication(t);

  const response = await upload(
    url,
    form([
      { bytes: PDF, name: "a.pdf", type: "application/pdf" },
      { bytes: PDF, name: "b.pdf", type: "application/pdf" },
      { bytes: PDF, name: "c.pdf", type: "application/pdf" }
    ])
  );

  assert.equal(response.status, 413);
  assert.equal((await response.json()).error.code, "UPLOAD_TOO_MANY_FILES");
  assert.deepEqual(await readdir(uploadDirectory), []);
});

test("upload keeps a traversal filename from escaping the storage directory", async (t) => {
  const { url, uploadDirectory } = await startApplication(t);

  const response = await upload(
    url,
    form([{ bytes: PDF, name: "../../escaped.pdf", type: "application/pdf" }])
  );
  const body = await response.json();

  assert.equal(response.status, 201);
  // 落盤名是框架產生的，原始名稱只保留基底部分供 handler 參考。
  assert.match(body.data.files[0].storedName, /^[0-9a-f-]{36}\.pdf$/);
  assert.equal(body.data.files[0].originalName, "escaped.pdf");

  const stored = await readdir(uploadDirectory);
  assert.deepEqual(stored, [body.data.files[0].storedName]);
});

test("upload still applies request schema validation to form fields", async (t) => {
  const { url } = await startApplication(t);

  const response = await upload(
    url,
    form([{ bytes: PDF, name: "a.pdf", type: "application/pdf" }], { title: null })
  );

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "REQUEST_VALIDATION_FAILED");
});

test("upload routes reject a non-multipart request", async (t) => {
  const { url } = await startApplication(t);

  const response = await fetch(`${url}/api/v1/documents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Q3" })
  });

  assert.equal(response.status, 415);
  assert.equal((await response.json()).error.code, "UPLOAD_CONTENT_TYPE_INVALID");
});

test("download streams a stored file outside the JSON envelope", async (t) => {
  const { url } = await startApplication(t);

  const uploaded = await upload(
    url,
    form([{ bytes: PDF, name: "report.pdf", type: "application/pdf" }])
  );
  const { storedName } = (await uploaded.json()).data.files[0];

  const response = await fetch(`${url}/api/v1/reports/${storedName}`);
  const received = Buffer.from(await response.arrayBuffer());

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/pdf");
  assert.equal(response.headers.get("content-length"), String(PDF.length));
  assert.deepEqual(received, PDF);

  // 非 ASCII 檔名要同時提供 RFC 5987 形式。
  const disposition = response.headers.get("content-disposition");
  assert.match(disposition, /^attachment;/);
  assert.match(disposition, /filename\*=UTF-8''/);
  assert.match(response.headers.get("cache-control"), /no-store/);
});

test("download serves generated content from a buffer", async (t) => {
  const { url } = await startApplication(t);

  const response = await fetch(`${url}/api/v1/exports`);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/pdf");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), PDF);
});

test("download rejects a path that escapes the storage directory", async (t) => {
  const { url } = await startApplication(t);

  // 編碼過的穿越路徑會還原成 params，必須由 resolveWithinDirectory 擋下。
  const response = await fetch(`${url}/api/v1/reports/${encodeURIComponent("../../../etc/passwd")}`);

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "NOT_FOUND");
});

test("download returns 404 for a missing file", async (t) => {
  const { url } = await startApplication(t);

  const response = await fetch(`${url}/api/v1/reports/does-not-exist.pdf`);

  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, "NOT_FOUND");
});

test("a handler cannot return a file without declaring download.enabled", async (t) => {
  const { url } = await startApplication(t);

  const response = await fetch(`${url}/api/v1/undeclared`);

  assert.equal(response.status, 500);
  assert.equal((await response.json()).error.code, "INTERNAL_SERVER_ERROR");
});

test("built-in legacy Office types are distinguished from other OLE2 files", async () => {
  const { FileTypeService } = await import(
    "../src/services/filetype/FileTypeService.js"
  );
  const fileTypes = new FileTypeService({});
  const OLE2_HEADER = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  // CFB 的目錄項目名稱以 UTF-16LE 儲存，且不一定落在檔案開頭附近。
  const ole2With = (streamName) =>
    Buffer.concat([
      OLE2_HEADER,
      Buffer.alloc(2048),
      Buffer.from(streamName, "utf16le"),
      Buffer.alloc(512)
    ]);
  const check = (mimeType, fileName, content) =>
    fileTypes.rejectionReason({ mimeType, fileName, content });

  assert.equal(check("application/vnd.ms-excel", "a.xls", ole2With("Workbook")), null);
  assert.equal(check("application/msword", "a.doc", ole2With("WordDocument")), null);
  assert.equal(
    check("application/vnd.ms-powerpoint", "a.ppt", ole2With("PowerPoint Document")),
    null
  );

  // 與 OOXML 不同，舊版格式彼此可以區分。
  assert.match(
    check("application/msword", "a.doc", ole2With("Workbook")),
    /content does not match/
  );

  // OLE2 容器但沒有 Office stream——.msi 安裝檔就是這個形狀，必須擋下。
  assert.match(
    check("application/vnd.ms-excel", "setup.xls", Buffer.concat([OLE2_HEADER, Buffer.alloc(2048)])),
    /content does not match/,
    "a bare OLE2 container must not pass as a spreadsheet"
  );
});

test("built-in archive types match their container signatures", async () => {
  const { FileTypeService } = await import(
    "../src/services/filetype/FileTypeService.js"
  );
  const fileTypes = new FileTypeService({});
  const withHeader = (bytes) => Buffer.concat([Buffer.from(bytes), Buffer.alloc(32)]);
  const check = (mimeType, fileName, content) =>
    fileTypes.rejectionReason({ mimeType, fileName, content });

  const archives = [
    ["application/x-7z-compressed", "a.7z", [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]],
    ["application/vnd.rar", "a.rar", [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]],
    ["application/vnd.rar", "a.rar", [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]],
    ["application/gzip", "a.gz", [0x1f, 0x8b, 0x08]],
    ["application/x-bzip2", "a.bz2", [0x42, 0x5a, 0x68]],
    ["application/x-xz", "a.xz", [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]]
  ];

  for (const [mimeType, fileName, bytes] of archives) {
    assert.equal(check(mimeType, fileName, withHeader(bytes)), null, `${fileName} rejected`);
    assert.match(
      check(mimeType, fileName, Buffer.from("definitely not an archive")),
      /content does not match/,
      `${mimeType} accepted a non-archive`
    );
  }

  // 副檔名只取最後一段，所以 .tar.gz 走 .gz 規則。
  assert.equal(check("application/gzip", "backup.tar.gz", withHeader([0x1f, 0x8b, 0x08])), null);
  assert.equal(check("application/gzip", "backup.tgz", withHeader([0x1f, 0x8b, 0x08])), null);

  // tar 的 magic 在位移 257，不是開頭。
  const tar = Buffer.alloc(1024);
  tar.write("archive-entry.txt", 0, "latin1");
  tar.write("ustar", 257, "latin1");
  assert.equal(check("application/x-tar", "a.tar", tar), null);
  assert.match(check("application/x-tar", "a.tar", Buffer.alloc(1024)), /content does not match/);
});

test("upload config rejects types the file type service does not know", async () => {
  const { normalizeUploadConfig } = await import(
    "../src/framework/upload/normalizeUploadConfig.js"
  );
  const { FileTypeService } = await import(
    "../src/services/filetype/FileTypeService.js"
  );
  const fileTypes = new FileTypeService({});
  const config = {
    enabled: true,
    directory: "storage/uploads",
    allowedMimeTypes: ["application/x-msdownload"]
  };

  assert.throws(
    () => normalizeUploadConfig(config, "upload config", fileTypes),
    /cannot be verified by content/
  );

  // 開發者註冊後同一份設定就會通過，不必改動框架程式碼。
  fileTypes.register("application/x-msdownload", {
    extensions: [".exe"],
    matches: (buffer) => buffer[0] === 0x4d && buffer[1] === 0x5a
  });
  assert.doesNotThrow(() => normalizeUploadConfig(config, "upload config", fileTypes));
});

test("file type service registers custom types and refuses silent overrides", async () => {
  const { FileTypeService } = await import(
    "../src/services/filetype/FileTypeService.js"
  );
  const { isOle2WithStream } = await import(
    "../src/framework/upload/signatureMatchers.js"
  );
  const fileTypes = new FileTypeService({});

  // 內建型別仍在。
  assert.ok(fileTypes.has("application/pdf"));
  assert.deepEqual(fileTypes.extensionsFor("application/pdf"), [".pdf"]);

  // Visio 不在內建清單內，是真正的「自訂型別」情境。
  assert.equal(fileTypes.has("application/vnd.visio"), false);
  fileTypes.register("application/vnd.visio", {
    extensions: [".vsd"],
    matches: isOle2WithStream(["VisioDocument"])
  });

  const visio = Buffer.concat([
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
    Buffer.alloc(1024),
    Buffer.from("VisioDocument", "utf16le")
  ]);
  assert.equal(
    fileTypes.rejectionReason({
      mimeType: "application/vnd.visio",
      fileName: "layout.vsd",
      content: visio
    }),
    null
  );
  // 副檔名與內容仍然分別校驗。
  assert.match(
    fileTypes.rejectionReason({
      mimeType: "application/vnd.visio",
      fileName: "layout.vsdx",
      content: visio
    }),
    /extension does not match/
  );
  assert.match(
    fileTypes.rejectionReason({
      mimeType: "application/vnd.visio",
      fileName: "layout.vsd",
      content: Buffer.from("not an OLE2 file")
    }),
    /content does not match/
  );

  // 放寬內建型別的規則必須是明確的決定。
  assert.throws(
    () => fileTypes.register("application/pdf", { extensions: [".pdf"], matches: () => true }),
    /already registered/
  );
  assert.doesNotThrow(() =>
    fileTypes.register(
      "application/pdf",
      { extensions: [".pdf"], matches: () => true },
      { override: true }
    )
  );

  assert.throws(() => fileTypes.register("nonsense", { extensions: [".x"], matches: () => true }), /MIME type is invalid/);
  assert.throws(() => fileTypes.register("a/b", { extensions: ["x"], matches: () => true }), /starting with a dot/);
  assert.throws(() => fileTypes.register("a/b", { extensions: [".x"] }), /matches\(buffer\)/);
});

test("a custom type registered in the service is accepted end to end", async (t) => {
  const uploadDirectory = await mkdtemp(path.join(os.tmpdir(), "erp-custom-type-"));
  t.after(() => rm(uploadDirectory, { recursive: true, force: true }));

  // Visio 不在內建清單內，必須由 registerCustomTypes() 或注入才可用。
  const VSD = Buffer.concat([
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
    Buffer.alloc(1024),
    Buffer.from("VisioDocument", "utf16le")
  ]);

  class LedgerHandler extends BaseRequestHandler {
    static handlerName = "uploadLedger";
    static api = {
      method: "POST",
      path: "/api/v1/diagrams",
      description: "Accept a Visio diagram.",
      authType: "public",
      authorizationPolicies: [{ name: "allowAll", options: {} }],
      upload: {
        enabled: true,
        directory: uploadDirectory,
        allowedMimeTypes: ["application/vnd.visio"]
      },
      requestSchema: { body: { type: "object", additionalProperties: true } },
      responseSchema: { 201: { type: "object", additionalProperties: true } }
    };

    async execute(req) {
      return this.response({ stored: req.files[0].storedName }, { statusCode: 201 });
    }
  }

  const { isOle2WithStream } = await import(
    "../src/framework/upload/signatureMatchers.js"
  );
  const source = defaultConfigurationSource();
  const application = await createApplication({
    configurationSource: {
      ...source,
      application: { ...source.application, port: 0, shutdownTimeoutMs: 1000 }
    },
    handlerRegistryOptions: {
      moduleUrls: ["virtual:ledger"],
      moduleLoader: async () => ({ LedgerHandler })
    },
    // registerCustomTypes() 的等效注入點，測試不必改動 service 原始碼。
    serviceOptions: {
      filetypes: {
        types: {
          "application/vnd.visio": {
            extensions: [".vsd"],
            matches: isOle2WithStream(["VisioDocument"])
          }
        }
      },
      mysqldatabase: { pool: { query: async () => [[{ ok: 1 }]], end: async () => {} } }
    },
    logger: silentLogger,
    requestLogger: (_req, _res, next) => next(),
    forceExit: () => {
      throw new Error("Custom type test must not force exit");
    }
  });
  t.after(() => application.shutdown("test_cleanup"));

  const { url } = await application.start();
  const data = new FormData();
  data.append("file", new Blob([VSD], { type: "application/vnd.visio" }), "layout.vsd");
  const response = await fetch(`${url}/api/v1/diagrams`, { method: "POST", body: data });
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.match(body.data.stored, /^[0-9a-f-]{36}\.vsd$/);

  // 同一條 route 仍然拒絕內容不符的檔案。
  const bad = new FormData();
  bad.append("file", new Blob([Buffer.from("plain text")], { type: "application/vnd.visio" }), "layout.vsd");
  const rejected = await fetch(`${url}/api/v1/diagrams`, { method: "POST", body: bad });
  assert.equal(rejected.status, 415);
  assert.equal((await rejected.json()).error.code, "UPLOAD_TYPE_MISMATCH");
});
