import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  shell,
  Tray,
} from "electron";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildSearchForms,
  mergeMatches,
  rankFilePaths,
  scoreQuery,
  searchApps,
  searchCommands,
} from "../core/matcher";
import {
  convertCurrency,
  convertUnits,
  evaluateExpression,
  parseCurrencyPair,
} from "../core/calculator";
import { resolveTextTool } from "../core/text-tools";
import {
  AppEntry,
  AppMatch,
  BuiltinMatch,
  CommandMatch,
  CommandType,
  FileMatch,
  LoadedPlugin,
  PinnedMatch,
  SearchInput,
  SearchMatch,
} from "../core/types";
import { buildApplicationIndex } from "./app-index";
import { hasPeIcon, loadPeIcon } from "./exe-icon";
import { englishTranslateScore, matchBuiltinFeatures } from "../core/builtin-features";
import { TranslateWindowController } from "./translate-window-controller";
import { isShellAppPath } from "../core/start-apps";
import { loadCachedStartApps, openShellApp, refreshStartApps } from "./start-apps";
import { registerUpdater } from "./updater";
import { HostsController } from "./hosts-controller";
import { DiffController } from "./diff-controller";
import { ConvertController } from "./convert-controller";
import { isConvertibleFile } from "../core/file-convert";
import {
  customItemKey,
  describeCustomItems,
  mergeCustomItems,
  type MergeCustomItemOptions,
  removeCustomItem,
} from "./custom-items";
import { CurrencyRates } from "./currency";
import { FILE_SEARCH_PAGE_SIZE, FileSearch, type FileSearchResult } from "./file-search";
import { MouseHelper } from "./mouse-helper";
import { recognizeImageFile } from "./ocr";
import { PluginHost } from "./plugin-host";
import { PluginPackageInstaller } from "./plugin-package";
import { PluginRegistry } from "./plugin-registry";
import { PreviewController } from "./preview-controller";
import { ScreenshotController } from "./screenshot-controller";
import { AppSettings, SettingsStore } from "./settings";
import { TranslationController } from "./translation-controller";
import { TRAY_ICON_DATA_URL } from "./tray-icon";
import { UsageStore } from "./usage-store";
import {
  createLauncherWindow,
  defaultLauncherPosition,
  LAUNCHER_HEIGHT,
  LAUNCHER_WIDTH,
  showLauncher,
} from "./windows";

app.setName("Dockwisp");
migrateLegacyUserData();
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

/**
 * Migrate user data from the legacy directory to the current "Dockwisp"
 * user-data directory on first launch. Preserves settings, usage, currency
 * cache, plugins, pin list and Everything config/db for existing users.
 * Chromium/Electron caches are intentionally not copied. The legacy path is
 * kept for upgrades; removing it would lose existing user data.
 */
function migrateLegacyUserData(): void {
  const legacyDir = path.join(app.getPath("appData"), "OpenDock");
  const currentDir = app.getPath("userData");
  if (legacyDir === currentDir || !existsSync(legacyDir)) return;
  try {
    const entries = [
      "settings.json",
      "usage.json",
      "currency-rates.json",
      "plugins",
      "plugin-data",
      "plugin-files",
      "everything.ini",
      "everything.db",
    ];
    let copied = 0;
    mkdirSync(currentDir, { recursive: true });
    for (const name of entries) {
      const source = path.join(legacyDir, name);
      if (!existsSync(source)) continue;
      const target = path.join(currentDir, name);
      if (!existsSync(target)) {
        cpSync(source, target, { recursive: true });
        copied += 1;
      } else if (statSync(source).isDirectory() && statSync(target).isDirectory()) {
        copied += mergeMissingEntries(source, target);
      }
    }
    if (copied > 0) {
      console.log(`user data migrated from ${legacyDir} to ${currentDir} (${copied} entries)`);
    }
  } catch (error) {
    console.error(`user data migration failed (${legacyDir} -> ${currentDir})`, error);
  }
}

function mergeMissingEntries(sourceDir: string, targetDir: string): number {
  mkdirSync(targetDir, { recursive: true });
  let copied = 0;
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    const source = path.join(sourceDir, entry.name);
    const target = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      if (!existsSync(target)) {
        cpSync(source, target, { recursive: true });
        copied += 1;
      } else {
        copied += mergeMissingEntries(source, target);
      }
    } else if (!existsSync(target)) {
      copyFileSync(source, target);
      copied += 1;
    }
  }
  return copied;
}

let launcher: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let registeredHotkey = "";
let registeredScreenshotHotkey = "";
let screenshot: ScreenshotController | null = null;
// Assigned once the settings store exists; lets module-level helpers read the
// live persisted launcher position without threading the store everywhere.
let getLauncherPosition: () => { x: number; y: number } | undefined = () => undefined;
// Programmatic moves (show, resize, reset) must not overwrite the user's saved
// drag position. The value is a timestamp until which `moved` events are ignored.
let suppressLauncherPositionSaveUntil = 0;

/** Show the launcher at its persisted position (or the default when unset). */
function summonLauncher(openSettings = false): void {
  if (launcher) {
    suppressLauncherPositionSaveUntil = Date.now() + 450;
    showLauncher(launcher, openSettings, getLauncherPosition());
  }
}

function normalizeInput(raw: unknown): SearchInput {
  if (!raw || typeof raw !== "object") return { type: "text", data: "" };
  const input = raw as { type?: unknown; data?: unknown };
  if (input.type === "files" && Array.isArray(input.data)) {
    const files = input.data
      .filter((item): item is string => typeof item === "string")
      .map((filePath) => {
        try {
          const stats = statSync(filePath);
          return {
            path: filePath,
            name: path.basename(filePath),
            isFile: stats.isFile(),
            isDirectory: stats.isDirectory(),
          };
        } catch {
          return null;
        }
      })
      .filter((item): item is NonNullable<typeof item> => item !== null);
    return { type: "files", data: files };
  }
  if (input.type === "img" && typeof input.data === "string") {
    return { type: "img", data: input.data };
  }
  return { type: "text", data: typeof input.data === "string" ? input.data : "" };
}

/**
 * Single-file fast path: read the legacy CF_FILENAMEW clipboard format directly.
 * Explorer writes it alongside CF_HDROP for a single copied file; it holds one
 * UTF-16LE path terminated by a NUL. Returns [] when absent or unreadable, so
 * the caller falls through to the PowerShell FileDropList path for multi-file
 * copies. We do NOT gate this on clipboard.availableFormats(), which does not
 * reliably report the format name for an Explorer copy.
 */
function readClipboardFileNameW(): string[] {
  try {
    const buffer = clipboard.readBuffer("FileNameW");
    if (!buffer || buffer.length === 0) return [];
    let text = buffer.toString("utf16le");
    const nul = text.indexOf("\u0000");
    if (nul >= 0) text = text.slice(0, nul);
    text = text.trim();
    if (!text || !existsSync(text)) return [];
    return [text];
  } catch {
    return [];
  }
}

/**
 * Multi-file path: ask PowerShell for the full FileDropList. Run without any
 * availableFormats() precheck (it misses Explorer's CF_HDROP). powershell.exe
 * 5.1 runs STA by default, which Get-Clipboard -Format FileDropList requires.
 */
function readClipboardFileDropList(): Promise<string[]> {
  return new Promise((resolve) => {
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-STA",
        "-Command",
        "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard -Format FileDropList | ForEach-Object { $_.FullName }",
      ],
      { windowsHide: true },
    );
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (output += chunk));
    const timer = setTimeout(() => child.kill(), 5_000);
    child.on("error", () => resolve([]));
    child.on("close", () => {
      clearTimeout(timer);
      resolve(
        output
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line && existsSync(line)),
      );
    });
  });
}

interface SystemCommand {
  id: string;
  title: string;
  subtitle: string;
  keywords: string[];
  /**
   * Start Menu app names that launch the same tool. When this command is shown,
   * indexed apps with these names are hidden so the tool is not listed twice.
   */
  aliases?: string[];
  iconSource?: string;
  run?:
    | { type: "exe"; target: string; args?: string[] }
    | { type: "uri"; target: string }
    | { type: "path"; target: string };
}

const system32 = (name: string): string =>
  path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", name);

const SYSTEM_ICON_FALLBACK =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#8a8f9f" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 8.6a1.7 1.7 0 0 0-.34-1.88l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3a2 2 0 1 1 4 0v.1A1.7 1.7 0 0 0 15 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.12.38.33.72.6 1 .3.27.68.42 1.1.42H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5.58Z"/></svg>',
  );

const systemIconSvg = (body: string): string =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#8a8f9f" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`,
  )}`;

// Category fallbacks for commands that have no executable icon (mostly
// ms-settings URIs and Windows actions).
const SYSTEM_ICON_URLS: Record<string, string> = {
  lock: systemIconSvg('<rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>'),
  sleep: systemIconSvg('<path d="M20.5 14.5A8.5 8.5 0 1 1 9.5 3.5a7 7 0 0 0 11 11Z"/>'),
  recycle: systemIconSvg('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5M14 11v5"/>'),
  mute: systemIconSvg('<path d="M4 9v6h4l5 4V5L8 9H4Z"/><path d="M17 9l4 6M21 9l-4 6"/>'),
  "volume-up": systemIconSvg('<path d="M4 9v6h4l5 4V5L8 9H4Z"/><path d="M17 9a4 4 0 0 1 0 6M20 6a8 8 0 0 1 0 12"/>'),
  "volume-down": systemIconSvg('<path d="M4 9v6h4l5 4V5L8 9H4Z"/><path d="M17 9a4 4 0 0 1 0 6"/>'),
  shutdown: systemIconSvg('<path d="M12 3v9"/><path d="M7 6a8 8 0 1 0 10 0"/>'),
  restart: systemIconSvg('<path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v5h-5"/>'),
  settings: SYSTEM_ICON_FALLBACK,
  "display-settings": systemIconSvg('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>'),
  "sound-settings": systemIconSvg('<path d="M4 9v6h4l5 4V5L8 9H4Z"/><path d="M17 9a4 4 0 0 1 0 6"/>'),
  "network-settings": systemIconSvg('<circle cx="12" cy="12" r="8"/><path d="M4 12h16M12 4a12 12 0 0 1 0 16M12 4a12 12 0 0 0 0 16"/>'),
  "bluetooth-settings": systemIconSvg('<path d="M7 7l10 10-5 4V3l5 4L7 17"/>'),
  "apps-settings": systemIconSvg('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>'),
  "windows-update": systemIconSvg('<path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v5h-5"/>'),
  personalization: systemIconSvg('<circle cx="12" cy="12" r="9"/><path d="M12 21a3 3 0 0 1 0-6c1.7 0 3-1.3 3-3"/>'),
  "privacy-settings": systemIconSvg('<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3Z"/>'),
  "datetime-settings": systemIconSvg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  "mouse-settings": systemIconSvg('<rect x="7" y="3" width="10" height="18" rx="5"/><path d="M12 3v7"/>'),
  "storage-settings": systemIconSvg('<rect x="3" y="5" width="18" height="6" rx="2"/><rect x="3" y="13" width="18" height="6" rx="2"/><path d="M7 8h.01M7 16h.01"/>'),
  "windows-security": systemIconSvg('<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3Z"/><path d="M9 12l2 2 4-4"/>'),
  firewall: systemIconSvg('<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3Z"/><path d="M9 9h6M9 13h6"/>'),
  printers: systemIconSvg('<path d="M7 8V3h10v5M7 17H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2"/><rect x="7" y="14" width="10" height="7" rx="1"/>'),
  "default-apps": systemIconSvg('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>'),
  fonts: systemIconSvg('<path d="M6 4h12M12 4v16M8 20h8"/>'),
  "remote-desktop": systemIconSvg('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4M8 10l-2 2 2 2M16 10l2 2-2 2"/>'),
  "system-info": systemIconSvg('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>'),
  "system-properties": systemIconSvg('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>'),
  dxdiag: systemIconSvg('<rect x="5" y="5" width="14" height="14" rx="2"/><path d="M9 9h6v6H9z"/>'),
  winver: systemIconSvg('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>'),
  "resource-monitor": systemIconSvg('<path d="M3 12h4l2-6 4 12 2-6h6"/>'),
  "performance-monitor": systemIconSvg('<path d="M3 12h4l2-6 4 12 2-6h6"/>'),
};

const systemIconCache = new Map<string, string>();

async function warmSystemIcons(): Promise<void> {
  await Promise.all(
    SYSTEM_COMMANDS.map(async (command) => {
      const source =
        command.iconSource ??
        (command.run && command.run.type !== "uri" ? command.run.target : undefined);
      if (!source || !path.isAbsolute(source)) return;
      try {
        const icon = await app.getFileIcon(source, { size: "large" });
        if (!icon.isEmpty()) systemIconCache.set(command.id, icon.toDataURL());
      } catch {
        // Optional Windows components may be missing; use the fallback icon.
      }
    }),
  );
}

const SYSTEM_COMMANDS: SystemCommand[] = [
  { id: "lock", title: "锁屏", subtitle: "锁定 Windows 会话", keywords: ["锁屏", "lock"] },
  { id: "sleep", title: "睡眠", subtitle: "让电脑进入睡眠", keywords: ["睡眠", "sleep"] },
  {
    id: "recycle",
    title: "清空回收站",
    subtitle: "永久删除回收站内容",
    keywords: ["清空回收站", "回收站", "recycle"],
  },
  { id: "mute", title: "静音", subtitle: "切换系统静音", keywords: ["静音", "mute"] },
  {
    id: "volume-up",
    title: "音量 +",
    subtitle: "提高系统音量",
    keywords: ["音量+", "音量加", "volup"],
  },
  {
    id: "volume-down",
    title: "音量 -",
    subtitle: "降低系统音量",
    keywords: ["音量-", "音量减", "voldown"],
  },
  { id: "shutdown", title: "关机", subtitle: "关闭电脑（需要确认）", keywords: ["关机", "shutdown"] },
  { id: "restart", title: "重启", subtitle: "重新启动电脑（需要确认）", keywords: ["重启", "restart"] },
  {
    id: "taskmgr",
    title: "任务管理器",
    subtitle: "打开任务管理器",
    keywords: ["任务管理器", "taskmgr"],
    iconSource: system32("Taskmgr.exe"),
  },
  {
    id: "settings",
    title: "系统设置",
    subtitle: "打开 Windows 设置",
    keywords: ["系统设置", "设置页", "ms-settings"],
  },
  {
    id: "explorer",
    title: "资源管理器",
    subtitle: "打开文件资源管理器",
    keywords: ["资源管理器", "explorer"],
    aliases: ["文件资源管理器", "File Explorer"],
    iconSource: system32("explorer.exe"),
  },
  {
    id: "control-panel",
    title: "控制面板",
    subtitle: "打开 Windows 控制面板",
    keywords: ["控制面板", "control panel", "control"],
    run: { type: "exe", target: system32("control.exe") },
  },
  {
    id: "regedit",
    title: "注册表编辑器",
    subtitle: "打开注册表编辑器",
    keywords: ["注册表", "注册表编辑器", "regedit"],
    run: { type: "exe", target: system32("regedit.exe") },
  },
  {
    id: "terminal",
    title: "终端（命令提示符）",
    subtitle: "打开命令提示符终端",
    keywords: ["终端", "命令提示符", "cmd", "terminal"],
    aliases: ["命令提示符", "Command Prompt"],
    run: { type: "exe", target: system32("cmd.exe") },
  },
  {
    id: "powershell",
    title: "PowerShell",
    subtitle: "打开 Windows PowerShell",
    keywords: ["powershell", "ps", "命令行"],
    aliases: ["Windows PowerShell"],
    run: {
      type: "exe",
      target: path.join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
    },
  },
  {
    id: "windows-terminal",
    title: "Windows 终端",
    subtitle: "打开 Windows Terminal",
    keywords: ["windows terminal", "wt", "终端"],
    aliases: ["终端", "Terminal", "Windows Terminal"],
    run: { type: "exe", target: "wt.exe" },
  },
  {
    id: "device-manager",
    title: "设备管理器",
    subtitle: "查看和管理硬件设备",
    keywords: ["设备管理器", "设备管理", "devmgmt"],
    run: { type: "path", target: system32("devmgmt.msc") },
  },
  {
    id: "services",
    title: "服务",
    subtitle: "管理 Windows 服务",
    keywords: ["服务", "services", "services.msc"],
    run: { type: "path", target: system32("services.msc") },
  },
  {
    id: "disk-management",
    title: "磁盘管理",
    subtitle: "管理磁盘分区与卷",
    keywords: ["磁盘管理", "分区", "diskmgmt"],
    run: { type: "path", target: system32("diskmgmt.msc") },
  },
  {
    id: "event-viewer",
    title: "事件查看器",
    subtitle: "查看系统和应用事件日志",
    keywords: ["事件查看器", "事件日志", "eventvwr"],
    run: { type: "path", target: system32("eventvwr.msc") },
  },
  {
    id: "task-scheduler",
    title: "任务计划程序",
    subtitle: "管理计划任务",
    keywords: ["任务计划", "任务计划程序", "taskschd"],
    run: { type: "path", target: system32("taskschd.msc") },
  },
  {
    id: "programs-features",
    title: "程序和功能",
    subtitle: "卸载或更改已安装的程序",
    keywords: ["程序和功能", "卸载程序", "appwiz"],
    run: { type: "exe", target: system32("control.exe"), args: ["appwiz.cpl"] },
  },
  {
    id: "power-options",
    title: "电源选项",
    subtitle: "配置电源计划与睡眠行为",
    keywords: ["电源选项", "电源计划", "powercfg"],
    run: { type: "exe", target: system32("control.exe"), args: ["powercfg.cpl"] },
  },
  {
    id: "network-connections",
    title: "网络连接",
    subtitle: "查看和配置网络适配器",
    keywords: ["网络连接", "网卡", "ncpa"],
    run: { type: "exe", target: system32("control.exe"), args: ["ncpa.cpl"] },
  },
  {
    id: "system-info",
    title: "系统信息",
    subtitle: "查看计算机硬件与系统信息",
    keywords: ["系统信息", "硬件信息", "msinfo"],
    run: { type: "exe", target: system32("msinfo32.exe") },
  },
  {
    id: "resource-monitor",
    title: "资源监视器",
    subtitle: "实时查看 CPU、内存、磁盘和网络",
    keywords: ["资源监视器", "性能监控", "resmon"],
    run: { type: "exe", target: system32("resmon.exe") },
  },
  {
    id: "performance-monitor",
    title: "性能监视器",
    subtitle: "打开 Windows 性能监视器",
    keywords: ["性能监视器", "perfmon"],
    run: { type: "exe", target: system32("perfmon.exe") },
  },
  {
    id: "computer-management",
    title: "计算机管理",
    subtitle: "集中管理设备、磁盘和服务",
    keywords: ["计算机管理", "compmgmt"],
    run: { type: "path", target: system32("compmgmt.msc") },
  },
  {
    id: "group-policy",
    title: "本地组策略编辑器",
    subtitle: "打开本地组策略编辑器",
    keywords: ["组策略", "组策略编辑器", "gpedit"],
    run: { type: "path", target: system32("gpedit.msc") },
  },
  {
    id: "system-config",
    title: "系统配置",
    subtitle: "启动项与系统诊断配置",
    keywords: ["系统配置", "启动项", "msconfig"],
    run: { type: "exe", target: system32("msconfig.exe") },
  },
  {
    id: "system-properties",
    title: "系统属性",
    subtitle: "查看计算机名、硬件和高级设置",
    keywords: ["系统属性", "计算机名", "sysdm"],
    run: { type: "exe", target: system32("control.exe"), args: ["sysdm.cpl"] },
  },
  {
    id: "windows-security",
    title: "Windows 安全中心",
    subtitle: "病毒防护与设备安全性",
    keywords: ["安全中心", "windows defender", "defender", "杀毒"],
    run: { type: "uri", target: "ms-settings:windowsdefender" },
  },
  {
    id: "firewall",
    title: "防火墙",
    subtitle: "Windows Defender 防火墙设置",
    keywords: ["防火墙", "firewall"],
    run: { type: "exe", target: system32("control.exe"), args: ["firewall.cpl"] },
  },
  {
    id: "printers",
    title: "打印机和扫描仪",
    subtitle: "管理打印机与扫描设备",
    keywords: ["打印机", "扫描仪", "printers"],
    run: { type: "uri", target: "ms-settings:printers" },
  },
  {
    id: "default-apps",
    title: "默认应用",
    subtitle: "配置文件类型和协议的默认程序",
    keywords: ["默认应用", "默认程序", "default apps"],
    run: { type: "uri", target: "ms-settings:defaultapps" },
  },
  {
    id: "fonts",
    title: "字体",
    subtitle: "查看和安装系统字体",
    keywords: ["字体", "fonts"],
    run: { type: "uri", target: "ms-settings:fonts" },
  },
  {
    id: "remote-desktop",
    title: "远程桌面",
    subtitle: "远程桌面连接与设置",
    keywords: ["远程桌面", "远程连接", "remote desktop", "mstsc"],
    run: { type: "uri", target: "ms-settings:remotedesktop" },
  },
  {
    id: "dxdiag",
    title: "DirectX 诊断工具",
    subtitle: "查看显卡和音频设备信息",
    keywords: ["directx", "dxdiag", "显卡信息"],
    run: { type: "exe", target: system32("dxdiag.exe") },
  },
  {
    id: "winver",
    title: "Windows 版本",
    subtitle: "查看 Windows 版本信息",
    keywords: ["windows 版本", "系统版本", "winver"],
    run: { type: "exe", target: system32("winver.exe") },
  },
  {
    id: "display-settings",
    title: "显示设置",
    subtitle: "分辨率、缩放与多显示器",
    keywords: ["显示设置", "分辨率", "缩放", "display"],
    run: { type: "uri", target: "ms-settings:display" },
  },
  {
    id: "sound-settings",
    title: "声音设置",
    subtitle: "输出设备与音量设置",
    keywords: ["声音设置", "音频设置", "sound"],
    run: { type: "uri", target: "ms-settings:sound" },
  },
  {
    id: "network-settings",
    title: "网络设置",
    subtitle: "Wi-Fi、以太网与代理设置",
    keywords: ["网络设置", "wifi", "以太网", "network"],
    run: { type: "uri", target: "ms-settings:network" },
  },
  {
    id: "bluetooth-settings",
    title: "蓝牙设置",
    subtitle: "管理蓝牙设备",
    keywords: ["蓝牙", "bluetooth"],
    run: { type: "uri", target: "ms-settings:bluetooth" },
  },
  {
    id: "apps-settings",
    title: "应用和功能",
    subtitle: "管理已安装的应用",
    keywords: ["应用和功能", "应用管理", "apps"],
    run: { type: "uri", target: "ms-settings:appsfeatures" },
  },
  {
    id: "windows-update",
    title: "Windows 更新",
    subtitle: "检查并安装系统更新",
    keywords: ["windows 更新", "系统更新", "update"],
    run: { type: "uri", target: "ms-settings:windowsupdate" },
  },
  {
    id: "personalization",
    title: "个性化",
    subtitle: "主题、壁纸与颜色",
    keywords: ["个性化", "壁纸", "主题", "personalization"],
    run: { type: "uri", target: "ms-settings:personalization" },
  },
  {
    id: "privacy-settings",
    title: "隐私设置",
    subtitle: "应用权限与隐私选项",
    keywords: ["隐私", "权限", "privacy"],
    run: { type: "uri", target: "ms-settings:privacy" },
  },
  {
    id: "datetime-settings",
    title: "日期和时间",
    subtitle: "时间、时区与日期格式",
    keywords: ["日期和时间", "时间设置", "时区", "datetime"],
    run: { type: "uri", target: "ms-settings:dateandtime" },
  },
  {
    id: "mouse-settings",
    title: "鼠标设置",
    subtitle: "指针、滚轮与鼠标按键",
    keywords: ["鼠标设置", "鼠标", "mouse"],
    run: { type: "uri", target: "ms-settings:mousetouchpad" },
  },
  {
    id: "storage-settings",
    title: "存储设置",
    subtitle: "磁盘空间与存储感知",
    keywords: ["存储设置", "磁盘空间", "storage"],
    run: { type: "uri", target: "ms-settings:storagesense" },
  },
];

/** Score a system command against the query; -1 when it does not match. */
function scoreSystemCommand(command: SystemCommand, query: string, lower: string): number {
  // Aliases are the Start Menu names of the same tool, so they match too: the
  // alias app is hidden in favour of this command, which must then still show.
  const terms = [...command.keywords, ...(command.aliases ?? [])];
  if (command.title === query) return 1_300;
  if (terms.some((keyword) => keyword.toLowerCase() === lower)) return 1_250;
  const keywordMatches = terms.some((keyword) => {
    const normalized = keyword.toLowerCase();
    // Chinese keywords can match anywhere; ASCII keywords only at the start so
    // e.g. "block" does not surface the lock-screen command.
    return /[^\x00-\x7f]/.test(keyword)
      ? normalized.includes(lower)
      : normalized.startsWith(lower);
  });
  if (command.title.toLowerCase().includes(lower) || keywordMatches) {
    return 1_150;
  }
  return -1;
}

function systemMatch(command: SystemCommand, score: number): BuiltinMatch {
  return {
    id: `system:${command.id}`,
    kind: "builtin" as const,
    action: "system" as const,
    title: command.title,
    subtitle: command.subtitle,
    score,
    payload: command.id,
    iconUrl:
      systemIconCache.get(command.id) ??
      SYSTEM_ICON_URLS[command.id] ??
      SYSTEM_ICON_FALLBACK,
  };
}

/** The system command a Start Menu app name is an alias of, if any. */
function systemCommandForAlias(name: string): SystemCommand | undefined {
  const lower = name.trim().toLowerCase();
  return SYSTEM_COMMANDS.find((command) =>
    command.aliases?.some((alias) => alias.toLowerCase() === lower),
  );
}

function systemMatches(query: string, lower: string): BuiltinMatch[] {
  return SYSTEM_COMMANDS.map((command) => ({ command, score: scoreSystemCommand(command, query, lower) }))
    .filter(({ score }) => score >= 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 3)
    .map(({ command, score }) => systemMatch(command, score));
}

function builtinMatches(input: SearchInput): BuiltinMatch[] {
  // File inputs are handled separately (convert targets) in the search handler.
  if (input.type !== "text") return [];
  const query = input.data.trim();
  if (!query) return [];
  const lower = query.toLowerCase();
  const matches: BuiltinMatch[] = [];
  // Table-driven fuzzy matching (prefix / pinyin / initials) for every built-in
  // feature, so "文" surfaces both 文件转换 and 文本对比, "wjzh"/"wbdb" and the
  // initials all hit, instead of the old hand-written includes/startsWith list.
  for (const { id, score } of matchBuiltinFeatures(query)) {
    const meta = BUILTIN_FEATURE_META[id];
    if (!meta) continue;
    matches.push({
      id,
      kind: "builtin",
      action: meta.action,
      title: meta.title,
      subtitle: meta.subtitle,
      score,
      ...(meta.payload !== undefined ? { payload: meta.payload } : {}),
      ...(meta.iconUrl ? { iconUrl: meta.iconUrl } : {}),
    });
  }
  // "翻译 xxx" / "translate xxx" keeps its parameterised special handling.
  const explicit = query.match(/^(?:翻译|translate)\s+(.+)$/i);
  // English text: offer to open the editable translation window with it.
  const englishScore = explicit ? -1 : englishTranslateScore(query);
  if (englishScore >= 0) {
    matches.push({
      id: "builtin:translate-text",
      kind: "builtin",
      action: "translate-window",
      title: "翻译",
      subtitle: `翻译 “${query.length > 40 ? `${query.slice(0, 40)}…` : query}”`,
      score: englishScore,
      payload: query,
      iconUrl: TRANSLATE_ICON_URL,
    });
  }
  if (explicit) {
    const payload = explicit[1];
    matches.push({
      id: "builtin:translate",
      kind: "builtin",
      action: "translate",
      title: `翻译：${payload}`,
      subtitle: "使用已配置的翻译提供器",
      score: 1_100,
      payload,
    });
  }
  matches.push(...systemMatches(query, lower));
  // Offer a full-disk file search for any normal text query; choosing it flips
  // the input into file-search mode (handled by the renderer).
  matches.push({
    id: "builtin:file-search",
    kind: "builtin",
    action: "file-search",
    title: `搜索文件 “${query}”`,
    subtitle: "Everything 全盘文件搜索",
    score: 100,
    payload: query,
    iconUrl: FILE_SEARCH_ICON_URL,
  });
  return matches;
}

/**
 * Produce at most one primary "tool" result (calculator / unit / currency /
 * text tool) for a text query. These outrank apps for valid expressions. The
 * currency network call only happens when a currency pair is detected.
 */
async function toolMatches(
  input: SearchInput,
  currency: CurrencyRates,
): Promise<BuiltinMatch[]> {
  if (input.type !== "text") return [];
  const query = input.data.trim();
  if (!query) return [];

  // 1) Currency (needs rates; detect the pair before any network call).
  const pair = parseCurrencyPair(query);
  if (pair) {
    const rates = await currency.ensureRates();
    if (rates) {
      const converted = convertCurrency(pair.amount, pair.from, pair.to, rates);
      if (converted !== null) {
        const display = `${formatMoney(converted)} ${pair.to}`;
        const date = currency.date ? ` · ${currency.date}` : "";
        return [
          {
            id: "tool:currency",
            kind: "builtin",
            action: "copy",
            title: display,
            subtitle: `汇率 · ${pair.amount} ${pair.from} → ${pair.to}${date}`,
            score: 1_800,
            payload: display,
          },
        ];
      }
    }
    // Rates unavailable: do not emit a currency result.
    return [];
  }

  // 2) Unit conversion.
  const unit = convertUnits(query);
  if (unit) {
    return [
      {
        id: "tool:unit",
        kind: "builtin",
        action: "copy",
        title: unit.display,
        subtitle: `单位换算 · ${query}`,
        score: 1_750,
        payload: unit.display,
      },
    ];
  }

  // 3) Text tools (JSON / Base64 / timestamp / hash / regex). Check before
  // arithmetic so a date like 2026-10-19 is not parsed as subtraction.
  const tool = resolveTextTool(query);
  if (tool) {
    return [
      {
        id: "tool:text",
        kind: "builtin",
        action: tool.action,
        title: tool.title,
        subtitle: tool.subtitle,
        score: tool.score,
        payload: tool.payload,
      },
    ];
  }

  // 4) Arithmetic (only when an operator/function/paren is present).
  const math = evaluateExpression(query);
  if (math) {
    return [
      {
        id: "tool:math",
        kind: "builtin",
        action: "copy",
        title: math.display,
        subtitle: `计算 · ${query}`,
        score: 1_900,
        payload: math.display,
      },
    ];
  }

  return [];
}

/** Money formatting: two decimals, thousands separators. */
function formatMoney(value: number): string {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function sha1(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}

const iconCache = new Map<string, string>();

const SCREENSHOT_ICON_URL =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#8a8f9f" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/></svg>',
  );

const PLUGIN_ICON_URL =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#8a8f9f" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3h4v3a2 2 0 1 0 4 0h3v6h-2.5a2.5 2.5 0 1 0 0 5H21v4h-5v-2a2 2 0 1 0-4 0v2H3v-4h2a2.5 2.5 0 1 0 0-5H3V9h3a2 2 0 1 0 4 0V6h0Z"/></svg>',
  );

const FILE_SEARCH_ICON_URL =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#8a8f9f" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M16.4 16.4 21 21"/></svg>',
  );

const HOSTS_ICON_URL =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#8a8f9f" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>',
  );

const DIFF_ICON_URL =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#8a8f9f" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="7.5" height="16" rx="1.5"/><rect x="13.5" y="4" width="7.5" height="16" rx="1.5"/><path d="M5.5 9h2.5M5.5 13h2.5M16 9h2.5M16 13h2.5"/></svg>',
  );

const TRANSLATE_ICON_URL =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#8a8f9f" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h8M8 3v2M6 5c0 4 2.5 7 6 8M10 5c-.5 3.5-3 6.5-6 8"/><path d="m13 21 4-9 4 9M14.5 18h5"/></svg>',
  );

const CONVERT_ICON_URL =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#8a8f9f" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h13l-3.5-3.5M20 16H7l3.5 3.5"/></svg>',
  );

/**
 * Presentation + action metadata for each built-in feature id, keyed to the
 * ids in src/core/builtin-features.ts. `builtinMatches` looks a feature up here
 * after `matchBuiltinFeatures` scores the query. Defined after the icon URL
 * constants so it can reference them at module-init time.
 */
interface BuiltinFeatureMeta {
  action: BuiltinMatch["action"];
  title: string;
  subtitle: string;
  payload?: string;
  iconUrl?: string;
}

const BUILTIN_FEATURE_META: Record<string, BuiltinFeatureMeta> = {
  "builtin:settings": {
    action: "settings",
    title: "设置",
    subtitle: "快捷键、外观与翻译服务",
    iconUrl: SYSTEM_ICON_URLS.settings,
  },
  "builtin:plugins": {
    action: "plugins",
    title: "插件",
    subtitle: "管理已安装插件与内置工具",
    iconUrl: PLUGIN_ICON_URL,
  },
  "builtin:screenshot": {
    action: "screenshot",
    title: "截图",
    subtitle: "区域截图 · 编辑 · OCR · 翻译",
    iconUrl: SCREENSHOT_ICON_URL,
  },
  "builtin:hosts": {
    action: "hosts",
    title: "hosts 切换",
    subtitle: "管理并切换多套 hosts 方案",
    iconUrl: HOSTS_ICON_URL,
  },
  "builtin:diff": {
    action: "diff",
    title: "文本对比",
    subtitle: "左右对比两段文本并高亮差异",
    iconUrl: DIFF_ICON_URL,
  },
  "builtin:convert": {
    action: "convert",
    title: "文件转换",
    subtitle: "图片、数据、PDF、Office 与音视频格式互转",
    iconUrl: CONVERT_ICON_URL,
  },
  "builtin:window-search": {
    action: "window-search",
    title: "切换窗口",
    subtitle: "输入“窗口 关键词”筛选窗口",
    payload: "",
  },
  "builtin:translate-window": {
    action: "translate-window",
    title: "翻译",
    subtitle: "打开翻译窗口，编辑并翻译文本",
    payload: "",
    iconUrl: TRANSLATE_ICON_URL,
  },
};

function pluginIconUrl(plugin: LoadedPlugin): string | undefined {
  const logo = plugin.manifest.logo;
  if (!logo) return undefined;
  const filePath = path.resolve(plugin.directory, logo);
  if (!existsSync(filePath)) return undefined;
  try {
    const image = nativeImage.createFromPath(filePath);
    return image.isEmpty() ? undefined : image.toDataURL();
  } catch {
    return undefined;
  }
}

function pluginDescription(plugin: LoadedPlugin): string {
  const descriptions = plugin.manifest.features
    .map((feature) => feature.description || feature.explain)
    .filter((value): value is string => typeof value === "string" && value.trim() !== "");
  if (descriptions.length === 0) return `${plugin.manifest.features.length} 个可用功能`;
  return [...new Set(descriptions)].slice(0, 2).join(" · ");
}

async function appIconUrl(filePath: string): Promise<string | undefined> {
  if (!filePath || !existsSync(filePath)) return undefined;
  const cached = iconCache.get(filePath);
  if (cached) return cached;
  try {
    // Shell shortcut icons are often the generic .lnk page + arrow. Resolve the
    // target (or the shortcut's explicit icon) so the result shows the app icon.
    let iconSource = filePath;
    let iconIndex = 0;
    if (path.extname(filePath).toLowerCase() === ".lnk") {
      try {
        const shortcut = shell.readShortcutLink(filePath);
        if (shortcut.icon && existsSync(shortcut.icon)) {
          iconSource = shortcut.icon;
          iconIndex = shortcut.iconIndex ?? 0;
        } else if (shortcut.target && existsSync(shortcut.target)) {
          iconSource = shortcut.target;
        }
      } catch {
        // Keep the shortcut icon if the link cannot be read.
      }
    }
    // The shell returns the generic program icon for many executables (large
    // Electron apps among them); read the embedded icon resource first.
    const embedded = hasPeIcon(iconSource) ? loadPeIcon(iconSource, iconIndex) : undefined;
    const image = embedded ?? (await app.getFileIcon(iconSource, { size: "large" }));
    const url = image.toDataURL();
    iconCache.set(filePath, url);
    return url;
  } catch {
    return undefined;
  }
}

/**
 * Serialise a match for the renderer. Plugin icons use a file URL; app/file
 * icons are rendered to data URLs (bounded by the caller to the top results).
 */
async function serializeMatch(
  match: SearchMatch,
  withIcon: boolean,
): Promise<SearchMatch> {
  if (match.kind === "plugin") {
    if (match.iconPath && existsSync(match.iconPath)) {
      return { ...match, iconUrl: pathToFileURL(match.iconPath).toString() };
    }
    return match;
  }
  if (match.kind === "app" && withIcon && match.iconPath) {
    const iconUrl = await appIconUrl(match.iconPath);
    if (iconUrl) return { ...match, iconUrl };
  }
  if ((match.kind === "app" || match.kind === "file") && withIcon) {
    const iconUrl = await appIconUrl(match.path);
    return iconUrl ? { ...match, iconUrl } : match;
  }
  return match;
}

/** Serialise a result set, attaching real icons only to the top app items. */
async function serializeMatches(matches: SearchMatch[]): Promise<SearchMatch[]> {
  let iconBudget = 24;
  return Promise.all(
    matches.map((match) => {
      // App icons are the user-facing requirement; extracting icons for arbitrary
      // files is slow (dozens of shell icon lookups per query) and not worth it.
      const wantsIcon = match.kind === "app" && iconBudget > 0;
      if (wantsIcon) iconBudget -= 1;
      return serializeMatch(match, wantsIcon);
    }),
  );
}

/** Strip the volatile fields from a match to store a clean pinned snapshot. */
function toPinnedSnapshot(match: SearchMatch): PinnedMatch {
  const snapshot: PinnedMatch = {
    id: match.id,
    kind: match.kind,
    title: match.title,
    subtitle: match.subtitle,
  };
  if (match.kind === "app" || match.kind === "file") {
    snapshot.path = match.path;
  } else if (match.kind === "plugin") {
    snapshot.pluginId = match.pluginId;
    snapshot.featureCode = match.featureCode;
    snapshot.commandType = match.commandType;
    snapshot.payload = match.payload;
    snapshot.iconPath = match.iconPath;
    snapshot.mainHide = match.mainHide;
  } else if (match.kind === "builtin") {
    snapshot.action = match.action;
    if (match.payload !== undefined) snapshot.payload = match.payload;
  }
  return snapshot;
}

/** Collect launchable paths from pinned snapshots so the index can include them. */
function pinnedAppPaths(pinned: PinnedMatch[]): string[] {
  return pinned
    .filter((item) => (item.kind === "app" || item.kind === "file") && item.path)
    .map((item) => item.path as string);
}

/** Rebuild a live SearchMatch from a stored pinned snapshot (score by order). */
function pinnedToMatch(snapshot: PinnedMatch, index: number): SearchMatch | null {
  const score = 1_000 - index;
  if (snapshot.kind === "app") {
    if (!snapshot.path || (!isShellAppPath(snapshot.path) && !existsSync(snapshot.path))) return null;
    return {
      id: snapshot.id,
      kind: "app",
      title: snapshot.title,
      subtitle: snapshot.subtitle,
      score,
      path: snapshot.path,
      pinned: true,
    } satisfies AppMatch;
  }
  if (snapshot.kind === "file") {
    if (!snapshot.path || !existsSync(snapshot.path)) return null;
    return {
      id: snapshot.id,
      kind: "file",
      title: snapshot.title,
      subtitle: snapshot.subtitle,
      score,
      path: snapshot.path,
      pinned: true,
    } satisfies FileMatch;
  }
  if (snapshot.kind === "plugin") {
    const payload: SearchInput =
      snapshot.payload && typeof snapshot.payload === "object"
        ? (snapshot.payload as SearchInput)
        : { type: "text", data: "" };
    return {
      id: snapshot.id,
      kind: "plugin",
      title: snapshot.title,
      subtitle: snapshot.subtitle,
      score,
      pluginId: snapshot.pluginId ?? "",
      featureCode: snapshot.featureCode ?? "",
      commandType: (snapshot.commandType ?? "base") as CommandType,
      payload,
      iconPath: snapshot.iconPath,
      mainHide: snapshot.mainHide === true,
      pinned: true,
    } satisfies CommandMatch;
  }
  return {
    id: snapshot.id,
    kind: "builtin",
    action: snapshot.action ?? "settings",
    title: snapshot.title,
    subtitle: snapshot.subtitle,
    score,
    payload: typeof snapshot.payload === "string" ? snapshot.payload : undefined,
    pinned: true,
  } satisfies BuiltinMatch;
}

function applyLoginSetting(settings: AppSettings): void {
  app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin });
}

async function registerHotkey(
  settings: AppSettings,
  helper: MouseHelper,
  helperReady: boolean,
): Promise<void> {
  globalShortcut.unregisterAll();
  registeredHotkey = "";
  const wantsNativeAltSpace =
    settings.hotkey.replace(/\s/g, "").toLowerCase() === "alt+space";
  if (helperReady) {
    try {
      await helper.setAltSpaceEnabled(wantsNativeAltSpace);
    } catch {
      helperReady = false;
    }
  }
  if (wantsNativeAltSpace && helperReady) {
    registeredHotkey = "Alt+Space";
    return;
  }
  if (globalShortcut.register(settings.hotkey, () => summonLauncher())) {
    registeredHotkey = settings.hotkey;
    return;
  }
  if (settings.hotkey !== "Control+Space") {
    if (globalShortcut.register("Control+Space", () => summonLauncher())) {
      registeredHotkey = "Control+Space";
    }
  }
}

/**
 * Register both the launcher hotkey and the screenshot hotkey. registerHotkey
 * calls unregisterAll first, so the screenshot shortcut must be (re)registered
 * afterwards or it would be wiped whenever the launcher hotkey is refreshed.
 */
async function applyHotkeys(
  settings: AppSettings,
  helper: MouseHelper,
  helperReady: boolean,
): Promise<void> {
  await registerHotkey(settings, helper, helperReady);
  registeredScreenshotHotkey = screenshot
    ? screenshot.registerHotkey(settings.screenshotHotkey)
    : "";
}

async function createTray(): Promise<void> {
  let icon = nativeImage.createFromDataURL(TRAY_ICON_DATA_URL);
  if (icon.isEmpty()) {
    icon = await app.getFileIcon(process.execPath, { size: "small" });
  }
  tray = new Tray(icon);
  tray.setToolTip("Dockwisp");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "打开 Dockwisp", click: () => summonLauncher() },
      { label: "截图", click: () => void screenshot?.open() },
      { label: "设置", click: () => summonLauncher(true) },
      { type: "separator" },
      {
        label: "退出",
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on("click", () => summonLauncher());
}

void app.whenReady().then(async () => {
  const smokeTest = process.argv.includes("--smoke-test");
  const ocrSmokeTestPath = process.argv
    .find((item) => item.startsWith("--ocr-smoke-test="))
    ?.slice(17);
  const devMode = process.argv.includes("--dev");
  const captureUiPath = process.argv.find((item) => item.startsWith("--capture-ui="))?.slice(13);
  const captureSettingsPath = process.argv
    .find((item) => item.startsWith("--capture-settings="))
    ?.slice(19);
  const systemIconsReady = warmSystemIcons();
  const settingsStore = new SettingsStore(app.getPath("userData"));
  getLauncherPosition = () => settingsStore.get().launcherPosition ?? undefined;
  const userPluginRoot = path.join(app.getPath("userData"), "plugins");
  mkdirSync(userPluginRoot, { recursive: true });
  const fixtureRoot = path.join(process.cwd(), "fixtures", "plugins");
  const registry = new PluginRegistry([
    userPluginRoot,
    ...settingsStore.get().pluginDirectories,
    ...(app.isPackaged ? [] : [fixtureRoot]),
  ]);
  registry.reload();
  const packageInstaller = new PluginPackageInstaller(userPluginRoot);

  const startAppsCache = path.join(app.getPath("userData"), "start-apps.json");
  let startApps = loadCachedStartApps(startAppsCache);
  const rebuildApplications = (): AppEntry[] =>
    buildApplicationIndex(
      settingsStore.get().customLaunchItems,
      pinnedAppPaths(settingsStore.get().pinnedMatches),
      startApps,
    );
  let applications = rebuildApplications();
  let commands = registry.getCommands();
  registry.on("changed", () => {
    commands = registry.getCommands();
    launcher?.webContents.send("launcher:index-updated");
  });

  let launcherHubOpen = false;
  launcher = createLauncherWindow(() => launcherHubOpen);
  launcher.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      launcher?.hide();
    }
  });
  launcher.on("hide", () => {
    launcherHubOpen = false;
  });
  ipcMain.on("launcher:hub-open", (event, open: unknown) => {
    if (!launcher || launcher.isDestroyed() || event.sender !== launcher.webContents) return;
    launcherHubOpen = open === true;
  });

  // Persist the launcher position when the user drags it. Debounced so a drag
  // emits one write, and filtered so the off-screen reveal position (-20000)
  // and no-op moves never reach settings.
  const persistLauncherPosition = (): void => {
    if (!launcher || launcher.isDestroyed()) return;
    const [x, y] = launcher.getPosition();
    // The reveal animation parks the window at -20000; never store that.
    if (x < -10_000 || y < -10_000) return;
    const current = settingsStore.get().launcherPosition;
    if (current && current.x === x && current.y === y) return;
    settingsStore.update({ launcherPosition: { x, y } });
  };
  let launcherDragState: {
    originX: number;
    originY: number;
    width: number;
    height: number;
    startX: number;
    startY: number;
  } | null = null;
  let moveTimer: NodeJS.Timeout | null = null;
  const schedulePositionSave = (): void => {
    if (launcherDragState) return;
    if (moveTimer) clearTimeout(moveTimer);
    moveTimer = setTimeout(() => {
      moveTimer = null;
      // Ignore moves we initiated from show/resize/reset.
      if (Date.now() < suppressLauncherPositionSaveUntil) return;
      persistLauncherPosition();
    }, 250);
  };
  // `move` fires while dragging on Windows; `moved` fires once on platforms
  // that only provide the settled event. Debouncing makes both work.
  launcher.on("move", schedulePositionSave);
  launcher.on("moved", schedulePositionSave);

  // Custom drag from the renderer: the search bar is a normal DOM element, so
  // holding anywhere (except the settings icon) can move the window while the
  // input still supports clicking/caret placement. Window positions use DIP,
  // matching screen coordinates reported by pointer events.
  ipcMain.on("launcher:drag-start", (event, x: unknown, y: unknown) => {
    if (!launcher || launcher.isDestroyed() || event.sender !== launcher.webContents) return;
    if (!settingsStore.get().windowDragEnabled) return;
    if (typeof x !== "number" || typeof y !== "number") return;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const { x: originX, y: originY, width, height } = launcher.getBounds();
    // Use the real cursor position (DIP) rather than relying on the renderer's
    // CSS-pixel coordinates; this stays correct across mixed-DPI monitors.
    const cursor = screen.getCursorScreenPoint();
    launcherDragState = {
      originX,
      originY,
      width,
      height,
      startX: cursor.x,
      startY: cursor.y,
    };
    suppressLauncherPositionSaveUntil = 0;
  });
  ipcMain.on("launcher:drag-move", (event) => {
    if (!launcher || launcher.isDestroyed() || !launcherDragState) return;
    if (event.sender !== launcher.webContents) return;
    const cursor = screen.getCursorScreenPoint();
    // On scaled Windows displays setPosition can gradually change a frameless
    // window's size, so keep the drag-start dimensions explicit on every move.
    launcher.setBounds({
      x: Math.round(launcherDragState.originX + (cursor.x - launcherDragState.startX)),
      y: Math.round(launcherDragState.originY + (cursor.y - launcherDragState.startY)),
      width: launcherDragState.width,
      height: launcherDragState.height,
    });
  });
  ipcMain.on("launcher:drag-end", (event) => {
    if (!launcherDragState) return;
    if (!launcher || launcher.isDestroyed() || event.sender !== launcher.webContents) return;
    launcherDragState = null;
    persistLauncherPosition();
  });
  launcher.on("hide", () => {
    if (!launcherDragState) return;
    launcherDragState = null;
    persistLauncherPosition();
  });

  const helper = new MouseHelper(
    MouseHelper.resolveExecutable(app.isPackaged, process.resourcesPath),
  );
  const helperStarted = helper.start();
  const helperReady = helperStarted && (await helper.waitUntilReady());
  const focusLauncher = (): void => {
    if (!launcher || launcher.isDestroyed()) return;
    // A background process cannot reliably take the foreground from a global
    // hotkey. The input helper still owns the key event, so ask it to activate
    // the window after Electron has shown it.
    const handle = launcher.getNativeWindowHandle();
    const nativeHandle =
      handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0));
    void helper.focusWindow(nativeHandle).catch(() => undefined);
  };
  const prepareLauncherWindow = (): void => {
    if (!launcher || launcher.isDestroyed()) return;
    const handle = launcher.getNativeWindowHandle();
    const nativeHandle =
      handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0));
    // Disable the DWM fade animation so summoning the launcher does not flash.
    void helper.prepareWindow(nativeHandle).catch(() => undefined);
  };
  prepareLauncherWindow();
  helper.on("hotkey", () => {
    if (
      settingsStore.get().hotkey.replace(/\s/g, "").toLowerCase() ===
      "alt+space"
    ) {
      summonLauncher();
      focusLauncher();
    }
  });
  const translation = new TranslationController(helper, settingsStore);
  const pluginHost = new PluginHost(registry, launcher, helper);
  const lastMatches = new Map<string, SearchMatch>();
  const currency = new CurrencyRates(app.getPath("userData"));
  const usage = new UsageStore(path.join(app.getPath("userData"), "usage.json"));

  const fileSearch = new FileSearch(
    FileSearch.resolveExecutable(app.isPackaged, process.resourcesPath),
    FileSearch.resolvePortable(app.isPackaged, process.resourcesPath),
    path.join(app.getPath("userData"), "everything.ini"),
    path.join(app.getPath("userData"), "everything.db"),
    () => {
      const roots = new Set<string>();
      for (const key of ["desktop", "downloads", "documents"] as const) {
        try {
          roots.add(app.getPath(key));
        } catch {
          // Some paths may be unavailable in a given environment.
        }
      }
      for (const item of settingsStore.get().customLaunchItems) {
        try {
          if (statSync(item).isDirectory()) roots.add(item);
        } catch {
          // Ignore missing custom directories.
        }
      }
      return [...roots];
    },
  );

  // Warm up the Everything provider shortly after startup so the first file
  // search does not pay the spawn/index latency. Skip in test/capture modes to
  // avoid launching Everything in automated environments.
  if (!smokeTest && !ocrSmokeTestPath && !captureUiPath && !captureSettingsPath) {
    setTimeout(() => void fileSearch.warmUp(), 1_200);
  }

  const rememberMatches = (matches: SearchMatch[], append = false): void => {
    if (!append) lastMatches.clear();
    for (const match of matches) lastMatches.set(match.id, match);
  };

  /** Rebuild the in-memory app index after an external install/uninstall. */
  const refreshApplications = (): void => {
    applications = rebuildApplications();
    launcher?.webContents.send("launcher:index-updated");
  };
  if (!smokeTest && !ocrSmokeTestPath) {
    void refreshStartApps(startAppsCache)
      .then((fresh) => {
        startApps = fresh;
        refreshApplications();
      })
      .catch(() => {});
  }

  /**
   * A stale result (for example an app uninstalled while Dockwisp was running)
   * fails to open. Rebuild the app index and invalidate file results so the next
   * search no longer lists the removed path.
   */
  const refreshAfterOpenFailure = (): void => {
    refreshApplications();
    fileSearch.invalidate();
  };

  const addCustomItems = (
    rawPaths: string[],
    options: MergeCustomItemOptions,
  ): ReturnType<typeof mergeCustomItems> => {
    const current = settingsStore.get();
    const result = mergeCustomItems(current.customLaunchItems, rawPaths, options);
    if (result.added.length > 0) {
      settingsStore.update({ customLaunchItems: result.paths });
      refreshApplications();
      fileSearch.invalidate();
    }
    return result;
  };

  const currentCustomItems = () =>
    describeCustomItems(settingsStore.get().customLaunchItems);

  /** Build the pinned home page from stored snapshots, with refreshed icons. */
  const homeMatches = async (): Promise<SearchMatch[]> => {
    const pinned = settingsStore.get().pinnedMatches;
    const live = pinned
      .map((snapshot, index) => pinnedToMatch(snapshot, index))
      .filter((item): item is SearchMatch => item !== null);
    rememberMatches(live);
    return serializeMatches(live);
  };

  const rankFileMatches = (paths: string[], query: string): FileMatch[] =>
    rankFilePaths(paths, query).map((item) => ({
      id: `file:${sha1(item.path)}`,
      kind: "file" as const,
      title: item.title,
      subtitle: item.path,
      score: item.score,
      path: item.path,
    }));

  const searchWindows = async (query: string): Promise<BuiltinMatch[]> => {
    const windows = (await helper.listWindows()).filter((item) => item.pid !== process.pid);
    const lower = query.toLowerCase();
    const ranked = windows
      .map((item, index) => {
        const base = path.basename(item.process);
        const processName = base.replace(/\.exe$/i, "").toLowerCase();
        const baseScore = lower
          ? scoreQuery(lower, buildSearchForms(`${item.title} ${base}`))
          : 1_000 - index;
        // Typing the process name (e.g. "chrome", "openchamber") is a stronger
        // signal than a page title that merely mentions the word.
        const processScore = lower
          ? processName === lower
            ? 300
            : processName.startsWith(lower)
              ? 150
              : 0
          : 0;
        return { item, base, score: baseScore < 0 ? baseScore : baseScore + processScore };
      })
      .filter(({ score }) => score >= 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, 20);
    if (ranked.length === 0) {
      return [
        {
          id: "status:window-empty",
          kind: "builtin",
          action: "info",
          title: "没有找到窗口",
          subtitle: "没有匹配的可见窗口，换个关键词试试",
          score: 9999,
        },
      ];
    }
    return ranked.map(({ item, base }, index) => ({
      id: `window:${item.hwnd}`,
      kind: "builtin" as const,
      action: "focus-window" as const,
      title: item.title,
      subtitle: `${base} · 切换窗口`,
      score: 1_500 - index,
      payload: item.hwnd,
    }));
  };

  const spawnDetached = (command: string, args: string[], showWindow = false): void => {
    try {
      // windowsHide passes SW_HIDE to the child, and GUI tools that relaunch
      // themselves (resmon.exe -> perfmon.exe /res) inherit it and stay
      // invisible; user-facing tools must therefore be spawned visibly.
      const child = spawn(command, args, {
        detached: true,
        stdio: "ignore",
        windowsHide: !showWindow,
      });
      child.on("error", () => undefined);
      child.unref();
    } catch {
      // Best-effort: a missing system binary should not crash the launcher.
    }
  };

  const runSystemCommand = async (commandId: string): Promise<void> => {
    // Data-driven system tools (control panel pages, .msc consoles, settings
    // URIs) share one launch path; special actions keep their explicit cases.
    const definition = SYSTEM_COMMANDS.find((command) => command.id === commandId);
    if (definition?.run) {
      const run = definition.run;
      try {
        if (run.type === "uri") {
          await shell.openExternal(run.target);
        } else if (run.type === "path") {
          const error = await shell.openPath(run.target);
          if (error) throw new Error(error);
        } else {
          spawnDetached(run.target, run.args ?? [], true);
        }
        launcher?.hide();
      } catch {
        // A missing optional component (for example Windows Terminal on an
        // older install) should not crash; the launcher simply stays open.
      }
      return;
    }
    switch (commandId) {
      case "lock":
        spawnDetached("rundll32.exe", ["user32.dll,LockWorkStation"]);
        launcher?.hide();
        return;
      case "sleep":
        spawnDetached("rundll32.exe", ["powrprof.dll,SetSuspendState", "0,1,0"]);
        launcher?.hide();
        return;
      case "recycle":
        spawnDetached("powershell.exe", [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Clear-RecycleBin -Force -ErrorAction SilentlyContinue",
        ]);
        launcher?.hide();
        return;
      case "mute":
        await helper.media("mute").catch(() => undefined);
        return;
      case "volume-up":
        await helper.media("up").catch(() => undefined);
        return;
      case "volume-down":
        await helper.media("down").catch(() => undefined);
        return;
      case "taskmgr":
        spawnDetached("taskmgr.exe", [], true);
        launcher?.hide();
        return;
      case "settings":
        void shell.openExternal("ms-settings:");
        launcher?.hide();
        return;
      case "explorer":
        spawnDetached("explorer.exe", [], true);
        launcher?.hide();
        return;
      case "shutdown":
      case "restart": {
        const isShutdown = commandId === "shutdown";
        const confirmLabel = isShutdown ? "关机" : "重启";
        const result = await dialog.showMessageBox(launcher!, {
          type: "warning",
          buttons: ["取消", confirmLabel],
          defaultId: 0,
          cancelId: 0,
          title: "确认操作",
          message: isShutdown ? "确定要关闭电脑吗？" : "确定要重新启动电脑吗？",
        });
        if (result.response !== 1) return;
        spawnDetached("shutdown.exe", [isShutdown ? "/s" : "/r", "/t", "0"]);
        launcher?.hide();
        return;
      }
      default:
        return;
    }
  };

  const screenshotController = new ScreenshotController(launcher, settingsStore, helper);
  screenshot = screenshotController;
  const hostsController = new HostsController(settingsStore);
  const diffController = new DiffController(settingsStore);
  const convertController = new ConvertController(settingsStore);
  const translateWindow = new TranslateWindowController(settingsStore);
  const convertedOutputs = new Set<string>();
  registerUpdater({
    getWindow: () => launcher,
    onBeforeInstall: async () => {
      quitting = true;
      // Release files under resources/native so the installer can overwrite them.
      helper.stop();
      await Promise.all([
        new Promise((resolve) => setTimeout(resolve, 700)),
        fileSearch.stopPortable(),
      ]);
    },
  });
  ipcMain.on("builtin:open", (event, id: unknown) => {
    if (!launcher || event.sender !== launcher.webContents) return;
    launcher.hide();
    if (id === "builtin:screenshot") void screenshotController.open();
    else if (id === "builtin:hosts") hostsController.open();
    else if (id === "builtin:diff") diffController.open();
    else if (id === "builtin:convert") convertController.open();
    else if (id === "builtin:translate-window") translateWindow.open();
  });
  const previewController = new PreviewController(settingsStore, () => {
    // Closing a preview returns to the existing file results instead of
    // leaving the launcher hidden. The renderer keeps its result list, so a
    // focus event restores the exact previous view.
    if (!quitting) summonLauncher();
  });

  ipcMain.on("screenshot:start", (event) => {
    if (!launcher || event.sender !== launcher.webContents) return;
    void screenshotController.open();
  });

  ipcMain.handle("plugins:list", () => {
    const installed = registry.list().map((plugin) => ({
      id: plugin.id,
      name: plugin.manifest.pluginName,
      description: pluginDescription(plugin),
      version: plugin.manifest.version,
      featureCount: plugin.manifest.features.length,
      builtin: false,
      iconUrl: pluginIconUrl(plugin),
    }));
    return [
      {
        id: "builtin:screenshot",
        name: "截图 OCR",
        description: "区域截图、标注、OCR 与翻译，按 Enter 复制并关闭",
        version: "内置",
        featureCount: 1,
        builtin: true,
        iconUrl: SCREENSHOT_ICON_URL,
      },
      {
        id: "builtin:hosts",
        name: "hosts 切换",
        description: "多方案管理与一键切换系统 hosts",
        version: "内置",
        featureCount: 1,
        builtin: true,
        iconUrl: HOSTS_ICON_URL,
      },
      {
        id: "builtin:diff",
        name: "文本对比",
        description: "左右对比文本，高亮行/字符差异，支持搜索",
        version: "内置",
        featureCount: 1,
        builtin: true,
        iconUrl: DIFF_ICON_URL,
      },
      {
        id: "builtin:convert",
        name: "文件转换",
        description: "图片、数据、PDF、Office 与音视频格式互转",
        version: "内置",
        featureCount: 1,
        builtin: true,
        iconUrl: CONVERT_ICON_URL,
      },
      {
        id: "builtin:translate-window",
        name: "翻译",
        description: "编辑文本并翻译，支持多语种与自动检测",
        version: "内置",
        featureCount: 1,
        builtin: true,
        iconUrl: TRANSLATE_ICON_URL,
      },
      ...installed,
    ];
  });

  ipcMain.handle("launcher:search", async (_event, rawInput: unknown) => {
    await systemIconsReady;
    const input = normalizeInput(rawInput);
    // File-search mode: text prefixed with "文件 " or "file ".
    if (input.type === "text") {
      const fileMode = input.data.match(/^(?:文件|file)\s+(.*)$/i);
      if (fileMode) {
        const query = fileMode[1].trim();
        const requestedOffset =
          rawInput && typeof rawInput === "object"
            ? (rawInput as { fileOffset?: unknown }).fileOffset
            : undefined;
        const fileOffset =
          typeof requestedOffset === "number" &&
          Number.isSafeInteger(requestedOffset) &&
          requestedOffset >= 0
            ? Math.min(requestedOffset, 0xffffffff)
            : 0;
        const filePage = async (
          matches: SearchMatch[],
          result?: Pick<FileSearchResult, "total" | "nextOffset" | "hasMore">,
        ) => ({
          matches: await serializeMatches(matches),
          filePage: {
            total: result?.total ?? matches.length,
            nextOffset: result?.nextOffset ?? fileOffset,
            hasMore: result?.hasMore === true,
          },
        });
        if (!query) {
          rememberMatches([]);
          return filePage([]);
        }
        const result = await fileSearch.query(query, fileOffset, FILE_SEARCH_PAGE_SIZE);
        if (result.status === "indexing") {
          const provider = result.provider === "system" ? "系统 Everything" : "便携版 Everything";
          const elapsedSeconds = Math.floor((result.progress?.elapsedMs ?? 0) / 1_000);
          const elapsed =
            elapsedSeconds < 60
              ? `${elapsedSeconds} 秒`
              : `${Math.floor(elapsedSeconds / 60)} 分 ${elapsedSeconds % 60} 秒`;
          const starting = result.progress?.phase === "starting";
          const match: BuiltinMatch = {
            id: "status:file-indexing",
            kind: "builtin",
            action: "file-indexing",
            title: starting ? "正在启动文件索引…" : "正在建立文件索引…",
            subtitle: `${provider} · 已用时 ${elapsed} · 完成后自动刷新`,
            score: 9999,
            payload: query,
          };
          rememberMatches([match]);
          return filePage([match]);
        }
        if (result.status === "error") {
          const match: BuiltinMatch = {
            id: "status:file-error",
            kind: "builtin",
            action: "info",
            title: "文件搜索暂不可用",
            subtitle: result.message ?? "请稍后重试",
            score: 9999,
          };
          rememberMatches([match]);
          return filePage([match]);
        }
        if (
          result.status === "fallback" &&
          result.paths.length === 0 &&
          result.hasMore !== true
        ) {
          const match: BuiltinMatch = {
            id: "status:file-empty",
            kind: "builtin",
            action: "info",
            title: "没有找到文件",
            subtitle: "Everything 暂不可用，已使用常用目录的有限索引",
            score: 9999,
          };
          rememberMatches([match]);
          return filePage([match], result);
        }
        const files = rankFileMatches(result.paths, query);
        rememberMatches(files, fileOffset > 0);
        return filePage(files, result);
      }
      // Window-switch mode: text prefixed with "窗口 " or "win ".
      const windowMode = input.data.match(/^(?:窗口|win)\s+(.*)$/i);
      if (windowMode) {
        const matches = await searchWindows(windowMode[1].trim());
        rememberMatches(matches);
        return serializeMatches(matches);
      }
      // Empty query: show only the pinned home page.
      if (!input.data.trim()) {
        return homeMatches();
      }
    }
    // Dropped / pasted files: surface "转换为 X" targets first, then plugin file
    // commands, and finally a "更多选项" entry that opens the convert window.
    if (input.type === "files") {
      const convertible = input.data
        .filter((file) => file.isFile && isConvertibleFile(file.path))
        .map((file) => file.path);
      const matches: SearchMatch[] = [];
      if (convertible.length > 0) {
        let targets: Awaited<ReturnType<ConvertController["targetsFor"]>> = [];
        try {
          targets = await convertController.targetsFor(convertible);
        } catch {
          targets = [];
        }
        const payloadFiles = JSON.stringify(convertible);
        let score = 1_260;
        for (const target of targets) {
          if (target.available === false && !target.needsDownload) continue;
          const parts: string[] = [];
          if (target.needsDownload) parts.push("首次使用需下载文档转换组件");
          if (target.note) parts.push(target.note);
          if (parts.length === 0) {
            parts.push(convertible.length === 1 ? "输出到源文件同目录" : `转换 ${convertible.length} 个文件 · 输出到源文件同目录`);
          }
          matches.push({
            id: `convert-to:${target.id}`,
            kind: "builtin",
            action: "convert-to",
            title: `转换为 ${target.label}`,
            subtitle: parts.join(" · "),
            score,
            payload: JSON.stringify({ files: convertible, target: target.id, needsDownload: target.needsDownload === true }),
            iconUrl: CONVERT_ICON_URL,
          });
          score -= 1;
        }
        matches.push({
          id: "builtin:convert",
          kind: "builtin",
          action: "convert",
          title: "在文件转换窗口中打开（更多选项）",
          subtitle: "质量、尺寸与批量设置",
          score: 1_000,
          payload: payloadFiles,
          iconUrl: CONVERT_ICON_URL,
        });
      }
      // Plugin "files" commands keep working behind the convert targets.
      const pluginFileMatches = searchCommands(commands, input, 30);
      const fileMatches = mergeMatches([matches, pluginFileMatches], 36);
      rememberMatches(fileMatches);
      return serializeMatches(fileMatches);
    }
    const pinnedPaths = new Set(
      pinnedAppPaths(settingsStore.get().pinnedMatches).map((item) => item.toLowerCase()),
    );
    const pinnedIds = new Set(settingsStore.get().pinnedMatches.map((item) => item.id));
    // searchApps already flags + boosts pinned apps so they survive its slice.
    const pluginMatches = searchCommands(commands, input, 30);
    const appMatches =
      input.type === "text"
        ? searchApps(applications, input.data, { limit: 60, pinnedPaths })
        : [];
    const tools = await toolMatches(input, currency);
    const builtins = builtinMatches(input);
    // A built-in system command (for example 资源监视器) supersedes an indexed
    // Start Menu app of the same name or a known alias (文件资源管理器 for
    // 资源管理器), so the tool is listed once, with the built-in icon and
    // launcher. An alias app matched by a query the command itself misses (for
    // example pinyin initials) is replaced by the command.
    const systemTitles = new Set<string>();
    const shownSystemIds = new Set<string>();
    for (const match of builtins) {
      if (match.action !== "system") continue;
      shownSystemIds.add(match.payload ?? "");
      systemTitles.add(match.title.trim().toLowerCase());
      const definition = SYSTEM_COMMANDS.find((command) => command.id === match.payload);
      for (const alias of definition?.aliases ?? []) systemTitles.add(alias.toLowerCase());
    }
    const visibleApps: AppMatch[] = [];
    for (const match of appMatches) {
      if (systemTitles.has(match.title.trim().toLowerCase())) continue;
      const command = systemCommandForAlias(match.title);
      if (command) {
        if (!shownSystemIds.has(command.id)) {
          shownSystemIds.add(command.id);
          builtins.push(systemMatch(command, match.score));
        }
        continue;
      }
      visibleApps.push(match);
    }
    const merged = mergeMatches(
      [tools, builtins, pluginMatches, visibleApps],
      36,
    );
    // Uniformly flag any pinned id and apply a modest boost. Apps already carry
    // the flag + boost from searchApps, so skip them to keep a single +250.
    const matches = merged.map((match) => {
      const pinnedBoost = pinnedIds.has(match.id) && !match.pinned ? 250 : 0;
      const pinned = match.pinned || pinnedIds.has(match.id);
      const score = match.score + pinnedBoost + usage.boost(match.id);
      return pinnedBoost || score !== match.score ? { ...match, pinned, score } : match;
    });
    matches.sort(
      (left, right) =>
        right.score - left.score ||
        left.title.length - right.title.length ||
        left.title.localeCompare(right.title),
    );
    rememberMatches(matches);
    return serializeMatches(matches);
  });

  ipcMain.handle("launcher:execute", async (_event, id: string) => {
    const match = lastMatches.get(id);
    if (!match) throw new Error("搜索结果已过期，请重试");
    // Record usage before acting, except for non-actionable status results.
    const nonActionable =
      match.kind === "builtin" &&
      (match.action === "info" || match.action === "file-indexing");
    if (!nonActionable) {
      usage.record(match.id);
    }
    if (match.kind === "file" || match.kind === "app") {
      if (match.kind === "app" && isShellAppPath(match.path)) {
        openShellApp(match.path);
        launcher?.hide();
        return true;
      }
      const error = await shell.openPath(match.path);
      if (error) {
        refreshAfterOpenFailure();
        throw new Error(`无法打开「${match.title}」：${error}。索引已刷新，请重新搜索。`);
      }
      launcher?.hide();
      return true;
    }
    if (match.kind === "builtin") {
      if (match.action === "info" || match.action === "file-indexing") {
        return true;
      }
      if (match.action === "copy") {
        clipboard.writeText(match.payload ?? "");
        launcher?.hide();
        return true;
      }
      if (match.action === "file-search") {
        return { action: "file-search", query: match.payload ?? "" };
      }
      if (match.action === "window-search") {
        return { action: "window-search", query: "" };
      }
      if (match.action === "screenshot") {
        launcher?.hide();
        void screenshotController.open();
        return { ok: true, hide: true };
      }
      if (match.action === "hosts") {
        launcher?.hide();
        hostsController.open();
        return { ok: true, hide: true };
      }
      if (match.action === "diff") {
        launcher?.hide();
        diffController.open();
        return { ok: true, hide: true };
      }
      if (match.action === "convert-to") {
        let files: string[] = [];
        let target = "";
        let needsDownload = false;
        try {
          const parsed = JSON.parse(match.payload ?? "{}") as {
            files?: unknown;
            target?: unknown;
            needsDownload?: unknown;
          };
          if (Array.isArray(parsed.files)) {
            files = parsed.files.filter((item): item is string => typeof item === "string");
          }
          if (typeof parsed.target === "string") target = parsed.target;
          needsDownload = parsed.needsDownload === true;
        } catch {
          // Malformed payload: nothing to convert.
        }
        if (files.length === 0 || !target) {
          return { action: "convert-done", ok: false, message: "转换参数无效" };
        }
        // Targets that need an optional download are handled in the convert
        // window, which owns the download confirmation + progress UI.
        if (needsDownload) {
          launcher?.hide();
          convertController.open(files, { target });
          return { ok: true, hide: true };
        }
        // Run in-process; the renderer shows a per-row progress state while the
        // (possibly slow) conversion runs, then a toast + open actions.
        const result = await convertController.convertNow(files, target);
        for (const output of result.outputs ?? []) convertedOutputs.add(path.resolve(output).toLowerCase());
        // Office target became unavailable between listing and now: hand off to
        // the convert window, which owns the download confirmation + progress.
        if (!result.ok && result.needsDownload) {
          launcher?.hide();
          convertController.open(files, { target });
          return { action: "convert-done", ok: true, outputs: [], needsDownload: true };
        }
        return {
          action: "convert-done",
          ok: result.ok,
          outputs: result.outputs,
          message: result.message,
          needsDownload: false,
        };
      }
      if (match.action === "convert") {
        launcher?.hide();
        let files: string[] = [];
        try {
          const parsed = JSON.parse(match.payload ?? "[]") as unknown;
          if (Array.isArray(parsed)) files = parsed.filter((item): item is string => typeof item === "string");
        } catch {
          // Text-triggered entry carries no files.
        }
        convertController.open(files);
        return { ok: true, hide: true };
      }
      if (match.action === "focus-window") {
        launcher?.hide();
        await new Promise((resolve) => setTimeout(resolve, 80));
        try {
          await helper.focusWindow(BigInt(match.payload ?? "0"));
        } catch {
          // The target window may have closed, or Windows denied the switch.
        }
        return true;
      }
      if (match.action === "system") {
        await runSystemCommand(match.payload ?? "");
        return true;
      }
      if (match.action === "settings") {
        launcher?.webContents.send("launcher:open-settings", "settings");
        return true;
      }
      if (match.action === "plugins") {
        launcher?.webContents.send("launcher:open-settings", "plugins");
        return true;
      }
      if (match.action === "translate-window") {
        launcher?.hide();
        translateWindow.open(match.payload ?? "");
        return { ok: true, hide: true };
      }
      const text = match.payload || clipboard.readText();
      launcher?.hide();
      await translation.translateManual(text);
      return true;
    }
    pluginHost.open(
      match.pluginId,
      match.featureCode,
      match.commandType,
      match.payload,
      match.mainHide,
    );
    launcher?.hide();
    return true;
  });

  // Resolve a .lnk to its target so reveal/copy/run-as-admin act on the real
  // file; non-shortcuts (and unreadable shortcuts) use the path as-is.
  const resolveTarget = (filePath: string): string => {
    if (path.extname(filePath).toLowerCase() !== ".lnk") return filePath;
    try {
      const target = shell.readShortcutLink(filePath).target;
      return target || filePath;
    } catch {
      return filePath;
    }
  };

  ipcMain.handle(
    "launcher:item-action",
    async (
      _event,
      id: string,
      action: "open" | "reveal" | "copy-path" | "copy-name" | "run-as-admin" | "preview",
    ): Promise<{ ok: boolean; message?: string; hide?: boolean }> => {
      const match = lastMatches.get(id);
      if (!match || (match.kind !== "app" && match.kind !== "file")) {
        return { ok: false, message: "仅支持应用或文件" };
      }
      const original = match.path;
      if (isShellAppPath(original)) {
        if (action === "open") {
          openShellApp(original);
          return { ok: true, hide: true };
        }
        if (action === "copy-name") {
          clipboard.writeText(match.title);
          return { ok: true, message: "已复制名称" };
        }
        if (action === "copy-path") {
          clipboard.writeText(original);
          return { ok: true, message: "已复制路径" };
        }
        return { ok: false, message: "系统应用不支持此操作" };
      }
      const resolved = resolveTarget(original);
      try {
        if (action === "preview") {
          if (match.kind !== "file") {
            return { ok: false, message: "仅支持预览文件" };
          }
          const result = await previewController.open(original);
          if (!result.ok) return result;
          launcher?.hide();
          return { ok: true, hide: true };
        }
        if (action === "open") {
          const error = await shell.openPath(original);
          if (error) {
            refreshAfterOpenFailure();
            return {
              ok: false,
              message: `无法打开「${match.title}」：${error}。索引已刷新，请重新搜索。`,
            };
          }
          return { ok: true, hide: true };
        }
        if (action === "reveal") {
          shell.showItemInFolder(resolved);
          return { ok: true, hide: true };
        }
        if (action === "copy-path") {
          clipboard.writeText(resolved);
          return { ok: true, message: "已复制路径" };
        }
        if (action === "copy-name") {
          clipboard.writeText(path.basename(resolved));
          return { ok: true, message: "已复制文件名" };
        }
        if (action === "run-as-admin") {
          const extension = path.extname(original).toLowerCase();
          if (match.kind !== "app" || ![".exe", ".lnk", ".appref-ms"].includes(extension)) {
            return { ok: false, message: "仅支持以管理员身份运行应用" };
          }
          const escaped = original.replace(/'/g, "''");
          spawnDetached("powershell.exe", [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `Start-Process -FilePath '${escaped}' -Verb RunAs`,
          ]);
          return { ok: true, hide: true };
        }
        return { ok: false, message: "未知操作" };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    },
  );

  let compactBoundsBeforeHub: { x: number; y: number } | null = null;
  let boundsAnimation: NodeJS.Timeout | null = null;
  ipcMain.on("launcher:resize", (_event, height: unknown, widthValue: unknown) => {
    if (!launcher || launcher.isDestroyed()) return;
    const numeric = typeof height === "number" && Number.isFinite(height) ? height : 0;
    const clamped = Math.round(Math.min(700, Math.max(64, numeric)));
    const bounds = launcher.getBounds();
    const width =
      typeof widthValue === "number" && Number.isFinite(widthValue)
        ? Math.round(Math.min(1_200, Math.max(LAUNCHER_WIDTH, widthValue)))
        : LAUNCHER_WIDTH;
    // Resizing can clamp Y; do not treat that as a user drag.
    suppressLauncherPositionSaveUntil = Date.now() + 600;
    const openingHub = width > bounds.width && bounds.width === LAUNCHER_WIDTH;
    const closingHub = width === LAUNCHER_WIDTH && bounds.width > LAUNCHER_WIDTH;
    if (openingHub) {
      compactBoundsBeforeHub = { x: bounds.x, y: bounds.y };
    }

    // Keep the whole window inside the work area: the top is pinned near 18% of
    // the display, so a tall window would otherwise overflow the bottom edge.
    const { workArea } = screen.getDisplayMatching(bounds);
    // Width changes (compact search bar <-> hub) grow/shrink from the center so
    // the window does not appear to jump to the right. On close, return to the
    // exact compact position saved before the hub opened.
    const centerX = bounds.x + bounds.width / 2;
    let desiredX =
      width === bounds.width ? bounds.x : Math.round(centerX - width / 2);
    let desiredY = bounds.y;
    if (closingHub && compactBoundsBeforeHub) {
      desiredX = compactBoundsBeforeHub.x;
      desiredY = compactBoundsBeforeHub.y;
      // Keep the saved compact position until the shrink animation completes;
      // runSearch may issue a second resize while it is still running.
    }
    const x = Math.max(
      workArea.x,
      Math.min(desiredX, workArea.x + workArea.width - width),
    );
    const y = Math.max(workArea.y, Math.min(desiredY, workArea.y + workArea.height - clamped));
    const target = { x, y, width, height: clamped };

    // Opening/closing the hub changes both width and height. Animate that one
    // transition so the compact search bar and the wide hub feel connected;
    // normal result-height changes stay immediate.
    if (boundsAnimation) {
      clearInterval(boundsAnimation);
      boundsAnimation = null;
    }
    if (bounds.width !== width) {
      const start = { ...bounds };
      const started = Date.now();
      const duration = 190;
      suppressLauncherPositionSaveUntil = Date.now() + duration + 450;
      boundsAnimation = setInterval(() => {
        if (!launcher || launcher.isDestroyed()) {
          if (boundsAnimation) clearInterval(boundsAnimation);
          boundsAnimation = null;
          return;
        }
        const progress = Math.min(1, (Date.now() - started) / duration);
        const eased = 1 - Math.pow(1 - progress, 3);
        launcher.setBounds({
          x: Math.round(start.x + (target.x - start.x) * eased),
          y: Math.round(start.y + (target.y - start.y) * eased),
          width: Math.round(start.width + (target.width - start.width) * eased),
          height: Math.round(start.height + (target.height - start.height) * eased),
        });
        if (progress >= 1) {
          if (boundsAnimation) clearInterval(boundsAnimation);
          boundsAnimation = null;
          if (target.width === LAUNCHER_WIDTH) compactBoundsBeforeHub = null;
        }
      }, 16);
    } else {
      launcher.setBounds(target);
    }
  });

  ipcMain.handle("launcher:add-paths", async (_event, rawPaths: unknown) => {
    const inputs = Array.isArray(rawPaths)
      ? rawPaths.filter((item): item is string => typeof item === "string")
      : [];
    const result = addCustomItems(inputs, { applications: true, directories: false });
    return { added: result.added, skipped: result.skipped };
  });

  ipcMain.handle("launcher:pin-match", async (_event, id: unknown, pinned: unknown) => {
    const matchId = typeof id === "string" ? id : "";
    const current = settingsStore.get();
    const target = matchId ? lastMatches.get(matchId) : undefined;
    if (!target) {
      // Unknown id: just return the current home page unchanged.
      return homeMatches();
    }
    let nextPinned = current.pinnedMatches.slice();
    if (pinned === true) {
      const snapshot = toPinnedSnapshot(target);
      nextPinned = nextPinned.filter((item) => item.id !== snapshot.id);
      nextPinned.unshift(snapshot);
      if (nextPinned.length > 50) nextPinned = nextPinned.slice(0, 50);
    } else {
      nextPinned = nextPinned.filter((item) => item.id !== matchId);
    }
    settingsStore.update({ pinnedMatches: nextPinned });
    applications = rebuildApplications();
    return homeMatches();
  });

  ipcMain.on("launcher:hide", () => launcher?.hide());
  // Files copied in Explorer land on the clipboard as CF_HDROP. Electron cannot
  // read that list through the normal clipboard API, and — crucially —
  // clipboard.availableFormats() does NOT report "FileNameW"/"text/uri-list"
  // for an Explorer copy (it returns Windows-specific format names like
  // "CF_HDROP" or nothing recognizable), so the old precheck returned [] and
  // nothing ever pasted. We now (1) try a single-file fast path via the
  // legacy CF_FILENAMEW buffer, then (2) always fall back to PowerShell's
  // FileDropList without pre-filtering. powershell.exe (5.1) runs STA by
  // default, which Get-Clipboard's FileDropList requires.
  ipcMain.handle("launcher:clipboard-files", async (): Promise<string[]> => {
    const fast = readClipboardFileNameW();
    if (fast.length > 0) return fast;
    return readClipboardFileDropList();
  });

  // Open / reveal a converted output file from the launcher result toast. Only
  // paths produced by a launcher conversion are accepted.
  const isConvertedOutput = (event: Electron.IpcMainInvokeEvent, filePath: unknown): filePath is string =>
    !!launcher &&
    event.sender === launcher.webContents &&
    typeof filePath === "string" &&
    convertedOutputs.has(path.resolve(filePath).toLowerCase());
  ipcMain.handle("launcher:open-path", async (event, filePath: unknown) => {
    if (!isConvertedOutput(event, filePath)) return { ok: false };
    const error = await shell.openPath(filePath);
    if (!error) launcher?.hide();
    return error ? { ok: false, message: error } : { ok: true };
  });
  ipcMain.handle("launcher:reveal-path", (event, filePath: unknown) => {
    if (!isConvertedOutput(event, filePath)) return { ok: false };
    shell.showItemInFolder(filePath);
    launcher?.hide();
    return { ok: true };
  });
  ipcMain.handle("launcher:reset-position", () => {
    settingsStore.update({ launcherPosition: null });
    if (launcher && !launcher.isDestroyed()) {
      const [width, height] = launcher.getSize();
      const { x, y } = defaultLauncherPosition(width, height);
      suppressLauncherPositionSaveUntil = Date.now() + 450;
      launcher.setPosition(x, y, false);
    }
    return { ok: true };
  });
  ipcMain.handle("settings:get", () => ({
    ...settingsStore.get(),
    appVersion: app.getVersion(),
    registeredHotkey,
    registeredScreenshotHotkey,
    pluginErrors: registry.getErrors(),
    inputHelperReady: helperReady,
    translationDiagnostics: translation.getDiagnostics(),
  }));
  ipcMain.handle("settings:update", async (_event, patch: Partial<AppSettings>) => {
    const previous = settingsStore.get();
    const next = settingsStore.update(patch ?? {});
    if (
      previous.hotkey !== next.hotkey ||
      previous.screenshotHotkey !== next.screenshotHotkey
    ) {
      await applyHotkeys(next, helper, helperReady);
    }
    if (previous.launchAtLogin !== next.launchAtLogin) applyLoginSetting(next);
    return { ...next, registeredHotkey, registeredScreenshotHotkey };
  });
  ipcMain.handle("launcher:add-plugin-directory", async () => {
    const result = await dialog.showOpenDialog(launcher!, {
      title: "选择包含 plugin.json 的插件目录",
      properties: ["openDirectory"],
    });
    if (result.canceled || !result.filePaths[0]) return false;
    const directory = result.filePaths[0];
    const current = settingsStore.get();
    if (!current.pluginDirectories.includes(directory)) {
      settingsStore.update({
        pluginDirectories: [...current.pluginDirectories, directory],
      });
    }
    registry.addRoot(directory);
    return true;
  });
  ipcMain.handle("launcher:install-plugin-package", async () => {
    const result = await dialog.showOpenDialog(launcher!, {
      title: "安装离线插件包",
      properties: ["openFile"],
      filters: [{ name: "离线插件包", extensions: ["upx", "upxs"] }],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const installed = await packageInstaller.install(result.filePaths[0]);
    registry.reload();
    return installed;
  });
  ipcMain.handle("launcher:add-custom-item", async () => {
    const result = await dialog.showOpenDialog(launcher!, {
      title: "添加本地应用",
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "应用程序", extensions: ["exe", "lnk", "url", "appref-ms"] },
      ],
    });
    if (result.canceled) return { added: [], skipped: [] };
    const merged = addCustomItems(result.filePaths, {
      applications: true,
      directories: false,
    });
    return { added: merged.added, skipped: merged.skipped };
  });
  ipcMain.handle("launcher:add-custom-directory", async () => {
    const result = await dialog.showOpenDialog(launcher!, {
      title: "添加索引目录",
      properties: ["openDirectory", "multiSelections"],
    });
    if (result.canceled) return { added: [], skipped: [] };
    const merged = addCustomItems(result.filePaths, {
      applications: false,
      directories: true,
    });
    return { added: merged.added, skipped: merged.skipped };
  });
  ipcMain.handle("launcher:list-custom-items", () => currentCustomItems());
  ipcMain.handle("launcher:remove-custom-item", (_event, rawPath: unknown) => {
    if (typeof rawPath !== "string" || !rawPath.trim()) return currentCustomItems();
    const targetKey = customItemKey(rawPath);
    const current = settingsStore.get();
    const customLaunchItems = removeCustomItem(current.customLaunchItems, rawPath);
    const pinnedMatches = current.pinnedMatches.filter(
      (item) => !item.path || customItemKey(item.path) !== targetKey,
    );
    settingsStore.update({ customLaunchItems, pinnedMatches });
    refreshApplications();
    fileSearch.invalidate();
    return currentCustomItems();
  });
  ipcMain.handle("launcher:refresh", () => {
    refreshApplications();
    fileSearch.invalidate();
    void currency.refresh();
    registry.reload();
    return { applications: applications.length, plugins: registry.list().length };
  });

  ipcMain.handle("usage:clear", () => {
    usage.clear();
    return true;
  });

  if (captureUiPath || captureSettingsPath) {
    if (launcher.webContents.isLoading()) {
      await new Promise<void>((resolve) =>
        launcher?.webContents.once("did-finish-load", () => resolve()),
      );
    }
    summonLauncher();
    await new Promise((resolve) => setTimeout(resolve, 180));
    if (captureUiPath) {
      writeFileSync(captureUiPath, (await launcher.webContents.capturePage()).toPNG());
    }
    if (captureSettingsPath) {
      launcher.webContents.send("launcher:open-settings");
      await new Promise((resolve) => setTimeout(resolve, 180));
      writeFileSync(captureSettingsPath, (await launcher.webContents.capturePage()).toPNG());
    }
    helper.stop();
    quitting = true;
    app.quit();
    return;
  }

  if (ocrSmokeTestPath) {
    try {
      const text = await recognizeImageFile(path.resolve(ocrSmokeTestPath));
      const compact = text.replace(/\s+/g, "").toLowerCase();
      if (!compact.includes("helloworld") || !compact.includes("你好") || !compact.includes("世界")) {
        throw new Error(`OCR smoke output was incomplete: ${text}`);
      }
      console.log(`DOCKWISP_OCR_SMOKE:${JSON.stringify({ text })}`);
      helper.stop();
      quitting = true;
      app.quit();
    } catch (error) {
      console.error(error);
      helper.stop();
      quitting = true;
      app.exit(1);
    }
    return;
  }

  if (smokeTest) {
    if (launcher.webContents.isLoading()) {
      await new Promise<void>((resolve) =>
        launcher?.webContents.once("did-finish-load", () => resolve()),
      );
    }
    const renderer = await launcher.webContents.executeJavaScript(
      "({ query: Boolean(document.querySelector('#query')), settings: Boolean(document.querySelector('#settings')) })",
      true,
    );
    console.log(
      `DOCKWISP_SMOKE:${JSON.stringify({
        applications: applications.length,
        plugins: registry.list().length,
        commands: commands.length,
        renderer,
        helper: helperReady,
      })}`,
    );
    helper.stop();
    quitting = true;
    app.quit();
    return;
  }

  applyLoginSetting(settingsStore.get());
  await applyHotkeys(settingsStore.get(), helper, helperReady);
  await createTray();
  if (devMode) summonLauncher();

  app.on("second-instance", () => summonLauncher());
  app.on("activate", () => summonLauncher());
  app.on("before-quit", () => {
    quitting = true;
    if (boundsAnimation) {
      clearInterval(boundsAnimation);
      boundsAnimation = null;
    }
    if (Date.now() >= suppressLauncherPositionSaveUntil) persistLauncherPosition();
    usage.flush();
    helper.stop();
    globalShortcut.unregisterAll();
  });
});

app.on("window-all-closed", () => {
  // The tray and global shortcut keep the application available.
});
