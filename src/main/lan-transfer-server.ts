import { randomBytes, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, promises as fsp } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import {
  contentDisposition,
  isAllowedRemote,
  normalizeRemoteAddress,
  parseRange,
  sanitizeFileName,
  tokenMatches,
  uniqueFilePath,
  uniqueZipNames,
  zipArchiveSize,
  ZipWriter,
  ZIP_MAX_BYTES,
} from "../core/lan-transfer";

export interface SharedFile {
  id: string;
  path: string;
  name: string;
  size: number;
  mtime: number;
}

export interface ReceivedFile {
  id: string;
  path: string;
  name: string;
  size: number;
  from: string;
  at: number;
}

export type TransferDirection = "send" | "receive";

export interface TransferProgress {
  id: string;
  direction: TransferDirection;
  name: string;
  transferred: number;
  total: number;
  done: boolean;
  ok?: boolean;
  message?: string;
}

export interface LanServerEvents {
  onClient?: (address: string) => void;
  onProgress?: (progress: TransferProgress) => void;
  onReceived?: (file: ReceivedFile) => void;
  onActivity?: () => void;
}

export interface LanServerOptions extends LanServerEvents {
  /** Directory for files uploaded from the phone. Resolved per upload. */
  receiveDir: () => string;
  /** The single-page phone UI. */
  mobileHtml: () => Promise<string>;
  /** Bind address; tests use 127.0.0.1. */
  host?: string;
  /** Largest single upload, in bytes. */
  maxUploadBytes?: number;
}

const DEFAULT_MAX_UPLOAD = 20 * 1024 ** 3;
const PROGRESS_INTERVAL_MS = 200;

/**
 * Token-protected HTTP server for one LAN transfer session. The phone loads
 * `/?t=<token>`; every API call must carry the same token (query `t` or the
 * `x-dockwisp-token` header). Only loopback and private LAN peers are served.
 */
export class LanTransferServer {
  readonly token = randomBytes(18).toString("base64url");
  private server: http.Server | null = null;
  private files: SharedFile[] = [];
  private readonly clients = new Set<string>();
  private readonly options: LanServerOptions;

  constructor(options: LanServerOptions) {
    this.options = options;
  }

  get port(): number {
    const address = this.server?.address() as AddressInfo | null;
    return address?.port ?? 0;
  }

  get running(): boolean {
    return this.server !== null;
  }

  async start(port = 0): Promise<number> {
    if (this.server) return this.port;
    const server = http.createServer((request, response) => {
      void this.handle(request, response).catch(() => {
        if (!response.headersSent) this.send(response, 500, { error: "server error" });
        else response.destroy();
      });
    });
    server.requestTimeout = 0;
    server.headersTimeout = 30_000;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, this.options.host ?? "0.0.0.0", () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.server = server;
    return this.port;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  setFiles(files: SharedFile[]): void {
    this.files = files.slice();
  }

  // --- Request handling ------------------------------------------------------

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const remote = normalizeRemoteAddress(request.socket.remoteAddress);
    if (!isAllowedRemote(remote)) {
      request.socket.destroy();
      return;
    }
    const url = new URL(request.url ?? "/", "http://localhost");
    const token = url.searchParams.get("t") ?? request.headers["x-dockwisp-token"];
    if (!tokenMatches(this.token, token)) {
      this.send(response, 403, { error: "链接已失效，请在电脑上重新扫码" }, request.method === "GET" && url.pathname === "/");
      return;
    }
    this.options.onActivity?.();
    if (!this.clients.has(remote)) {
      this.clients.add(remote);
      this.options.onClient?.(remote);
    }
    const method = request.method ?? "GET";
    if (method === "GET" && url.pathname === "/") return this.servePage(response);
    if (method === "GET" && url.pathname === "/api/files") {
      return this.send(response, 200, {
        files: this.files.map(({ id, name, size, mtime }) => ({ id, name, size, mtime })),
      });
    }
    if ((method === "GET" || method === "HEAD") && url.pathname.startsWith("/api/file/")) {
      return this.serveFile(request, response, decodeURIComponent(url.pathname.slice(10)), url.searchParams.has("inline"));
    }
    if (method === "GET" && url.pathname === "/api/zip") {
      const ids = url.searchParams.get("ids");
      return this.serveZip(response, ids ? ids.split(",") : null);
    }
    if (method === "POST" && url.pathname === "/api/upload") {
      return this.receive(request, response, url.searchParams.get("name"), remote);
    }
    this.send(response, 404, { error: "not found" });
  }

  private send(response: http.ServerResponse, status: number, body: unknown, asHtml = false): void {
    if (asHtml) {
      const message = (body as { error?: string }).error ?? "";
      response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(
        `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Dockwisp</title><p style="font:16px system-ui;padding:24px;text-align:center">${message}</p>`,
      );
      return;
    }
    response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    response.end(JSON.stringify(body));
  }

  private async servePage(response: http.ServerResponse): Promise<void> {
    const html = await this.options.mobileHtml();
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "content-security-policy":
        "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'",
    });
    response.end(html);
  }

  private progressReporter(id: string, direction: TransferDirection, name: string, total: number) {
    let transferred = 0;
    let last = 0;
    const emit = (done: boolean, ok?: boolean, message?: string) =>
      this.options.onProgress?.({ id, direction, name, transferred, total, done, ok, message });
    return {
      add: (bytes: number) => {
        transferred += bytes;
        const now = Date.now();
        if (now - last >= PROGRESS_INTERVAL_MS) {
          last = now;
          this.options.onActivity?.();
          emit(false);
        }
      },
      finish: (ok: boolean, message?: string) => emit(true, ok, message),
      get transferred() {
        return transferred;
      },
    };
  }

  private async serveFile(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    id: string,
    inline: boolean,
  ): Promise<void> {
    const file = this.files.find((item) => item.id === id);
    if (!file) return this.send(response, 404, { error: "文件不存在" });
    let size: number;
    try {
      const stats = await fsp.stat(file.path);
      if (!stats.isFile()) throw new Error("not a file");
      size = stats.size;
    } catch {
      return this.send(response, 410, { error: "文件已被移动或删除" });
    }
    const range = parseRange(request.headers.range, size);
    if (range === "invalid") {
      response.writeHead(416, { "content-range": `bytes */${size}` });
      response.end();
      return;
    }
    const start = range ? range.start : 0;
    const end = range ? range.end : size - 1;
    const length = size === 0 ? 0 : end - start + 1;
    response.writeHead(range ? 206 : 200, {
      "content-type": "application/octet-stream",
      "content-length": String(length),
      "accept-ranges": "bytes",
      "content-disposition": contentDisposition(file.name, inline),
      "cache-control": "no-store",
      ...(range ? { "content-range": `bytes ${start}-${end}/${size}` } : {}),
    });
    if (request.method === "HEAD" || length === 0) {
      response.end();
      return;
    }
    // Media players probe with small ranges; only report full downloads.
    const report = !range || start === 0 ? this.progressReporter(randomUUID(), "send", file.name, length) : null;
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        report?.add(chunk.length);
        callback(null, chunk);
      },
    });
    try {
      await pipeline(createReadStream(file.path, { start, end }), counter, response);
      report?.finish(true);
    } catch {
      report?.finish(false, "传输中断");
    }
  }

  private async serveZip(
    response: http.ServerResponse,
    ids: string[] | null,
  ): Promise<void> {
    const chosen = ids ? this.files.filter((file) => ids.includes(file.id)) : this.files.slice();
    const entries: Array<SharedFile & { zipName: string; size: number; mtimeDate: Date }> = [];
    const names = uniqueZipNames(chosen.map((file) => file.name));
    for (const [index, file] of chosen.entries()) {
      try {
        const stats = await fsp.stat(file.path);
        if (stats.isFile()) entries.push({ ...file, zipName: names[index], size: stats.size, mtimeDate: stats.mtime });
      } catch {
        // Skip files that disappeared.
      }
    }
    if (entries.length === 0) return this.send(response, 404, { error: "没有可打包的文件" });
    const total = zipArchiveSize(entries.map((entry) => ({ name: entry.zipName, size: entry.size })));
    if (total > ZIP_MAX_BYTES) return this.send(response, 413, { error: "文件总大小超过 4 GB，请逐个下载" });
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
    response.writeHead(200, {
      "content-type": "application/zip",
      "content-length": String(total),
      "content-disposition": contentDisposition(`Dockwisp-${stamp}.zip`),
      "cache-control": "no-store",
    });
    const report = this.progressReporter(randomUUID(), "send", `${entries.length} 个文件（zip）`, total);
    const zip = new ZipWriter();
    const write = (chunk: Buffer) =>
      new Promise<void>((resolve, reject) => {
        if (response.destroyed) return reject(new Error("closed"));
        report.add(chunk.length);
        if (response.write(chunk)) resolve();
        else {
          const onDrain = () => {
            response.off("close", onClose);
            resolve();
          };
          const onClose = () => {
            response.off("drain", onDrain);
            reject(new Error("closed"));
          };
          response.once("drain", onDrain);
          response.once("close", onClose);
        }
      });
    try {
      for (const entry of entries) {
        await write(zip.begin({ name: entry.zipName, size: entry.size, mtime: entry.mtimeDate }));
        // Read exactly the size we announced so Content-Length stays honest
        // even if the file changes mid-transfer.
        if (entry.size > 0) {
          let remaining = entry.size;
          for await (const chunk of createReadStream(entry.path, { start: 0, end: entry.size - 1 })) {
            const piece = chunk as Buffer;
            remaining -= piece.length;
            await write(zip.data(piece));
          }
          if (remaining > 0) throw new Error("file shrank");
        }
        await write(zip.end());
      }
      await write(zip.finish());
      response.end();
      report.finish(true);
    } catch {
      report.finish(false, "传输中断");
      response.destroy();
    }
  }

  private async receive(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    rawName: string | null,
    remote: string,
  ): Promise<void> {
    const name = sanitizeFileName(rawName);
    const declared = Number(request.headers["content-length"] ?? NaN);
    const limit = this.options.maxUploadBytes ?? DEFAULT_MAX_UPLOAD;
    if (Number.isFinite(declared) && declared > limit) {
      request.resume();
      return this.send(response, 413, { error: "文件过大" });
    }
    const directory = this.options.receiveDir();
    try {
      await fsp.mkdir(directory, { recursive: true });
    } catch {
      request.resume();
      return this.send(response, 500, { error: "无法创建保存目录" });
    }
    const target = uniqueFilePath(directory, name, (candidate) => existsSync(candidate));
    const partial = `${target}.dockwisp-part`;
    const id = randomUUID();
    const report = this.progressReporter(id, "receive", path.basename(target), Number.isFinite(declared) ? declared : 0);
    let received = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        if (received > limit) return callback(new Error("too large"));
        report.add(chunk.length);
        callback(null, chunk);
      },
    });
    try {
      await pipeline(request, counter, createWriteStream(partial, { flags: "wx" }));
      if (Number.isFinite(declared) && received !== declared) throw new Error("incomplete");
      // Another upload may have claimed the name while this one streamed.
      const finalPath = existsSync(target)
        ? uniqueFilePath(directory, path.basename(target), (candidate) => existsSync(candidate))
        : target;
      await fsp.rename(partial, finalPath);
      report.finish(true);
      const file: ReceivedFile = {
        id,
        path: finalPath,
        name: path.basename(finalPath),
        size: received,
        from: remote,
        at: Date.now(),
      };
      this.options.onReceived?.(file);
      this.send(response, 200, { ok: true, name: file.name, size: received });
    } catch (error) {
      await fsp.rm(partial, { force: true }).catch(() => undefined);
      report.finish(false, "上传中断");
      if (!response.headersSent && !response.destroyed) {
        const tooLarge = error instanceof Error && error.message === "too large";
        this.send(response, tooLarge ? 413 : 400, { error: tooLarge ? "文件过大" : "上传未完成" });
      }
    }
  }
}
