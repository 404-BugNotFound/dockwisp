import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import path from "node:path";
import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import readline from "node:readline";

export interface MiddleMouseEvent {
  type: "mouse";
  button: "middle";
  action: "down" | "up";
  x: number;
  y: number;
  time: number;
  process?: string;
  title?: string;
}

interface HelperResponse {
  type: "response";
  id: string;
  ok: boolean;
  sequence?: number;
  text?: string;
  error?: string;
  windows?: WindowInfo[];
}

export interface WindowInfo {
  hwnd: string;
  title: string;
  pid: number;
  process: string;
}

interface HotkeyEvent {
  type: "hotkey";
  name: "launcher";
}

export class MouseHelper extends EventEmitter {
  private process: ChildProcessWithoutNullStreams | null = null;
  private ready = false;
  private nextId = 1;
  private pending = new Map<
    string,
    { resolve: (response: HelperResponse) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();

  constructor(private readonly executablePath: string) {
    super();
  }

  start(): boolean {
    if (process.platform !== "win32" || !existsSync(this.executablePath)) return false;
    this.process = spawn(this.executablePath, [], { windowsHide: true, stdio: "pipe" });
    const lines = readline.createInterface({ input: this.process.stdout });
    lines.on("line", (line) => this.handleLine(line));
    this.process.stderr.on("data", (data) => this.emit("diagnostic", String(data)));
    this.process.on("exit", (code) => {
      this.process = null;
      this.ready = false;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`mouse helper exited (${code ?? "unknown"})`));
      }
      this.pending.clear();
      this.emit("exit", code);
    });
    return true;
  }

  async getClipboardSequence(): Promise<number> {
    const response = await this.request("seq");
    return response.sequence ?? 0;
  }

  async copySelection(): Promise<void> {
    const response = await this.request("copy");
    if (!response.ok) throw new Error(response.error ?? "copy simulation failed");
  }

  async copySelectionAlternate(): Promise<void> {
    const response = await this.request("copyinsert");
    if (!response.ok) throw new Error(response.error ?? "alternate copy simulation failed");
  }

  async readSelectedText(): Promise<string> {
    const response = await this.request("selection", [], 3_000);
    if (!response.ok) return "";
    return response.text ?? "";
  }

  async paste(): Promise<void> {
    const response = await this.request("paste");
    if (!response.ok) throw new Error(response.error ?? "paste simulation failed");
  }

  async setAltSpaceEnabled(enabled: boolean): Promise<void> {
    const response = await this.request("hotkey", [enabled ? "1" : "0"]);
    if (!response.ok) throw new Error(response.error ?? "hotkey configuration failed");
  }

  async focusWindow(handle: bigint | number): Promise<boolean> {
    const response = await this.request("focus", [String(handle)], 1_000);
    return response.ok;
  }

  async listWindows(): Promise<WindowInfo[]> {
    const response = await this.request("windows", [], 3_000);
    return response.ok && Array.isArray(response.windows) ? response.windows : [];
  }

  async media(action: "mute" | "up" | "down"): Promise<void> {
    const response = await this.request("media", [action]);
    if (!response.ok) throw new Error(response.error ?? "media key simulation failed");
  }

  async prepareWindow(handle: bigint | number): Promise<boolean> {
    const response = await this.request("prepare", [String(handle)], 1_000);
    return response.ok;
  }

  waitUntilReady(timeoutMs = 2_000): Promise<boolean> {
    if (this.ready) return Promise.resolve(true);
    if (!this.process) return Promise.resolve(false);
    return new Promise((resolve) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.off("ready", onReady);
        this.off("exit", onExit);
      };
      const onReady = () => {
        cleanup();
        resolve(true);
      };
      const onExit = () => {
        cleanup();
        resolve(false);
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve(false);
      }, timeoutMs);
      this.once("ready", onReady);
      this.once("exit", onExit);
    });
  }

  stop(): void {
    const child = this.process;
    if (!child) return;
    child.stdin.write("quit 0\n");
    const timer = setTimeout(() => {
      if (!child.killed) child.kill();
    }, 500);
    timer.unref();
  }

  static resolveExecutable(isPackaged: boolean, resourcesPath: string): string {
    return isPackaged
      ? path.join(resourcesPath, "native", "mouse-hook.exe")
      : path.join(process.cwd(), "native", "bin", "mouse-hook.exe");
  }

  private request(
    command: string,
    args: string[] = [],
    timeoutMs = 2_000,
  ): Promise<HelperResponse> {
    if (!this.process) return Promise.reject(new Error("mouse helper is not running"));
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`mouse helper ${command} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.process?.stdin.write(`${command} ${id}${args.length ? ` ${args.join(" ")}` : ""}\n`);
    });
  }

  private handleLine(line: string): void {
    try {
      const message = JSON.parse(line) as
        | MiddleMouseEvent
        | HotkeyEvent
        | HelperResponse
        | { type: string; error?: string };
      if (message.type === "ready") {
        this.ready = true;
        this.emit("ready");
        return;
      }
      if (message.type === "mouse") {
        this.emit("mouse", message as MiddleMouseEvent);
        return;
      }
      if (message.type === "hotkey") {
        this.emit("hotkey", message as HotkeyEvent);
        return;
      }
      if (message.type === "response") {
        const response = message as HelperResponse;
        const pending = this.pending.get(response.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(response.id);
        pending.resolve(response);
        return;
      }
      this.emit(message.type, message);
    } catch {
      this.emit("diagnostic", `invalid helper output: ${line}`);
    }
  }
}
