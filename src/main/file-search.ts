import { execFile, spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { diagLog } from "./diag-log";

const log = (message: string): void => diagLog("everything", message);

export type FileSearchStatus = "ok" | "indexing" | "error" | "fallback";
export type FileSearchProvider = "system" | "portable" | "fallback";
export type FileSearchPhase = "starting" | "indexing";

export interface FileSearchProgress {
  phase: FileSearchPhase;
  elapsedMs: number;
}

export interface FileSearchResult {
  paths: string[];
  status: FileSearchStatus;
  message?: string;
  provider?: FileSearchProvider;
  progress?: FileSearchProgress;
  total?: number;
  nextOffset?: number;
  hasMore?: boolean;
}

interface HelperResult {
  ok?: boolean;
  indexing?: boolean;
  ipc?: boolean;
  results?: Array<{ path?: unknown }>;
  offset?: unknown;
  count?: unknown;
  total?: unknown;
  error?: unknown;
  code?: unknown;
}

// Starting a provider is only meaningful occasionally; guard repeated spawns
// but allow a retry after a long interval if the user keeps searching.
const RESTART_INTERVAL_MS = 5 * 60 * 1000;
export const FILE_SEARCH_PAGE_SIZE = 100;

/**
 * Full-disk file search backed by the native Everything helper. Prefers an
 * installed Everything, falls back to a bundled portable Everything, and finally
 * to a bounded common-folder index. Building the very first index can take
 * several minutes; during that time queries report an "indexing" status and the
 * renderer polls until results are available.
 */
export class FileSearch {
  private fallbackIndex: string[] | null = null;
  private fallbackDirty = true;
  private providerStarted = false;
  private providerStartedAt = 0;
  private startedProvider: FileSearchProvider | null = null;
  private indexingObservedAt = 0;
  private installedLookup: Promise<string | null> | null = null;
  private installedPath: string | null = null;

  constructor(
    private readonly helperPath: string,
    private readonly portablePath: string,
    private readonly configPath: string,
    private readonly dbPath: string,
    private readonly getFallbackRoots: () => string[],
  ) {}

  /** Invalidate the cached fallback index so the next query rebuilds it. */
  invalidate(): void {
    this.fallbackDirty = true;
    this.fallbackIndex = null;
  }

  /**
   * Start the preferred Everything provider ahead of the first query so the
   * initial file search does not pay the spawn/index latency. Best-effort and
   * non-blocking: any failure is swallowed and the normal lazy start still
   * applies on the first query.
   */
  async warmUp(): Promise<void> {
    try {
      // An Everything instance that is already running (e.g. the user's own
      // installation in the tray) is reused as-is; never start a second one.
      if (await this.isEverythingRunning()) return;
      await this.startProvider("warmUp");
    } catch (error) {
      log(`warmUp failed: ${(error as Error).message}`);
      // Ignore: the first query will retry via the normal path.
    }
  }

  private async isEverythingRunning(): Promise<boolean> {
    const status = await this.runHelper("--status");
    log(
      `status=${JSON.stringify(status)} installed=${this.installedPath ?? "unknown/none"} ` +
        `portable=${existsSync(this.portablePath) ? this.portablePath : "missing"}`,
    );
    return status?.ipc === true;
  }

  static resolveExecutable(isPackaged: boolean, resourcesPath: string): string {
    return isPackaged
      ? path.join(resourcesPath, "native", "everything-search.exe")
      : path.join(process.cwd(), "native", "bin", "everything-search.exe");
  }

  static resolvePortable(isPackaged: boolean, resourcesPath: string): string {
    return isPackaged
      ? path.join(resourcesPath, "native", "Everything.exe")
      : path.join(process.cwd(), "native", "portable", "Everything.exe");
  }

  /**
   * Locate an installed Everything executable, if any. Checks the common install
   * folders first, then the paths recorded in the registry uninstall entries so
   * installs in custom locations (other drives, custom folders) are found too.
   * The result is cached for the lifetime of the process.
   */
  private installedEverything(): Promise<string | null> {
    // Developer/test hook: exercise the bundled portable path even on a machine
    // with Everything installed.
    if (process.env.DOCKWISP_FORCE_PORTABLE === "1" || process.env.OPENDOCK_FORCE_PORTABLE === "1")
      return Promise.resolve(null);
    this.installedLookup ??= this.locateInstalledEverything().then((found) => {
      this.installedPath = found;
      log(`installed Everything lookup: ${found ?? "none"}`);
      return found;
    });
    return this.installedLookup;
  }

  private async locateInstalledEverything(): Promise<string | null> {
    const directories = [
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Everything"),
      process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "Everything"),
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "Everything"),
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Everything 1.5a"),
    ].filter((item): item is string => typeof item === "string");
    const direct = findEverythingExecutable(directories);
    if (direct) return direct;
    return findEverythingExecutable(await registryEverythingDirectories());
  }

  /** The provider we would use: installed system Everything, else portable. */
  private preferredProvider(): FileSearchProvider {
    return this.installedPath ? "system" : "portable";
  }

  /** Run a file query and report results plus a status for the renderer. */
  async query(
    queryText: string,
    offset = 0,
    limit = FILE_SEARCH_PAGE_SIZE,
  ): Promise<FileSearchResult> {
    const query = queryText.trim();
    if (!query) return { paths: [], status: "ok", provider: this.startedProvider ?? undefined };
    const pageOffset = Number.isFinite(offset) ? Math.max(0, Math.trunc(offset)) : 0;
    const pageLimit = Number.isFinite(limit)
      ? Math.max(1, Math.min(500, Math.trunc(limit)))
      : FILE_SEARCH_PAGE_SIZE;

    const helper = await this.queryHelper(query, pageOffset, pageLimit);

    // Helper missing or produced unparseable output: do not spin on "indexing"
    // forever. Fall back to the bounded common-folder index.
    if (helper === null) {
      this.clearIndexingProgress();
      return {
        ...this.queryFallbackPage(query, pageOffset, pageLimit),
        status: "fallback",
        provider: "fallback",
      };
    }

    // IPC unavailable: Everything is not running. Try to start a provider.
    if (helper.ipc === false) {
      if (!this.providerStarted) {
        log(`query found no Everything IPC: ${JSON.stringify(helper)}`);
        if (await this.startProvider("query")) {
          return this.indexingResult("starting");
        }
        this.clearIndexingProgress();
        return {
          ...this.queryFallbackPage(query, pageOffset, pageLimit),
          status: "fallback",
          provider: "fallback",
        };
      }
      // If the provider never opened its IPC window (UAC dismissed, exe failed),
      // stop pretending it is still indexing and surface the fallback.
      if (Date.now() - this.providerStartedAt > 60_000) {
        this.clearIndexingProgress();
        return {
          ...this.queryFallbackPage(query, pageOffset, pageLimit),
          status: "fallback",
          provider: "fallback",
        };
      }
      // Already started once and still no IPC window: keep polling.
      return this.indexingResult("starting");
    }

    // Database still loading (first index can take minutes).
    if (helper.indexing === true) {
      return this.indexingResult("indexing");
    }

    // Success.
    if (helper.ok && Array.isArray(helper.results)) {
      this.clearIndexingProgress();
      const paths = helper.results
        .map((item) => item.path)
        .filter((item): item is string => typeof item === "string");
      const returned =
        typeof helper.count === "number" && Number.isFinite(helper.count)
          ? Math.max(0, Math.trunc(helper.count))
          : helper.results.length;
      const total =
        typeof helper.total === "number" && Number.isFinite(helper.total)
          ? Math.max(0, Math.trunc(helper.total))
          : pageOffset + returned;
      const nextOffset = pageOffset + returned;
      return {
        paths,
        status: "ok",
        provider: this.startedProvider ?? this.preferredProvider(),
        total,
        nextOffset,
        hasMore: returned > 0 && nextOffset < total,
      };
    }

    // Query failed after the DB was loaded (not IPC, not indexing): report an
    // error rather than polling forever.
    const code = typeof helper.code === "number" ? helper.code : helper.error;
    this.clearIndexingProgress();
    return {
      paths: [],
      status: "error",
      message: `文件搜索查询失败（代码 ${String(code ?? "unknown")}）`,
    };
  }

  private indexingResult(phase: FileSearchPhase): FileSearchResult {
    const now = Date.now();
    if (!this.indexingObservedAt) this.indexingObservedAt = now;
    return {
      paths: [],
      status: "indexing",
      provider: this.startedProvider ?? this.preferredProvider(),
      progress: {
        phase,
        elapsedMs: Math.max(0, now - this.indexingObservedAt),
      },
    };
  }

  private clearIndexingProgress(): void {
    this.indexingObservedAt = 0;
  }

  /**
   * Start the preferred Everything provider in the background. Returns false when
   * no provider could be started (e.g. portable exe missing), so the caller can
   * fall back to the bounded index.
   */
  private async startProvider(reason: string): Promise<boolean> {
    const now = Date.now();
    if (this.providerStarted && now - this.providerStartedAt < RESTART_INTERVAL_MS) {
      // Already started recently; treat as in-progress so the caller polls.
      return true;
    }

    const installed = await this.installedEverything();
    const executable = installed ?? this.portablePath;
    const provider: FileSearchProvider = installed ? "system" : "portable";

    if (!existsSync(executable)) {
      log(`startProvider(${reason}) skipped: ${executable} missing`);
      return false;
    }

    const args = installed
      ? ["-minimized", "-startup"]
      : ["-config", this.configPath, "-db", this.dbPath, "-minimized", "-startup"];

    log(`startProvider(${reason}) spawn ${provider}: "${executable}" ${args.join(" ")}`);
    try {
      const child = spawn(executable, args, {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.on("error", (error) => log(`startProvider spawn error: ${error.message}`));
      child.unref();
    } catch (error) {
      log(`startProvider spawn threw: ${(error as Error).message}`);
      return false;
    }

    this.providerStarted = true;
    this.providerStartedAt = now;
    this.startedProvider = provider;
    return true;
  }

  /**
   * Ask the bundled portable Everything to exit so an installer can replace its
   * executable. A system-installed Everything is never touched.
   */
  async stopPortable(timeoutMs = 4_000): Promise<void> {
    // "-exit" targets whichever Everything instance is running, so only send it
    // when no system Everything exists (then the running one must be ours).
    const installed = await this.installedEverything();
    if (!existsSync(this.portablePath) || installed) {
      log(
        `stopPortable skipped: portable=${existsSync(this.portablePath) ? "present" : "missing"} ` +
          `installed=${installed ?? "none"}`,
      );
      return;
    }
    log(`stopPortable: "${this.portablePath}" -config "${this.configPath}" -exit`);
    await new Promise<void>((resolve) => {
      try {
        const child = spawn(this.portablePath, ["-config", this.configPath, "-exit"], {
          stdio: "ignore",
          windowsHide: true,
        });
        const timer = setTimeout(() => {
          log("stopPortable timed out; killing -exit process");
          child.kill();
          resolve();
        }, timeoutMs);
        const done = (detail: string) => {
          clearTimeout(timer);
          log(`stopPortable finished: ${detail}`);
          resolve();
        };
        child.on("error", (error) => done(`error ${error.message}`));
        child.on("close", (code) => done(`exit ${code}`));
      } catch (error) {
        log(`stopPortable threw: ${(error as Error).message}`);
        resolve();
      }
    });
    this.providerStarted = false;
  }

  private queryHelper(query: string, offset: number, limit: number): Promise<HelperResult | null> {
    return this.runHelper(query, [String(offset), String(limit)]);
  }

  private runHelper(argument: string, extraArguments: string[] = []): Promise<HelperResult | null> {
    if (!existsSync(this.helperPath)) return Promise.resolve(null);
    return new Promise((resolve) => {
      execFile(
        this.helperPath,
        [argument, ...extraArguments],
        { windowsHide: true, timeout: 5_000, maxBuffer: 8 * 1024 * 1024 },
        (error, stdout) => {
          // The helper exits non-zero for indexing/IPC states but still prints
          // JSON on stdout, so parse stdout regardless of the exit code.
          const text = stdout?.trim();
          if (!text) {
            resolve(null);
            return;
          }
          try {
            resolve(JSON.parse(text) as HelperResult);
          } catch {
            resolve(null);
          }
        },
      );
    });
  }

  private queryFallback(query: string): string[] {
    const index = this.ensureFallbackIndex();
    const lower = query.toLowerCase();
    return index.filter((filePath) => path.basename(filePath).toLowerCase().includes(lower));
  }

  private queryFallbackPage(
    query: string,
    offset: number,
    limit: number,
  ): Pick<FileSearchResult, "paths" | "total" | "nextOffset" | "hasMore"> {
    const matches = this.queryFallback(query);
    const paths = matches.slice(offset, offset + limit);
    const nextOffset = offset + paths.length;
    return {
      paths,
      total: matches.length,
      nextOffset,
      hasMore: nextOffset < matches.length,
    };
  }

  private ensureFallbackIndex(): string[] {
    if (this.fallbackIndex && !this.fallbackDirty) return this.fallbackIndex;
    const result: string[] = [];
    const seen = new Set<string>();
    for (const root of this.getFallbackRoots()) {
      this.scanFallback(root, result, seen, 0);
      if (result.length >= 20_000) break;
    }
    this.fallbackIndex = result;
    this.fallbackDirty = false;
    return result;
  }

  private scanFallback(
    directory: string,
    result: string[],
    seen: Set<string>,
    depth: number,
  ): void {
    if (depth > 5 || result.length >= 20_000 || !existsSync(directory)) return;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (result.length >= 20_000) return;
      const name = entry.name;
      if (name.startsWith(".")) continue;
      if (SKIP_DIRECTORIES.has(name.toLowerCase())) continue;
      const fullPath = path.join(directory, name);
      if (entry.isDirectory()) {
        this.scanFallback(fullPath, result, seen, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (SKIP_EXTENSIONS.has(path.extname(name).toLowerCase())) continue;
      const key = fullPath.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(fullPath);
    }
  }
}

const SKIP_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  "appdata",
  "temp",
  "windows",
  "winsxs",
  "__pycache__",
]);

const SKIP_EXTENSIONS = new Set([".pf", ".pyc"]);

const EVERYTHING_EXECUTABLES = ["Everything.exe", "Everything64.exe"];

/** Return the first Everything executable found in the given directories. */
export function findEverythingExecutable(directories: string[]): string | null {
  for (const directory of directories) {
    for (const name of EVERYTHING_EXECUTABLES) {
      const candidate = path.join(directory, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

const UNINSTALL_KEYS = [
  "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
];

/** Install directories of Everything recorded in the registry uninstall entries. */
async function registryEverythingDirectories(): Promise<string[]> {
  if (process.platform !== "win32") return [];
  const outputs = await Promise.all(
    UNINSTALL_KEYS.map(
      (key) =>
        new Promise<string>((resolve) => {
          execFile(
            "reg.exe",
            ["query", key, "/s"],
            { windowsHide: true, timeout: 5_000, maxBuffer: 32 * 1024 * 1024 },
            (_error, stdout) => resolve(stdout ?? ""),
          );
        }),
    ),
  );
  const directories: string[] = [];
  for (const output of outputs) directories.push(...parseEverythingUninstallEntries(output));
  return [...new Set(directories)];
}

/**
 * Extract Everything install directories from `reg query /s` output. Only
 * entries whose DisplayName starts with "Everything" are considered, and both
 * InstallLocation and the DisplayIcon/UninstallString directories are used.
 */
export function parseEverythingUninstallEntries(output: string): string[] {
  const directories: string[] = [];
  for (const block of output.split(/\r?\n\s*\r?\n/)) {
    const values = new Map<string, string>();
    for (const line of block.split(/\r?\n/)) {
      const match = /^\s+(\S+)\s+REG_(?:EXPAND_)?SZ\s+(.*)$/.exec(line);
      if (match) values.set(match[1].toLowerCase(), match[2].trim());
    }
    const name = values.get("displayname");
    if (!name || !/^everything\b/i.test(name)) continue;
    const location = values.get("installlocation");
    if (location) directories.push(stripQuotes(location));
    for (const key of ["displayicon", "uninstallstring"]) {
      const value = values.get(key);
      const executable = value && extractExecutablePath(value);
      if (executable) directories.push(path.win32.dirname(executable));
    }
  }
  return directories.filter((item) => item.length > 0);
}

function stripQuotes(value: string): string {
  return value.replace(/^"+|"+$/g, "").replace(/[\\/]+$/, "");
}

function extractExecutablePath(value: string): string | null {
  const quoted = /^"([^"]+\.exe)"/i.exec(value.trim());
  if (quoted) return quoted[1];
  const bare = /^(.+?\.exe)\b/i.exec(value.trim());
  return bare ? bare[1] : null;
}
