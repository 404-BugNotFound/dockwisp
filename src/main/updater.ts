import { app, BrowserWindow, ipcMain, net, shell, type IpcMainInvokeEvent } from "electron";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import {
  interpretRelease,
  type ReleaseJson,
  type UpdateInfo,
} from "../core/version";

// GitHub Release 来源（固定仓库）。
const RELEASES_API =
  "https://api.github.com/repos/404-BugNotFound/dockwisp/releases/latest";
const RELEASES_PAGE =
  "https://github.com/404-BugNotFound/dockwisp/releases/latest";
// GitHub API 要求带 User-Agent，否则返回 403。
const USER_AGENT = "Dockwisp-Updater";
// 允许重定向的最大跳数（资产下载会经由 302 转到对象存储）。
const MAX_REDIRECTS = 5;

export interface RegisterUpdaterOptions {
  getWindow: () => BrowserWindow | null;
  // 安装前回调：调用方在此设置 quitting 标记，确保 app.quit() 真正退出。
  onBeforeInstall: () => void | Promise<void>;
}

interface DownloadRequest {
  url: string;
  assetName: string;
  sha256?: string | null;
  version?: string;
}

interface DownloadResult {
  ok: boolean;
  path?: string;
  verified?: boolean;
  message?: string;
}

// 记录最近一次成功下载的安装包路径，供 install 使用。
let lastDownloadedInstaller: string | null = null;
// 最近一次检查到的可用更新；下载只接受这里的地址与摘要，不信任渲染进程传入的 URL。
let lastCheck: UpdateInfo | null = null;

function updateDir(): string {
  return path.join(app.getPath("temp"), "dockwisp-update");
}

/** 发起一次带 User-Agent、跟随重定向的 GET 请求，返回完整响应体（文本）。 */
function fetchText(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = net.request({ method: "GET", url, redirect: "follow" });
    request.setHeader("User-Agent", USER_AGENT);
    request.setHeader("Accept", "application/vnd.github+json");
    request.on("response", (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
      response.on("error", (error: Error) => reject(error));
    });
    request.on("error", (error) => reject(error));
    request.end();
  });
}

/**
 * 下载 URL 到目标文件，边下边写，通过 onProgress 回报进度，并计算 sha256。
 * 使用 Electron net，redirect:"follow" 自动处理 GitHub 资产的 302。
 */
function downloadToFile(
  url: string,
  destination: string,
  onProgress: (received: number, total: number) => void,
): Promise<{ sha256: string; bytes: number }> {
  return new Promise((resolve, reject) => {
    const request = net.request({ method: "GET", url, redirect: "follow" });
    request.setHeader("User-Agent", USER_AGENT);
    request.setHeader("Accept", "application/octet-stream");

    let redirects = 0;
    request.on("redirect", (_status, _method, redirectUrl) => {
      redirects += 1;
      if (redirects > MAX_REDIRECTS) {
        request.abort();
        reject(new Error("重定向次数过多"));
        return;
      }
      request.followRedirect();
    });

    request.on("response", (response) => {
      const status = response.statusCode ?? 0;
      if (status < 200 || status >= 300) {
        request.abort();
        reject(new Error(`下载失败：HTTP ${status}`));
        return;
      }

      const totalHeader = response.headers["content-length"];
      const totalRaw = Array.isArray(totalHeader) ? totalHeader[0] : totalHeader;
      const total = totalRaw ? Number(totalRaw) : 0;

      const hash = createHash("sha256");
      const fileStream = createWriteStream(destination);
      let received = 0;
      let settled = false;

      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        fileStream.destroy();
        reject(error);
      };

      response.on("data", (chunk) => {
        const buffer = Buffer.from(chunk);
        received += buffer.length;
        hash.update(buffer);
        fileStream.write(buffer);
        onProgress(received, Number.isFinite(total) ? total : 0);
      });
      response.on("end", () => {
        if (settled) return;
        fileStream.end(() => {
          settled = true;
          resolve({ sha256: hash.digest("hex"), bytes: received });
        });
      });
      response.on("error", (error: Error) => fail(error));
      fileStream.on("error", (error) => fail(error));
    });

    request.on("error", (error) => reject(error));
    request.end();
  });
}

async function handleCheck(currentVersion: string): Promise<UpdateInfo> {
  try {
    const { status, body } = await fetchText(RELEASES_API);
    if (status === 404) {
      return { status: "error", current: currentVersion, message: "尚未发布任何版本" };
    }
    if (status < 200 || status >= 300) {
      return {
        status: "error",
        current: currentVersion,
        message: `检查更新失败：HTTP ${status}`,
      };
    }
    let release: ReleaseJson;
    try {
      release = JSON.parse(body) as ReleaseJson;
    } catch {
      return { status: "error", current: currentVersion, message: "解析发布信息失败" };
    }
    const info = interpretRelease(release, currentVersion);
    lastCheck = info.status === "available" ? info : null;
    return info;
  } catch (error) {
    return {
      status: "error",
      current: currentVersion,
      message: `无法连接到更新服务器：${(error as Error).message}`,
    };
  }
}

async function handleDownload(
  event: IpcMainInvokeEvent,
  payload: DownloadRequest,
): Promise<DownloadResult> {
  if (!lastCheck?.downloadUrl || !payload || payload.url !== lastCheck.downloadUrl) {
    return { ok: false, message: "请先检查更新" };
  }
  payload = {
    url: lastCheck.downloadUrl,
    assetName: lastCheck.assetName ?? "",
    sha256: lastCheck.sha256 ?? null,
    version: lastCheck.latest,
  };
  const assetName =
    typeof payload.assetName === "string" && payload.assetName
      ? path.basename(payload.assetName)
      : "Dockwisp-update-x64.exe";

  const dir = updateDir();
  const destination = path.join(dir, assetName);

  try {
    // 重建下载目录，避免残留旧安装包。
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });

    const sender = event.sender;
    const { sha256, bytes } = await downloadToFile(payload.url, destination, (received, total) => {
      if (!sender.isDestroyed()) {
        sender.send("updater:progress", { received, total });
      }
    });

    // 下载内容为空视为失败。
    if (bytes === 0) {
      await rm(destination, { force: true });
      return { ok: false, message: "下载内容为空" };
    }

    const expected = typeof payload.sha256 === "string" ? payload.sha256.toLowerCase() : null;
    if (expected) {
      if (sha256 !== expected) {
        await rm(destination, { force: true });
        return { ok: false, message: "文件校验失败（sha256 不匹配），已删除下载文件" };
      }
      lastDownloadedInstaller = destination;
      return { ok: true, path: destination, verified: true };
    }

    // 无摘要可校验：下载成功但未校验，交由 UI 提示用户。
    lastDownloadedInstaller = destination;
    return { ok: true, path: destination, verified: false };
  } catch (error) {
    await rm(destination, { force: true }).catch(() => undefined);
    return { ok: false, message: `下载失败：${(error as Error).message}` };
  }
}

async function handleInstall(
  options: RegisterUpdaterOptions,
  requestedPath?: string,
): Promise<{ ok: boolean; message?: string }> {
  // 只运行本进程下载并校验过的安装包，忽略渲染进程传入的路径。
  void requestedPath;
  const installer = lastDownloadedInstaller;
  if (!installer) {
    return { ok: false, message: "没有可安装的更新文件" };
  }
  try {
    await stat(installer);
  } catch {
    return { ok: false, message: "安装文件不存在，请重新下载" };
  }

  try {
    // 通知主进程进入退出流程，并结束会锁住安装目录文件的子进程。
    await options.onBeforeInstall();
  } catch (error) {
    return { ok: false, message: `安装前准备失败：${(error as Error).message}` };
  }

  try {
    // NSIS 静默安装：--force-run 让安装完成后重新启动应用（electron-builder 的 isForceRun），
    // --updated 标记这是升级（保留用户数据、跳过首次安装流程）。
    const child = spawn(installer, ["/S", "--updated", "--force-run"], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch (error) {
    return { ok: false, message: `启动安装程序失败：${(error as Error).message}` };
  }

  // 稍后退出，让 spawn 完成分离。
  setTimeout(() => app.quit(), 200);
  return { ok: true };
}

/**
 * 注册“检查更新 / 下载 / 安装”相关的 IPC 处理器。
 * 由主进程在应用就绪后调用一次。
 */
export function registerUpdater(options: RegisterUpdaterOptions): void {
  ipcMain.handle("updater:check", async () => handleCheck(app.getVersion()));

  ipcMain.handle("updater:download", async (event, payload: DownloadRequest) =>
    handleDownload(event, payload),
  );

  ipcMain.handle("updater:install", async (_event, requestedPath?: string) =>
    handleInstall(options, requestedPath),
  );

  ipcMain.handle("updater:open-release", async () => {
    await shell.openExternal(RELEASES_PAGE);
    return { ok: true };
  });
}
