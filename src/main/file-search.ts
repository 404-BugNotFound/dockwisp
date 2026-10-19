import { execFile, spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

export type FileSearchStatus = "ok" | "indexing" | "error" | "fallback";
export type FileSearchProvider = "system" | "portable" | "fallback";

export interface FileSearchResult {
  paths: string[];
  status: FileSearchStatus;
  message?: string;
  provider?: FileSearchProvider;
}

interface HelperResult {
  ok?: boolean;
  indexing?: boolean;
  ipc?: boolean;
  results?: Array<{ path?: unknown }>;
  error?: unknown;
  code?: unknown;
}

// Starting a provider is only meaningful occasionally; guard repeated spawns
// but allow a retry after a long interval if the user keeps searching.
const RESTART_INTERVAL_MS = 5 * 60 * 1000;

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

  /** Locate an installed Everything executable, if any. */
  private installedEverything(): string | null {
    // Developer/test hook: exercise the bundled portable path even on a machine
    // with Everything installed.
    if (process.env.DOCKWISP_FORCE_PORTABLE === "1" || process.env.OPENDOCK_FORCE_PORTABLE === "1")
      return null;
    const candidates = [
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Everything", "Everything.exe"),
      process.env["ProgramFiles(x86)"] &&
        path.join(process.env["ProgramFiles(x86)"], "Everything", "Everything.exe"),
      process.env.LOCALAPPDATA &&
        path.join(process.env.LOCALAPPDATA, "Programs", "Everything", "Everything.exe"),
    ].filter((item): item is string => typeof item === "string");
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }

  /** The provider we would use: installed system Everything, else portable. */
  private preferredProvider(): FileSearchProvider {
    return this.installedEverything() ? "system" : "portable";
  }

  /** Run a file query and report results plus a status for the renderer. */
  async query(queryText: string): Promise<FileSearchResult> {
    const query = queryText.trim();
    if (!query) return { paths: [], status: "ok", provider: this.startedProvider ?? undefined };

    const helper = await this.queryHelper(query);

    // Helper missing or produced unparseable output: do not spin on "indexing"
    // forever. Fall back to the bounded common-folder index.
    if (helper === null) {
      return {
        paths: this.queryFallback(query),
        status: "fallback",
        provider: "fallback",
      };
    }

    // IPC unavailable: Everything is not running. Try to start a provider.
    if (helper.ipc === false) {
      if (!this.providerStarted) {
        if (this.startProvider()) {
          return { paths: [], status: "indexing", provider: this.startedProvider ?? undefined };
        }
        return {
          paths: this.queryFallback(query),
          status: "fallback",
          provider: "fallback",
        };
      }
      // If the provider never opened its IPC window (UAC dismissed, exe failed),
      // stop pretending it is still indexing and surface the fallback.
      if (Date.now() - this.providerStartedAt > 60_000) {
        return {
          paths: this.queryFallback(query),
          status: "fallback",
          provider: "fallback",
        };
      }
      // Already started once and still no IPC window: keep polling.
      return { paths: [], status: "indexing", provider: this.startedProvider ?? undefined };
    }

    // Database still loading (first index can take minutes).
    if (helper.indexing === true) {
      return { paths: [], status: "indexing", provider: this.startedProvider ?? undefined };
    }

    // Success.
    if (helper.ok && Array.isArray(helper.results)) {
      const paths = helper.results
        .map((item) => item.path)
        .filter((item): item is string => typeof item === "string");
      return { paths, status: "ok", provider: this.startedProvider ?? this.preferredProvider() };
    }

    // Query failed after the DB was loaded (not IPC, not indexing): report an
    // error rather than polling forever.
    const code = typeof helper.code === "number" ? helper.code : helper.error;
    return {
      paths: [],
      status: "error",
      message: `文件搜索查询失败（代码 ${String(code ?? "unknown")}）`,
    };
  }

  /**
   * Start the preferred Everything provider in the background. Returns false when
   * no provider could be started (e.g. portable exe missing), so the caller can
   * fall back to the bounded index.
   */
  private startProvider(): boolean {
    const now = Date.now();
    if (this.providerStarted && now - this.providerStartedAt < RESTART_INTERVAL_MS) {
      // Already started recently; treat as in-progress so the caller polls.
      return true;
    }

    const installed = this.installedEverything();
    const executable = installed ?? this.portablePath;
    const provider: FileSearchProvider = installed ? "system" : "portable";

    if (!existsSync(executable)) return false;

    const args = installed
      ? ["-minimized", "-startup"]
      : ["-config", this.configPath, "-db", this.dbPath, "-minimized", "-startup"];

    try {
      const child = spawn(executable, args, {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();
    } catch {
      return false;
    }

    this.providerStarted = true;
    this.providerStartedAt = now;
    this.startedProvider = provider;
    return true;
  }

  private queryHelper(query: string): Promise<HelperResult | null> {
    if (!existsSync(this.helperPath)) return Promise.resolve(null);
    return new Promise((resolve) => {
      execFile(
        this.helperPath,
        [query],
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
