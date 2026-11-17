import { execFile } from "node:child_process";

/** CLSID of the Windows Spotlight "Learn about this picture" desktop item. */
const SPOTLIGHT_CLSID = "{2cc5ca98-6485-489a-920e-b3e88a6ccce3}";
const HIDE_ICONS_KEY =
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\HideDesktopIcons\\NewStartPanel";

export type QuickToggleId = "hide-spotlight-icon" | "block-auto-update";

export interface QuickToggleState {
  id: QuickToggleId;
  enabled: boolean;
}

function run(file: string, args: string[], timeout = 10_000): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout }, (error, stdout) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolve({ code, stdout: stdout ?? "" });
    });
  });
}

async function readSpotlightHidden(): Promise<boolean> {
  const { code, stdout } = await run("reg.exe", ["query", HIDE_ICONS_KEY, "/v", SPOTLIGHT_CLSID]);
  if (code !== 0) return false;
  return /REG_DWORD\s+0x0*1\b/i.test(stdout);
}

/** Ask Explorer to redraw the desktop (SHChangeNotify SHCNE_ASSOCCHANGED). */
async function refreshDesktop(): Promise<void> {
  const script =
    "Add-Type -Namespace W -Name S -MemberDefinition '[DllImport(\"shell32.dll\")] public static extern void SHChangeNotify(int e,int f,System.IntPtr a,System.IntPtr b);';" +
    "[W.S]::SHChangeNotify(0x8000000,0,[System.IntPtr]::Zero,[System.IntPtr]::Zero)";
  await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script]);
}

export async function listQuickToggles(): Promise<QuickToggleState[]> {
  if (process.platform !== "win32") return [];
  const [spotlight, updates] = await Promise.all([readSpotlightHidden(), readAutoUpdateBlocked()]);
  return [
    { id: "hide-spotlight-icon", enabled: spotlight },
    { id: "block-auto-update", enabled: updates },
  ];
}

const AU_POLICY_KEY = "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate\\AU";
const UAC_CANCELLED = 1223;

async function readAutoUpdateBlocked(): Promise<boolean> {
  const { code, stdout } = await run("reg.exe", ["query", AU_POLICY_KEY, "/v", "NoAutoUpdate"]);
  if (code !== 0) return false;
  return /REG_DWORD\s+0x0*1\b/i.test(stdout);
}

/** Run reg.exe elevated through a UAC prompt; returns its exit code (1223 if the prompt was declined). */
async function runElevatedReg(args: string): Promise<number> {
  const quoted = args.replace(/'/g, "''");
  const script =
    "$ErrorActionPreference='Stop';" +
    `try { $p = Start-Process -FilePath reg.exe -ArgumentList '${quoted}' -Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode }` +
    ` catch { exit ${UAC_CANCELLED} }`;
  // UAC prompt waits for the user, so allow up to two minutes.
  const { code } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], 120_000);
  return code;
}

async function setAutoUpdateBlocked(on: boolean): Promise<boolean> {
  const code = await runElevatedReg(
    on
      ? `add "${AU_POLICY_KEY}" /v NoAutoUpdate /t REG_DWORD /d 1 /f`
      : `delete "${AU_POLICY_KEY}" /v NoAutoUpdate /f`,
  );
  const state = await readAutoUpdateBlocked();
  if (state !== on) throw new Error(code === UAC_CANCELLED ? "已取消管理员授权" : "修改更新策略失败");
  return state;
}

export async function setQuickToggle(id: unknown, enabled: unknown): Promise<QuickToggleState> {
  if (process.platform !== "win32") throw new Error("仅支持 Windows");
  const on = enabled === true;
  if (id === "block-auto-update") return { id, enabled: await setAutoUpdateBlocked(on) };
  if (id !== "hide-spotlight-icon") throw new Error("未知的快捷开关");
  const result = on
    ? await run("reg.exe", ["add", HIDE_ICONS_KEY, "/v", SPOTLIGHT_CLSID, "/t", "REG_DWORD", "/d", "1", "/f"])
    : await run("reg.exe", ["delete", HIDE_ICONS_KEY, "/v", SPOTLIGHT_CLSID, "/f"]);
  // Deleting a value that does not exist is fine: the icon is already shown.
  if (result.code !== 0 && on) throw new Error("写入注册表失败");
  await refreshDesktop();
  return { id, enabled: await readSpotlightHidden() };
}
