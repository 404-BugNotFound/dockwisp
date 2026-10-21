import {
  app,
  BrowserWindow,
  ipcMain,
  nativeTheme,
  screen,
} from "electron";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mergeManagedBlock, stripManagedBlock } from "../core/hosts";
import { SettingsStore } from "./settings";

type ProfileType = "user" | "remote";

interface HostsProfile {
  id: string;
  name: string;
  content: string;
  enabled: boolean;
  type: ProfileType;
  url?: string;
  fetchedAt?: number;
}

interface ProfilesFile {
  exclusive: boolean;
  profiles: HostsProfile[];
}

interface HostsStateDto {
  theme: "light" | "dark";
  exclusive: boolean;
  profiles: HostsProfile[];
  systemContent: string;
  systemPath: string;
}

interface MutationResult {
  ok: boolean;
  message?: string;
  state?: HostsStateDto;
}

interface ApplyResult {
  ok: boolean;
  method?: "direct" | "elevated";
  message?: string;
  cancelled?: boolean;
  systemContent?: string;
}

const MAX_REMOTE_BYTES = 2 * 1024 * 1024;
const REMOTE_TIMEOUT_MS = 15_000;

/**
 * Owns the standalone "hosts switcher" window. Profile data lives in
 * userData/hosts/profiles.json; the system hosts file is only touched on an
 * explicit "apply", which merges every enabled profile into a marked block and
 * preserves whatever the user keeps outside the markers. Writing falls back to
 * an elevated copy when the process lacks permission.
 */
export class HostsController {
  private window: BrowserWindow | null = null;
  private readonly hostsDir: string;
  private readonly profilesPath: string;
  private readonly backupPath: string;
  private readonly systemHostsPath: string;
  private data: ProfilesFile;

  constructor(private readonly settings: SettingsStore) {
    this.hostsDir = path.join(app.getPath("userData"), "hosts");
    mkdirSync(this.hostsDir, { recursive: true });
    this.profilesPath = path.join(this.hostsDir, "profiles.json");
    this.backupPath = path.join(this.hostsDir, "hosts.backup");
    const systemRoot = process.env.SystemRoot || "C:\\Windows";
    this.systemHostsPath = path.join(
      systemRoot,
      "System32",
      "drivers",
      "etc",
      "hosts",
    );
    this.data = this.readProfiles();
    this.registerIpc();
  }

  open(): void {
    this.data = this.readProfiles();
    const window = this.ensureWindow();
    void this.pushState();
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }

  // ---- window lifecycle -------------------------------------------------

  private resolveTheme(): "light" | "dark" {
    const preference = this.settings.get().theme;
    if (preference === "system") {
      return nativeTheme.shouldUseDarkColors ? "dark" : "light";
    }
    return preference;
  }

  private ensureWindow(): BrowserWindow {
    if (this.window && !this.window.isDestroyed()) return this.window;
    const theme = this.resolveTheme();
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const width = Math.min(1040, Math.max(720, display.workArea.width - 80));
    const height = Math.min(720, Math.max(480, display.workArea.height - 80));
    const x = Math.round(display.workArea.x + (display.workArea.width - width) / 2);
    const y = Math.round(display.workArea.y + (display.workArea.height - height) / 2);
    const window = new BrowserWindow({
      x,
      y,
      width,
      height,
      minWidth: 680,
      minHeight: 460,
      show: false,
      frame: true,
      autoHideMenuBar: true,
      hasShadow: true,
      backgroundColor: theme === "dark" ? "#1b1c23" : "#f3f4f8",
      title: "Hosts 切换",
      webPreferences: {
        preload: path.join(__dirname, "..", "preload", "hosts.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    this.window = window;
    window.on("closed", () => {
      if (this.window === window) this.window = null;
    });
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.once("did-finish-load", () => {
      if (!window.isDestroyed()) void this.pushState();
    });
    void window.loadFile(
      path.join(__dirname, "..", "renderer", "hosts", "index.html"),
    );
    return window;
  }

  private fromWindow(
    event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent,
  ): boolean {
    return (
      this.window !== null &&
      !this.window.isDestroyed() &&
      event.sender === this.window.webContents
    );
  }

  // ---- profile persistence ---------------------------------------------

  private readProfiles(): ProfilesFile {
    if (!existsSync(this.profilesPath)) return { exclusive: false, profiles: [] };
    try {
      const parsed = JSON.parse(readFileSync(this.profilesPath, "utf8"));
      return this.normalizeProfiles(parsed);
    } catch {
      return { exclusive: false, profiles: [] };
    }
  }

  private normalizeProfiles(value: unknown): ProfilesFile {
    if (!value || typeof value !== "object") return { exclusive: false, profiles: [] };
    const raw = value as Record<string, unknown>;
    const exclusive = raw.exclusive === true;
    const list = Array.isArray(raw.profiles) ? raw.profiles : [];
    const profiles: HostsProfile[] = [];
    const seen = new Set<string>();
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const id = typeof record.id === "string" ? record.id : randomUUID();
      if (seen.has(id)) continue;
      seen.add(id);
      const type: ProfileType = record.type === "remote" ? "remote" : "user";
      const profile: HostsProfile = {
        id,
        name: typeof record.name === "string" && record.name.trim()
          ? record.name.trim()
          : "未命名方案",
        content: typeof record.content === "string" ? record.content : "",
        enabled: record.enabled === true,
        type,
      };
      if (type === "remote" && typeof record.url === "string") profile.url = record.url;
      if (typeof record.fetchedAt === "number") profile.fetchedAt = record.fetchedAt;
      profiles.push(profile);
    }
    // Exclusive mode must never keep more than one profile enabled.
    if (exclusive) {
      let kept = false;
      for (const profile of profiles) {
        if (profile.enabled && kept) profile.enabled = false;
        else if (profile.enabled) kept = true;
      }
    }
    return { exclusive, profiles };
  }

  private writeProfiles(): void {
    const temporary = `${this.profilesPath}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.data, null, 2)}\n`, "utf8");
    renameSync(temporary, this.profilesPath);
  }

  private findProfile(id: string): HostsProfile | undefined {
    return this.data.profiles.find((profile) => profile.id === id);
  }

  // ---- state push -------------------------------------------------------

  private readSystemHosts(): string {
    try {
      return readFileSync(this.systemHostsPath, "utf8");
    } catch {
      return "";
    }
  }

  private buildState(): HostsStateDto {
    return {
      theme: this.resolveTheme(),
      exclusive: this.data.exclusive,
      profiles: this.data.profiles.map((profile) => ({ ...profile })),
      systemContent: this.readSystemHosts(),
      systemPath: this.systemHostsPath,
    };
  }

  private async pushState(): Promise<void> {
    if (!this.window || this.window.isDestroyed()) return;
    this.window.webContents.send("hosts:state", this.buildState());
  }

  private ok(): MutationResult {
    this.writeProfiles();
    return { ok: true, state: this.buildState() };
  }

  // ---- hosts writing ----------------------------------------------------

  private ensureBackup(original: string): void {
    if (existsSync(this.backupPath)) return;
    try {
      writeFileSync(this.backupPath, original, "utf8");
    } catch {
      // A missing backup should not block applying; the original is still
      // recoverable from the public portion outside the markers.
    }
  }

  private isPermissionError(error: unknown): boolean {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return code === "EPERM" || code === "EACCES";
  }

  /**
   * Copy a temp file onto the system hosts with an elevated shell, then flush
   * DNS. Resolves to a result describing success, failure, or a cancelled UAC
   * prompt (PowerShell throws when the user declines elevation).
   */
  private elevatedCopy(tempFile: string): Promise<ApplyResult> {
    return new Promise((resolve) => {
      const target = this.systemHostsPath;
      // Run a generated .cmd elevated instead of nesting quotes through
      // node -> PowerShell -> Start-Process -> cmd. Paths reach PowerShell via
      // an environment variable, so spaces/quotes in them cannot break parsing.
      const cmdFile = tempFile.replace(/\.txt$/i, ".cmd");
      try {
        writeFileSync(
          cmdFile,
          [
            "@echo off",
            "chcp 65001 >nul",
            `copy /y "${tempFile}" "${target}" >nul || exit /b 1`,
            "ipconfig /flushdns >nul",
            "exit /b 0",
            "",
          ].join("\r\n"),
          "utf8",
        );
      } catch (error) {
        resolve({ ok: false, message: `无法写入提权脚本：${(error as Error).message}` });
        return;
      }
      const cleanup = () => {
        for (const file of [cmdFile, tempFile]) rm(file, { force: true }).catch(() => {});
      };
      const script =
        "$ErrorActionPreference='Stop'; try { " +
        "$p = Start-Process -FilePath $env:DW_HOSTS_CMD -Verb RunAs -WindowStyle Hidden -Wait -PassThru; " +
        "exit $p.ExitCode } catch { exit 1223 }";

      const child = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        { windowsHide: true, env: { ...process.env, DW_HOSTS_CMD: cmdFile } },
      );
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.on("error", (error) => {
        cleanup();
        resolve({ ok: false, message: `无法启动提权进程：${error.message}` });
      });
      child.on("close", (code) => {
        cleanup();
        // 1223 == ERROR_CANCELLED: the user dismissed the UAC dialog.
        if (code === 1223) {
          resolve({
            ok: false,
            cancelled: true,
            message: "已取消管理员授权，未写入系统 hosts。",
          });
          return;
        }
        if (code === 0) {
          resolve({ ok: true, method: "elevated" });
          return;
        }
        resolve({
          ok: false,
          message: stderr.trim() || `提权写入失败（退出码 ${code}）。`,
        });
      });
    });
  }

  private flushDns(): void {
    try {
      const child = spawn("ipconfig", ["/flushdns"], { windowsHide: true });
      child.on("error", () => {
        // Best-effort; a failed flush does not undo a successful write.
      });
    } catch {
      // Ignore.
    }
  }

  private async applyToSystem(): Promise<ApplyResult> {
    const original = this.readSystemHosts();
    this.ensureBackup(original);

    const enabled = this.data.profiles.filter((profile) => profile.enabled);
    // Rebuild from the public portion so repeated applies stay idempotent.
    const publicPortion = stripManagedBlock(original);
    const merged = mergeManagedBlock(
      publicPortion,
      enabled.map((profile) => ({ name: profile.name, content: profile.content })),
    );

    // Already identical — nothing to write, no elevation prompt.
    if (merged === original) {
      return { ok: true, method: "direct", systemContent: original };
    }

    try {
      await writeFile(this.systemHostsPath, merged, "utf8");
      this.flushDns();
      return { ok: true, method: "direct", systemContent: merged };
    } catch (error) {
      if (!this.isPermissionError(error)) {
        return {
          ok: false,
          message: `写入系统 hosts 失败：${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
    }

    // Permission denied: stage to a temp file and copy it in with elevation.
    const tempFile = path.join(tmpdir(), `dockwisp-hosts-${randomUUID()}.txt`);
    try {
      await writeFile(tempFile, merged, "utf8");
    } catch (error) {
      return {
        ok: false,
        message: `无法写入临时文件：${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }

    const result = await this.elevatedCopy(tempFile);
    if (result.ok) {
      const after = this.readSystemHosts();
      // Verify the copy actually landed.
      if (after.replace(/\r\n/g, "\n") !== merged.replace(/\r\n/g, "\n")) {
        return { ok: false, message: "提权写入后内容校验不一致，请重试。" };
      }
      return { ...result, systemContent: after };
    }
    return result;
  }

  // ---- remote import ----------------------------------------------------

  private async fetchRemote(url: string): Promise<{ ok: boolean; content?: string; message?: string }> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { ok: false, message: "URL 格式无效。" };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { ok: false, message: "仅支持 http/https 地址。" };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REMOTE_TIMEOUT_MS);
    try {
      const response = await fetch(parsed.toString(), { signal: controller.signal });
      if (!response.ok) {
        return { ok: false, message: `远程返回 ${response.status}。` };
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > MAX_REMOTE_BYTES) {
        return { ok: false, message: "远程内容过大（上限 2 MB）。" };
      }
      return { ok: true, content: buffer.toString("utf8") };
    } catch (error) {
      if ((error as Error)?.name === "AbortError") {
        return { ok: false, message: "请求超时。" };
      }
      return {
        ok: false,
        message: `拉取失败：${error instanceof Error ? error.message : String(error)}`,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  // ---- ipc --------------------------------------------------------------

  private applyExclusivity(enabledId: string): void {
    if (!this.data.exclusive) return;
    for (const profile of this.data.profiles) {
      profile.enabled = profile.id === enabledId;
    }
  }

  private registerIpc(): void {
    ipcMain.on("hosts:close", (event) => {
      if (!this.fromWindow(event)) return;
      this.window?.close();
    });

    ipcMain.handle("hosts:request-state", (event) => {
      if (!this.fromWindow(event)) return null;
      return this.buildState();
    });

    ipcMain.handle("hosts:create", (event, name: unknown) => {
      if (!this.fromWindow(event)) return { ok: false } satisfies MutationResult;
      const label = typeof name === "string" && name.trim() ? name.trim() : "新方案";
      this.data.profiles.push({
        id: randomUUID(),
        name: label,
        content: "",
        enabled: false,
        type: "user",
      });
      return this.ok();
    });

    ipcMain.handle("hosts:rename", (event, id: unknown, name: unknown) => {
      if (!this.fromWindow(event)) return { ok: false } satisfies MutationResult;
      const profile = typeof id === "string" ? this.findProfile(id) : undefined;
      if (!profile) return { ok: false, message: "方案不存在。" };
      if (typeof name !== "string" || !name.trim()) {
        return { ok: false, message: "名称不能为空。" };
      }
      profile.name = name.trim();
      return this.ok();
    });

    ipcMain.handle("hosts:delete", (event, id: unknown) => {
      if (!this.fromWindow(event)) return { ok: false } satisfies MutationResult;
      const index = this.data.profiles.findIndex((profile) => profile.id === id);
      if (index < 0) return { ok: false, message: "方案不存在。" };
      this.data.profiles.splice(index, 1);
      return this.ok();
    });

    ipcMain.handle("hosts:set-enabled", (event, id: unknown, enabled: unknown) => {
      if (!this.fromWindow(event)) return { ok: false } satisfies MutationResult;
      const profile = typeof id === "string" ? this.findProfile(id) : undefined;
      if (!profile) return { ok: false, message: "方案不存在。" };
      const next = enabled === true;
      if (next && this.data.exclusive) this.applyExclusivity(profile.id);
      profile.enabled = next;
      return this.ok();
    });

    ipcMain.handle("hosts:update-content", (event, id: unknown, content: unknown) => {
      if (!this.fromWindow(event)) return { ok: false } satisfies MutationResult;
      const profile = typeof id === "string" ? this.findProfile(id) : undefined;
      if (!profile) return { ok: false, message: "方案不存在。" };
      profile.content = typeof content === "string" ? content : "";
      return this.ok();
    });

    ipcMain.handle("hosts:set-exclusive", (event, exclusive: unknown) => {
      if (!this.fromWindow(event)) return { ok: false } satisfies MutationResult;
      this.data.exclusive = exclusive === true;
      if (this.data.exclusive) {
        // Keep only the first enabled profile on.
        const firstEnabled = this.data.profiles.find((profile) => profile.enabled);
        if (firstEnabled) this.applyExclusivity(firstEnabled.id);
      }
      return this.ok();
    });

    ipcMain.handle("hosts:import-remote", async (event, name: unknown, url: unknown) => {
      if (!this.fromWindow(event)) return { ok: false } satisfies MutationResult;
      if (typeof url !== "string" || !url.trim()) {
        return { ok: false, message: "请填写远程地址。" };
      }
      const result = await this.fetchRemote(url.trim());
      if (!result.ok) return { ok: false, message: result.message };
      const label =
        typeof name === "string" && name.trim() ? name.trim() : "远程方案";
      this.data.profiles.push({
        id: randomUUID(),
        name: label,
        content: result.content ?? "",
        enabled: false,
        type: "remote",
        url: url.trim(),
        fetchedAt: Date.now(),
      });
      return this.ok();
    });

    ipcMain.handle("hosts:refresh-remote", async (event, id: unknown) => {
      if (!this.fromWindow(event)) return { ok: false } satisfies MutationResult;
      const profile = typeof id === "string" ? this.findProfile(id) : undefined;
      if (!profile || profile.type !== "remote" || !profile.url) {
        return { ok: false, message: "不是远程方案。" };
      }
      const result = await this.fetchRemote(profile.url);
      if (!result.ok) return { ok: false, message: result.message };
      profile.content = result.content ?? "";
      profile.fetchedAt = Date.now();
      return this.ok();
    });

    ipcMain.handle("hosts:apply", async (event) => {
      if (!this.fromWindow(event)) return { ok: false } satisfies ApplyResult;
      const result = await this.applyToSystem();
      void this.pushState();
      return result;
    });
  }
}
