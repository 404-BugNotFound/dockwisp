import { execFile, spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ADVANCED = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced";
const EXPLORER = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer";
const CDM = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\ContentDeliveryManager";
/** CLSID of the Windows Spotlight "Learn about this picture" desktop item. */
const SPOTLIGHT_CLSID = "{2cc5ca98-6485-489a-920e-b3e88a6ccce3}";
const HIDE_ICONS_KEY = `${EXPLORER}\\HideDesktopIcons\\NewStartPanel`;
const CLASSIC_MENU_KEY = "HKCU\\Software\\Classes\\CLSID\\{86ca1aa0-34aa-4e8b-a509-50c905bae2a2}";
const CLASSIC_MENU_INPROC = `${CLASSIC_MENU_KEY}\\InprocServer32`;
const SEARCH_POLICY_KEY = "HKCU\\Software\\Policies\\Microsoft\\Windows\\Explorer";
const SEARCH_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Search";
const SCOOBE_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\UserProfileEngagement";
const STICKY_KEY = "HKCU\\Control Panel\\Accessibility\\StickyKeys";
const MOUSE_KEY = "HKCU\\Control Panel\\Mouse";
const GAME_CONFIG_KEY = "HKCU\\System\\GameConfigStore";
const GAME_DVR_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\GameDVR";
const GAME_BAR_KEY = "HKCU\\Software\\Microsoft\\GameBar";
const SESSION_POWER_KEY = "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Power";
const POWER_KEY = "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Power";
const FILESYSTEM_KEY = "HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem";
const WU_POLICY_KEY = "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate";
const AU_POLICY_KEY = `${WU_POLICY_KEY}\\AU`;

const WIN11_BUILD = 22000;
const UAC_CANCELLED = 1223;

const TIPS_VALUES = [
  "SubscribedContent-338389Enabled",
  "SubscribedContent-310093Enabled",
  "SubscribedContent-338393Enabled",
  "SubscribedContent-353694Enabled",
  "SubscribedContent-353696Enabled",
  "SubscribedContent-338387Enabled",
  "RotatingLockScreenOverlayEnabled",
  "SoftLandingEnabled",
] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const QUICK_TOGGLE_IDS = [
  "hide-spotlight-icon",
  "classic-context-menu",
  "show-file-extensions",
  "show-hidden-files",
  "explorer-open-this-pc",
  "quick-access-no-recent",
  "disable-web-search",
  "clock-seconds",
  "start-no-recommendations",
  "disable-tips",
  "disable-sticky-keys-shortcut",
  "disable-mouse-acceleration",
  "disable-game-bar",
  "disable-fast-startup",
  "disable-hibernation",
  "enable-long-paths",
  "exclude-driver-updates",
  "block-auto-update",
] as const;

export type QuickToggleId = (typeof QUICK_TOGGLE_IDS)[number];

export interface QuickToggleState {
  id: QuickToggleId;
  enabled: boolean;
}

export type RegValueType = "REG_DWORD" | "REG_SZ";

export type ToggleOp =
  /** `name: null` targets the key's default value (`/ve`). */
  | { kind: "regAdd"; key: string; name: string | null; type: RegValueType; data: string; optional?: boolean }
  /** Without `name` the whole key is deleted. */
  | { kind: "regDelete"; key: string; name?: string }
  | { kind: "stickyHotkey"; active: boolean }
  | { kind: "mouseParams"; values: readonly [number, number, number] }
  | { kind: "powercfg"; args: readonly string[] };

export type AfterAction = "none" | "broadcast" | "restartExplorer";

export interface RegValue {
  type: string;
  data: string;
}

/** Values of one registry key, keyed by lower-cased value name. */
export type RegKeyValues = Map<string, RegValue>;

/** Query results keyed by lower-cased key path; `null` means the key does not exist. */
export type RegSnapshot = Map<string, RegKeyValues | null>;

export interface QuickToggleDef {
  id: QuickToggleId;
  label: string;
  admin: boolean;
  after: AfterAction;
  minBuild?: number;
  /** Registry keys whose `reg query` output `read` needs. */
  keys: readonly string[];
  read(snapshot: RegSnapshot): boolean;
  on: readonly ToggleOp[];
  off: readonly ToggleOp[];
}

// ---------------------------------------------------------------------------
// Snapshot helpers
// ---------------------------------------------------------------------------

export function snapshotValue(snapshot: RegSnapshot, key: string, name: string): RegValue | undefined {
  return snapshot.get(key.toLowerCase())?.get(name.toLowerCase());
}

export function snapshotKeyExists(snapshot: RegSnapshot, key: string): boolean {
  const entry = snapshot.get(key.toLowerCase());
  return entry !== undefined && entry !== null;
}

/** Numeric value of a DWORD (hex `0x..`) or decimal REG_SZ value. */
export function snapshotNumber(snapshot: RegSnapshot, key: string, name: string): number | undefined {
  const value = snapshotValue(snapshot, key, name);
  if (!value) return undefined;
  const text = value.data.trim();
  const parsed = /^0x[0-9a-f]+$/i.test(text) ? parseInt(text, 16) : /^-?\d+$/.test(text) ? parseInt(text, 10) : NaN;
  return Number.isNaN(parsed) ? undefined : parsed;
}

const isNum = (key: string, name: string, expected: number) => (s: RegSnapshot) =>
  snapshotNumber(s, key, name) === expected;

const dword = (key: string, name: string, value: number): ToggleOp => ({
  kind: "regAdd",
  key,
  name,
  type: "REG_DWORD",
  data: String(value),
});
const delValue = (key: string, name: string): ToggleOp => ({ kind: "regDelete", key, name });

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

export const QUICK_TOGGLE_DEFS: readonly QuickToggleDef[] = [
  {
    id: "hide-spotlight-icon",
    label: "隐藏“了解此图片”图标",
    admin: false,
    after: "broadcast",
    keys: [HIDE_ICONS_KEY],
    read: isNum(HIDE_ICONS_KEY, SPOTLIGHT_CLSID, 1),
    on: [dword(HIDE_ICONS_KEY, SPOTLIGHT_CLSID, 1)],
    off: [delValue(HIDE_ICONS_KEY, SPOTLIGHT_CLSID)],
  },
  {
    id: "classic-context-menu",
    label: "经典右键菜单",
    admin: false,
    after: "restartExplorer",
    minBuild: WIN11_BUILD,
    keys: [CLASSIC_MENU_INPROC],
    read: (s) => snapshotKeyExists(s, CLASSIC_MENU_INPROC),
    on: [{ kind: "regAdd", key: CLASSIC_MENU_INPROC, name: null, type: "REG_SZ", data: "" }],
    off: [{ kind: "regDelete", key: CLASSIC_MENU_KEY }],
  },
  {
    id: "show-file-extensions",
    label: "显示文件扩展名",
    admin: false,
    after: "broadcast",
    keys: [ADVANCED],
    read: isNum(ADVANCED, "HideFileExt", 0),
    on: [dword(ADVANCED, "HideFileExt", 0)],
    off: [dword(ADVANCED, "HideFileExt", 1)],
  },
  {
    id: "show-hidden-files",
    label: "显示隐藏文件",
    admin: false,
    after: "broadcast",
    keys: [ADVANCED],
    read: isNum(ADVANCED, "Hidden", 1),
    on: [dword(ADVANCED, "Hidden", 1)],
    off: [dword(ADVANCED, "Hidden", 2)],
  },
  {
    id: "explorer-open-this-pc",
    label: "资源管理器打开“此电脑”",
    admin: false,
    after: "none",
    keys: [ADVANCED],
    read: isNum(ADVANCED, "LaunchTo", 1),
    on: [dword(ADVANCED, "LaunchTo", 1)],
    off: [delValue(ADVANCED, "LaunchTo")],
  },
  {
    id: "quick-access-no-recent",
    label: "快速访问不显示最近使用",
    admin: false,
    after: "none",
    keys: [EXPLORER],
    read: (s) => isNum(EXPLORER, "ShowRecent", 0)(s) && isNum(EXPLORER, "ShowFrequent", 0)(s),
    on: [dword(EXPLORER, "ShowRecent", 0), dword(EXPLORER, "ShowFrequent", 0)],
    off: [delValue(EXPLORER, "ShowRecent"), delValue(EXPLORER, "ShowFrequent")],
  },
  {
    id: "disable-web-search",
    label: "禁用开始菜单网络搜索",
    // HKCU\Software\Policies only grants the user read access, so writing it needs elevation.
    admin: true,
    after: "restartExplorer",
    keys: [SEARCH_POLICY_KEY],
    read: isNum(SEARCH_POLICY_KEY, "DisableSearchBoxSuggestions", 1),
    // The policy alone turns off web results; BingSearchEnabled is a best-effort extra
    // because some builds lock the Search key even for administrators.
    on: [
      dword(SEARCH_POLICY_KEY, "DisableSearchBoxSuggestions", 1),
      { kind: "regAdd", key: SEARCH_KEY, name: "BingSearchEnabled", type: "REG_DWORD", data: "0", optional: true },
    ],
    off: [delValue(SEARCH_POLICY_KEY, "DisableSearchBoxSuggestions"), delValue(SEARCH_KEY, "BingSearchEnabled")],
  },
  {
    id: "clock-seconds",
    label: "任务栏时钟显示秒",
    admin: false,
    after: "restartExplorer",
    minBuild: WIN11_BUILD,
    keys: [ADVANCED],
    read: isNum(ADVANCED, "ShowSecondsInSystemClock", 1),
    on: [dword(ADVANCED, "ShowSecondsInSystemClock", 1)],
    off: [delValue(ADVANCED, "ShowSecondsInSystemClock")],
  },
  {
    id: "start-no-recommendations",
    label: "开始菜单不显示推荐",
    admin: false,
    after: "restartExplorer",
    minBuild: WIN11_BUILD,
    keys: [ADVANCED],
    read: isNum(ADVANCED, "Start_IrisRecommendations", 0),
    on: [
      dword(ADVANCED, "Start_IrisRecommendations", 0),
      dword(ADVANCED, "Start_AccountNotifications", 0),
      dword(CDM, "SubscribedContent-338388Enabled", 0),
    ],
    off: [
      delValue(ADVANCED, "Start_IrisRecommendations"),
      delValue(ADVANCED, "Start_AccountNotifications"),
      dword(CDM, "SubscribedContent-338388Enabled", 1),
    ],
  },
  {
    id: "disable-tips",
    label: "关闭提示与建议",
    admin: false,
    after: "none",
    keys: [CDM],
    read: isNum(CDM, "SubscribedContent-338389Enabled", 0),
    on: [...TIPS_VALUES.map((name) => dword(CDM, name, 0)), dword(SCOOBE_KEY, "ScoobeSystemSettingEnabled", 0)],
    off: [...TIPS_VALUES.map((name) => dword(CDM, name, 1)), dword(SCOOBE_KEY, "ScoobeSystemSettingEnabled", 1)],
  },
  {
    id: "disable-sticky-keys-shortcut",
    label: "禁用粘滞键快捷方式",
    admin: false,
    after: "none",
    keys: [STICKY_KEY],
    read: (s) => {
      // Windows default is "510", which has SKF_HOTKEYACTIVE set.
      const flags = snapshotNumber(s, STICKY_KEY, "Flags") ?? 510;
      return (flags & 0x4) === 0;
    },
    on: [{ kind: "stickyHotkey", active: false }],
    off: [{ kind: "stickyHotkey", active: true }],
  },
  {
    id: "disable-mouse-acceleration",
    label: "关闭鼠标加速",
    admin: false,
    after: "none",
    keys: [MOUSE_KEY],
    read: (s) => snapshotValue(s, MOUSE_KEY, "MouseSpeed")?.data.trim() === "0",
    on: [{ kind: "mouseParams", values: [0, 0, 0] }],
    off: [{ kind: "mouseParams", values: [6, 10, 1] }],
  },
  {
    id: "disable-game-bar",
    label: "关闭 Xbox Game Bar",
    admin: false,
    after: "none",
    keys: [GAME_BAR_KEY],
    read: isNum(GAME_BAR_KEY, "UseNexusForGameBarEnabled", 0),
    on: [
      dword(GAME_CONFIG_KEY, "GameDVR_Enabled", 0),
      dword(GAME_DVR_KEY, "AppCaptureEnabled", 0),
      dword(GAME_BAR_KEY, "UseNexusForGameBarEnabled", 0),
    ],
    off: [
      dword(GAME_CONFIG_KEY, "GameDVR_Enabled", 1),
      dword(GAME_DVR_KEY, "AppCaptureEnabled", 1),
      dword(GAME_BAR_KEY, "UseNexusForGameBarEnabled", 1),
    ],
  },
  {
    id: "disable-fast-startup",
    label: "关闭快速启动",
    admin: true,
    after: "none",
    keys: [SESSION_POWER_KEY],
    read: isNum(SESSION_POWER_KEY, "HiberbootEnabled", 0),
    on: [dword(SESSION_POWER_KEY, "HiberbootEnabled", 0)],
    off: [dword(SESSION_POWER_KEY, "HiberbootEnabled", 1)],
  },
  {
    id: "disable-hibernation",
    label: "关闭休眠",
    admin: true,
    after: "none",
    keys: [POWER_KEY],
    read: isNum(POWER_KEY, "HibernateEnabled", 0),
    on: [{ kind: "powercfg", args: ["/h", "off"] }],
    off: [{ kind: "powercfg", args: ["/h", "on"] }],
  },
  {
    id: "enable-long-paths",
    label: "启用长路径",
    admin: true,
    after: "none",
    keys: [FILESYSTEM_KEY],
    read: isNum(FILESYSTEM_KEY, "LongPathsEnabled", 1),
    on: [dword(FILESYSTEM_KEY, "LongPathsEnabled", 1)],
    off: [dword(FILESYSTEM_KEY, "LongPathsEnabled", 0)],
  },
  {
    id: "exclude-driver-updates",
    label: "Windows 更新不推送驱动",
    admin: true,
    after: "none",
    keys: [WU_POLICY_KEY],
    read: isNum(WU_POLICY_KEY, "ExcludeWUDriversInQualityUpdate", 1),
    on: [dword(WU_POLICY_KEY, "ExcludeWUDriversInQualityUpdate", 1)],
    off: [delValue(WU_POLICY_KEY, "ExcludeWUDriversInQualityUpdate")],
  },
  {
    id: "block-auto-update",
    label: "阻止自动更新",
    admin: true,
    after: "none",
    keys: [AU_POLICY_KEY],
    read: isNum(AU_POLICY_KEY, "NoAutoUpdate", 1),
    on: [dword(AU_POLICY_KEY, "NoAutoUpdate", 1)],
    off: [delValue(AU_POLICY_KEY, "NoAutoUpdate")],
  },
];

export function findToggleDef(id: unknown): QuickToggleDef | undefined {
  return typeof id === "string" ? QUICK_TOGGLE_DEFS.find((def) => def.id === id) : undefined;
}

export function opsFor(def: QuickToggleDef, enabled: boolean): readonly ToggleOp[] {
  return enabled ? def.on : def.off;
}

/** Build number from `os.release()` such as "10.0.22631"; 0 when unknown. */
export function parseWindowsBuild(release: string): number {
  const build = Number(release.split(".")[2]);
  return Number.isFinite(build) ? build : 0;
}

export function isToggleSupported(def: QuickToggleDef, build: number): boolean {
  return def.minBuild === undefined || build >= def.minBuild;
}

// ---------------------------------------------------------------------------
// reg query parsing
// ---------------------------------------------------------------------------

/** Parse the values of the first key in `reg query <key>` output; sub-key listings are ignored. */
export function parseRegQuery(stdout: string): RegKeyValues {
  const values: RegKeyValues = new Map();
  let headers = 0;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (!/^\s/.test(line)) {
      headers += 1;
      if (headers > 1) break;
      continue;
    }
    const match = /^ {4}(.+?) {4}(REG_[A-Z_]+)(?: {4}(.*))?$/.exec(line.replace(/\s+$/, ""));
    if (!match) continue;
    values.set(match[1].toLowerCase(), { type: match[2], data: match[3] ?? "" });
  }
  return values;
}

// ---------------------------------------------------------------------------
// Command builders
// ---------------------------------------------------------------------------

export interface CommandSpec {
  file: string;
  args: string[];
  /** Failure is harmless (e.g. deleting a value that is already gone). */
  ignoreFailure?: boolean;
}

const STICKY_TYPE =
  "Add-Type -Namespace DW -Name SK -MemberDefinition '[StructLayout(LayoutKind.Sequential)] public struct STICKYKEYS { public uint cbSize; public uint dwFlags; } " +
  "[DllImport(\"user32.dll\", SetLastError=true)] public static extern bool SystemParametersInfo(uint a, uint b, ref STICKYKEYS c, uint d);';";
const MOUSE_TYPE =
  "Add-Type -Namespace DW -Name MS -MemberDefinition '[DllImport(\"user32.dll\", SetLastError=true)] public static extern bool SystemParametersInfo(uint a, uint b, int[] c, uint d);';";
/** SPIF_UPDATEINIFILE | SPIF_SENDCHANGE */
const SPIF_PERSIST = 3;

export function stickyHotkeyScript(active: boolean): string {
  const flags = active
    ? "[uint32](([int64]$s.dwFlags) -bor 4)"
    : "[uint32](([int64]$s.dwFlags) -band 4294967291)";
  return (
    "$ErrorActionPreference='Stop';" +
    STICKY_TYPE +
    "$s = New-Object 'DW.SK+STICKYKEYS'; $s.cbSize = 8;" +
    "if (-not [DW.SK]::SystemParametersInfo(0x3A, 8, [ref]$s, 0)) { exit 2 };" +
    `$s.dwFlags = ${flags};` +
    `if (-not [DW.SK]::SystemParametersInfo(0x3B, 8, [ref]$s, ${SPIF_PERSIST})) { exit 3 }`
  );
}

export function mouseParamsScript(values: readonly [number, number, number]): string {
  if (!values.every((v) => Number.isInteger(v) && v >= 0 && v <= 20)) throw new Error("鼠标参数无效");
  return (
    "$ErrorActionPreference='Stop';" +
    MOUSE_TYPE +
    `if (-not [DW.MS]::SystemParametersInfo(0x4, 0, [int[]]@(${values.join(",")}), ${SPIF_PERSIST})) { exit 3 }`
  );
}

const POWERSHELL_ARGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"];

export function commandFor(op: ToggleOp): CommandSpec {
  switch (op.kind) {
    case "regAdd": {
      const args = ["add", op.key];
      if (op.name === null) args.push("/ve");
      else args.push("/v", op.name);
      // execFile passes an empty argument as "", so `/d ""` reaches reg.exe intact.
      args.push("/t", op.type, "/d", op.data, "/f");
      return { file: "reg.exe", args, ignoreFailure: op.optional === true };
    }
    case "regDelete": {
      const args = ["delete", op.key];
      if (op.name !== undefined) args.push("/v", op.name);
      args.push("/f");
      return { file: "reg.exe", args, ignoreFailure: true };
    }
    case "stickyHotkey":
      return { file: "powershell.exe", args: [...POWERSHELL_ARGS, "-Command", stickyHotkeyScript(op.active)] };
    case "mouseParams":
      return { file: "powershell.exe", args: [...POWERSHELL_ARGS, "-Command", mouseParamsScript(op.values)] };
    case "powercfg":
      return { file: "powercfg.exe", args: [...op.args] };
  }
}

/** Quote a string as a PowerShell single-quoted literal. */
export function psQuote(value: string): string {
  return `'${value.replace(/['\u2018\u2019\u201a\u201b]/g, "$&$&")}'`;
}

/** Base64 of UTF-16LE text, as expected by `powershell -EncodedCommand`. */
export function encodePowerShell(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

/** Script run inside the elevated PowerShell: every command of one toggle, exit 1 if any required step failed. */
export function buildElevatedScript(ops: readonly ToggleOp[]): string {
  const lines = ["$ErrorActionPreference='Continue'", "$failed = 0"];
  for (const op of ops) {
    const command = commandFor(op);
    // Windows PowerShell 5.1 drops empty native arguments, so they must never appear here.
    if (command.args.some((arg) => arg === "")) throw new Error("提权命令包含空参数");
    const invocation = `& ${psQuote(command.file)} ${command.args.map(psQuote).join(" ")}`;
    lines.push(command.ignoreFailure ? `${invocation} | Out-Null` : `${invocation} | Out-Null; if ($LASTEXITCODE -ne 0) { $failed = 1 }`);
  }
  lines.push("exit $failed");
  return lines.join("\r\n");
}

/** Outer (non-elevated) script: one UAC prompt running the encoded inner script. 1223 when declined. */
export function buildElevationLauncher(innerScript: string): string {
  const encoded = encodePowerShell(innerScript);
  const argList = [...POWERSHELL_ARGS, "-WindowStyle", "Hidden", "-EncodedCommand", encoded].map(psQuote).join(",");
  return (
    "$ErrorActionPreference='Stop';" +
    `try { $p = Start-Process -FilePath 'powershell.exe' -ArgumentList ${argList} -Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode }` +
    ` catch { exit ${UAC_CANCELLED} }`
  );
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

function run(file: string, args: string[], timeout = 10_000): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout }, (error, stdout) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolve({ code, stdout: stdout ?? "" });
    });
  });
}

async function readSnapshot(keys: Iterable<string>): Promise<RegSnapshot> {
  const unique = [...new Set([...keys].map((key) => key.toLowerCase()))];
  const original = new Map<string, string>();
  for (const key of keys) original.set(key.toLowerCase(), key);
  const snapshot: RegSnapshot = new Map();
  await Promise.all(
    unique.map(async (lower) => {
      const { code, stdout } = await run("reg.exe", ["query", original.get(lower)!], 5_000);
      snapshot.set(lower, code === 0 ? parseRegQuery(stdout) : null);
    }),
  );
  return snapshot;
}

/** Ask Explorer to redraw the desktop and open windows (SHChangeNotify SHCNE_ASSOCCHANGED). */
async function refreshDesktop(): Promise<void> {
  const script =
    "Add-Type -Namespace W -Name S -MemberDefinition '[DllImport(\"shell32.dll\")] public static extern void SHChangeNotify(int e,int f,System.IntPtr a,System.IntPtr b);';" +
    "[W.S]::SHChangeNotify(0x8000000,0,[System.IntPtr]::Zero,[System.IntPtr]::Zero)";
  await run("powershell.exe", [...POWERSHELL_ARGS, "-Command", script]);
}

async function explorerRunning(): Promise<boolean> {
  const { stdout } = await run("tasklist.exe", ["/fi", "IMAGENAME eq explorer.exe", "/nh"], 5_000);
  return /explorer\.exe/i.test(stdout);
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function restartExplorer(): Promise<void> {
  await run("taskkill.exe", ["/f", "/im", "explorer.exe"]);
  // Winlogon's AutoRestartShell usually brings Explorer back by itself; only start it if it does not.
  const deadline = Date.now() + 1_500;
  while (Date.now() < deadline) {
    await delay(300);
    if (await explorerRunning()) return;
  }
  const explorer = path.join(process.env.SystemRoot ?? "C:\\Windows", "explorer.exe");
  const child = spawn(explorer, [], { detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", () => undefined);
  child.unref();
}

async function runAfter(action: AfterAction): Promise<void> {
  if (action === "broadcast") await refreshDesktop();
  else if (action === "restartExplorer") await restartExplorer();
}

async function readToggle(def: QuickToggleDef): Promise<boolean> {
  return def.read(await readSnapshot(def.keys));
}

export async function listQuickToggles(): Promise<QuickToggleState[]> {
  if (process.platform !== "win32") return [];
  const build = parseWindowsBuild(os.release());
  const defs = QUICK_TOGGLE_DEFS.filter((def) => isToggleSupported(def, build));
  const snapshot = await readSnapshot(defs.flatMap((def) => def.keys));
  return defs.map((def) => ({ id: def.id, enabled: def.read(snapshot) }));
}

export async function setQuickToggle(id: unknown, enabled: unknown): Promise<QuickToggleState> {
  if (process.platform !== "win32") throw new Error("仅支持 Windows");
  const def = findToggleDef(id);
  if (!def) throw new Error("未知的快捷开关");
  if (typeof enabled !== "boolean") throw new Error("开关参数无效");
  if (!isToggleSupported(def, parseWindowsBuild(os.release()))) throw new Error("当前系统不支持此开关");
  const ops = opsFor(def, enabled);

  if (def.admin) {
    const launcher = buildElevationLauncher(buildElevatedScript(ops));
    // The UAC prompt waits for the user, so allow up to two minutes.
    const { code } = await run("powershell.exe", [...POWERSHELL_ARGS, "-Command", launcher], 120_000);
    const state = await readToggle(def);
    if (state !== enabled) throw new Error(code === UAC_CANCELLED ? "已取消管理员授权" : `修改“${def.label}”失败`);
    await runAfter(def.after);
    return { id: def.id, enabled: state };
  }

  for (const op of ops) {
    const command = commandFor(op);
    const { code } = await run(command.file, command.args, 30_000);
    if (code !== 0 && !command.ignoreFailure) {
      throw new Error(command.file === "reg.exe" ? `写入注册表失败（${def.label}）` : `修改“${def.label}”失败`);
    }
  }
  await runAfter(def.after);
  const state = await readToggle(def);
  if (state !== enabled) throw new Error(`“${def.label}”未生效，请重试`);
  return { id: def.id, enabled: state };
}
