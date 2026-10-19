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
  AppMatch,
  BuiltinMatch,
  CommandMatch,
  CommandType,
  FileMatch,
  PinnedMatch,
  SearchInput,
  SearchMatch,
} from "../core/types";
import { buildApplicationIndex, LAUNCHABLE_EXTENSIONS } from "./app-index";
import { CurrencyRates } from "./currency";
import { FileSearch } from "./file-search";
import { MouseHelper } from "./mouse-helper";
import { PluginHost } from "./plugin-host";
import { PluginPackageInstaller } from "./plugin-package";
import { PluginRegistry } from "./plugin-registry";
import { AppSettings, SettingsStore } from "./settings";
import { TranslationController } from "./translation-controller";
import { TRAY_ICON_DATA_URL } from "./tray-icon";
import { UsageStore } from "./usage-store";
import { createLauncherWindow, showLauncher } from "./windows";

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

interface SystemCommand {
  id: string;
  title: string;
  subtitle: string;
  keywords: string[];
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
  },
];

/** Score a system command against the query; -1 when it does not match. */
function scoreSystemCommand(command: SystemCommand, query: string, lower: string): number {
  if (command.title === query) return 1_300;
  if (command.keywords.some((keyword) => keyword.toLowerCase() === lower)) return 1_250;
  const keywordMatches = command.keywords.some((keyword) => {
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

function systemMatches(query: string, lower: string): BuiltinMatch[] {
  return SYSTEM_COMMANDS.map((command) => ({ command, score: scoreSystemCommand(command, query, lower) }))
    .filter(({ score }) => score >= 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 3)
    .map(({ command, score }) => ({
      id: `system:${command.id}`,
      kind: "builtin" as const,
      action: "system" as const,
      title: command.title,
      subtitle: command.subtitle,
      score,
      payload: command.id,
    }));
}

function builtinMatches(input: SearchInput): BuiltinMatch[] {
  if (input.type !== "text") return [];
  const query = input.data.trim();
  if (!query) return [];
  const lower = query.toLowerCase();
  const matches: BuiltinMatch[] = [];
  if ("设置".includes(query) || "settings".startsWith(lower)) {
    matches.push({
      id: "builtin:settings",
      kind: "builtin",
      action: "settings",
      title: "设置",
      subtitle: "快捷键、插件目录与翻译服务",
      score: 920,
    });
  }
  const explicit = query.match(/^(?:翻译|translate)\s+(.+)$/i);
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
  // Discoverable entry point for window switching; the renderer rewrites the
  // input to "窗口 " and re-searches when chosen.
  if (query === "窗口" || lower === "window" || query === "切换窗口") {
    matches.push({
      id: "builtin:window-search",
      kind: "builtin",
      action: "window-search",
      title: "切换窗口",
      subtitle: "输入“窗口 关键词”筛选窗口",
      score: 1_200,
      payload: "",
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

async function appIconUrl(filePath: string): Promise<string | undefined> {
  if (!filePath || !existsSync(filePath)) return undefined;
  const cached = iconCache.get(filePath);
  if (cached) return cached;
  try {
    // Shell shortcut icons are often the generic .lnk page + arrow. Resolve the
    // target (or the shortcut's explicit icon) so the result shows the app icon.
    let iconSource = filePath;
    if (path.extname(filePath).toLowerCase() === ".lnk") {
      try {
        const shortcut = shell.readShortcutLink(filePath);
        const candidate = shortcut.icon || shortcut.target;
        if (candidate && existsSync(candidate)) iconSource = candidate;
      } catch {
        // Keep the shortcut icon if the link cannot be read.
      }
    }
    const image = await app.getFileIcon(iconSource, { size: "large" });
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
    if (!snapshot.path || !existsSync(snapshot.path)) return null;
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
  if (globalShortcut.register(settings.hotkey, () => launcher && showLauncher(launcher))) {
    registeredHotkey = settings.hotkey;
    return;
  }
  if (settings.hotkey !== "Control+Space") {
    if (globalShortcut.register("Control+Space", () => launcher && showLauncher(launcher))) {
      registeredHotkey = "Control+Space";
    }
  }
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
      { label: "打开 Dockwisp", click: () => launcher && showLauncher(launcher) },
      { label: "设置", click: () => launcher && showLauncher(launcher, true) },
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
  tray.on("click", () => launcher && showLauncher(launcher));
}

void app.whenReady().then(async () => {
  const smokeTest = process.argv.includes("--smoke-test");
  const devMode = process.argv.includes("--dev");
  const captureUiPath = process.argv.find((item) => item.startsWith("--capture-ui="))?.slice(13);
  const captureSettingsPath = process.argv
    .find((item) => item.startsWith("--capture-settings="))
    ?.slice(19);
  const settingsStore = new SettingsStore(app.getPath("userData"));
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

  let applications = buildApplicationIndex(
    settingsStore.get().customLaunchItems,
    pinnedAppPaths(settingsStore.get().pinnedMatches),
  );
  let commands = registry.getCommands();
  registry.on("changed", () => {
    commands = registry.getCommands();
    launcher?.webContents.send("launcher:index-updated");
  });

  launcher = createLauncherWindow();
  launcher.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      launcher?.hide();
    }
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
      showLauncher(launcher!);
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

  const rememberMatches = (matches: SearchMatch[]): void => {
    lastMatches.clear();
    for (const match of matches) lastMatches.set(match.id, match);
  };

  /** Rebuild the in-memory app index after an external install/uninstall. */
  const refreshApplications = (): void => {
    applications = buildApplicationIndex(
      settingsStore.get().customLaunchItems,
      pinnedAppPaths(settingsStore.get().pinnedMatches),
    );
    launcher?.webContents.send("launcher:index-updated");
  };

  /**
   * A stale result (for example an app uninstalled while Dockwisp was running)
   * fails to open. Rebuild the app index and invalidate file results so the next
   * search no longer lists the removed path.
   */
  const refreshAfterOpenFailure = (): void => {
    refreshApplications();
    fileSearch.invalidate();
  };

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
    rankFilePaths(paths, query, 40).map((item) => ({
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

  const spawnDetached = (command: string, args: string[]): void => {
    try {
      const child = spawn(command, args, {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();
    } catch {
      // Best-effort: a missing system binary should not crash the launcher.
    }
  };

  const runSystemCommand = async (commandId: string): Promise<void> => {
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
        spawnDetached("taskmgr.exe", []);
        launcher?.hide();
        return;
      case "settings":
        void shell.openExternal("ms-settings:");
        launcher?.hide();
        return;
      case "explorer":
        spawnDetached("explorer.exe", []);
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

  ipcMain.handle("launcher:search", async (_event, rawInput: unknown) => {
    const input = normalizeInput(rawInput);
    // File-search mode: text prefixed with "文件 " or "file ".
    if (input.type === "text") {
      const fileMode = input.data.match(/^(?:文件|file)\s+(.*)$/i);
      if (fileMode) {
        const query = fileMode[1].trim();
        if (!query) {
          rememberMatches([]);
          return [];
        }
        const result = await fileSearch.query(query);
        if (result.status === "indexing") {
          const match: BuiltinMatch = {
            id: "status:file-indexing",
            kind: "builtin",
            action: "file-indexing",
            title: "正在建立文件索引…",
            subtitle: "首次运行需要几分钟，完成后会自动显示结果",
            score: 9999,
            payload: query,
          };
          rememberMatches([match]);
          return serializeMatches([match]);
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
          return serializeMatches([match]);
        }
        if (result.status === "fallback" && result.paths.length === 0) {
          const match: BuiltinMatch = {
            id: "status:file-empty",
            kind: "builtin",
            action: "info",
            title: "没有找到文件",
            subtitle: "Everything 暂不可用，已使用常用目录的有限索引",
            score: 9999,
          };
          rememberMatches([match]);
          return serializeMatches([match]);
        }
        const files = rankFileMatches(result.paths, query);
        rememberMatches(files);
        return serializeMatches(files);
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
    const merged = mergeMatches(
      [tools, builtinMatches(input), pluginMatches, appMatches],
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
        launcher?.webContents.send("launcher:open-settings");
        return true;
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
      action: "open" | "reveal" | "copy-path" | "copy-name" | "run-as-admin",
    ): Promise<{ ok: boolean; message?: string; hide?: boolean }> => {
      const match = lastMatches.get(id);
      if (!match || (match.kind !== "app" && match.kind !== "file")) {
        return { ok: false, message: "仅支持应用或文件" };
      }
      const original = match.path;
      const resolved = resolveTarget(original);
      try {
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

  ipcMain.on("launcher:resize", (_event, height: unknown) => {
    if (!launcher || launcher.isDestroyed()) return;
    const numeric = typeof height === "number" && Number.isFinite(height) ? height : 0;
    const clamped = Math.round(Math.min(640, Math.max(64, numeric)));
    const bounds = launcher.getBounds();
    const width = 780;
    // Keep the whole window inside the work area: the top is pinned near 18% of
    // the display, so a tall window would otherwise overflow the bottom edge.
    const { workArea } = screen.getDisplayMatching(bounds);
    const y = Math.max(workArea.y, Math.min(bounds.y, workArea.y + workArea.height - clamped));
    launcher.setBounds({ x: bounds.x, y, width, height: clamped });
  });

  ipcMain.handle("launcher:add-paths", async (_event, rawPaths: unknown) => {
    const inputs = Array.isArray(rawPaths)
      ? rawPaths.filter((item): item is string => typeof item === "string")
      : [];
    const current = settingsStore.get();
    const existingLower = new Set(
      current.customLaunchItems.map((item) => item.toLowerCase()),
    );
    const added: Array<{ name: string; path: string }> = [];
    const skipped: string[] = [];
    const accepted: string[] = [];
    for (const raw of inputs) {
      const filePath = raw.trim();
      if (!filePath) continue;
      const extension = path.extname(filePath).toLowerCase();
      let isFile = false;
      try {
        isFile = statSync(filePath).isFile();
      } catch {
        isFile = false;
      }
      if (!isFile || !LAUNCHABLE_EXTENSIONS.has(extension)) {
        skipped.push(filePath);
        continue;
      }
      const lower = filePath.toLowerCase();
      if (existingLower.has(lower)) {
        skipped.push(filePath);
        continue;
      }
      existingLower.add(lower);
      accepted.push(filePath);
      added.push({ name: path.basename(filePath, extension), path: filePath });
    }
    if (accepted.length) {
      settingsStore.update({
        customLaunchItems: [...current.customLaunchItems, ...accepted],
      });
      applications = buildApplicationIndex(
        settingsStore.get().customLaunchItems,
        pinnedAppPaths(settingsStore.get().pinnedMatches),
      );
      launcher?.webContents.send("launcher:index-updated");
    }
    return { added, skipped };
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
      // Ensure launchable targets are present in the custom item list.
      if ((target.kind === "app" || target.kind === "file") && target.path) {
        const lower = target.path.toLowerCase();
        if (!current.customLaunchItems.some((item) => item.toLowerCase() === lower)) {
          settingsStore.update({
            customLaunchItems: [...current.customLaunchItems, target.path],
          });
        }
      }
    } else {
      nextPinned = nextPinned.filter((item) => item.id !== matchId);
    }
    settingsStore.update({ pinnedMatches: nextPinned });
    applications = buildApplicationIndex(
      settingsStore.get().customLaunchItems,
      pinnedAppPaths(settingsStore.get().pinnedMatches),
    );
    return homeMatches();
  });

  ipcMain.on("launcher:hide", () => launcher?.hide());
  ipcMain.handle("settings:get", () => ({
    ...settingsStore.get(),
    registeredHotkey,
    pluginErrors: registry.getErrors(),
    inputHelperReady: helperReady,
    translationDiagnostics: translation.getDiagnostics(),
  }));
  ipcMain.handle("settings:update", async (_event, patch: Partial<AppSettings>) => {
    const previous = settingsStore.get();
    const next = settingsStore.update(patch ?? {});
    if (previous.hotkey !== next.hotkey) {
      await registerHotkey(next, helper, helperReady);
    }
    if (previous.launchAtLogin !== next.launchAtLogin) applyLoginSetting(next);
    return { ...next, registeredHotkey };
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
      title: "添加应用、文件或目录",
      properties: ["openFile", "openDirectory", "multiSelections"],
    });
    if (result.canceled) return false;
    const current = settingsStore.get();
    settingsStore.update({
      customLaunchItems: [...new Set([...current.customLaunchItems, ...result.filePaths])],
    });
    applications = buildApplicationIndex(
      settingsStore.get().customLaunchItems,
      pinnedAppPaths(settingsStore.get().pinnedMatches),
    );
    launcher?.webContents.send("launcher:index-updated");
    return true;
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
    showLauncher(launcher);
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
  await registerHotkey(settingsStore.get(), helper, helperReady);
  await createTray();
  if (devMode) showLauncher(launcher);

  app.on("second-instance", () => launcher && showLauncher(launcher));
  app.on("activate", () => launcher && showLauncher(launcher));
  app.on("before-quit", () => {
    quitting = true;
    usage.flush();
    helper.stop();
    globalShortcut.unregisterAll();
  });
});

app.on("window-all-closed", () => {
  // The tray and global shortcut keep the application available.
});
