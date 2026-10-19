import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  nativeImage,
  Notification,
  screen,
  shell,
} from "electron";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { LoadedPlugin, RawFeature, SearchInput } from "../core/types";
import { MouseHelper } from "./mouse-helper";
import { PluginRegistry } from "./plugin-registry";
import { PluginStore } from "./plugin-store";

interface PluginEnterPayload {
  code: string;
  type: string;
  payload: unknown;
}

interface ApiResponse {
  ok: boolean;
  value?: unknown;
  error?: string;
}

function encodeArgument(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function inputPayload(input: SearchInput): unknown {
  return input.data;
}

export class PluginHost {
  private readonly windows = new Map<string, BrowserWindow>();
  private readonly webContentsPlugins = new Map<number, string>();
  private readonly stores = new Map<string, PluginStore>();
  private readonly pendingPayloads = new Map<string, PluginEnterPayload>();
  private readonly childWindows = new Map<number, BrowserWindow>();

  constructor(
    private readonly registry: PluginRegistry,
    private readonly launcher: BrowserWindow,
    private readonly helper: MouseHelper,
  ) {
    this.registerIpc();
  }

  open(
    pluginId: string,
    featureCode: string,
    commandType: string,
    input: SearchInput,
    mainHide: boolean,
  ): void {
    const plugin = this.registry.get(pluginId);
    if (!plugin) throw new Error(`插件不存在: ${pluginId}`);
    const payload = { code: featureCode, type: commandType, payload: inputPayload(input) };
    this.pendingPayloads.set(pluginId, payload);
    let window = this.windows.get(pluginId);
    if (window && !window.isDestroyed()) {
      window.webContents.send("compat:plugin-enter", payload);
      if (!mainHide) {
        window.show();
        window.focus();
      }
      return;
    }
    window = this.createWindow(plugin, mainHide);
    this.windows.set(pluginId, window);
  }

  private createWindow(plugin: LoadedPlugin, mainHide: boolean): BrowserWindow {
    const window = new BrowserWindow({
      width: 900,
      height: 680,
      show: false,
      title: plugin.manifest.pluginName,
      webPreferences: {
        preload: path.join(__dirname, "..", "preload", "plugin.js"),
        contextIsolation: false,
        nodeIntegration: false,
        sandbox: false,
        additionalArguments: [
          `--compat-plugin-id=${encodeArgument(plugin.id)}`,
          `--compat-plugin-dir=${encodeArgument(plugin.directory)}`,
          `--compat-plugin-preload=${encodeArgument(plugin.preloadPath ?? "")}`,
        ],
      },
    });
    this.webContentsPlugins.set(window.webContents.id, plugin.id);
    window.once("ready-to-show", () => {
      if (!mainHide) window.show();
    });
    window.on("closed", () => {
      this.windows.delete(plugin.id);
      this.webContentsPlugins.delete(window.webContents.id);
      this.pendingPayloads.delete(plugin.id);
    });
    window.webContents.on("will-navigate", (event, url) => {
      if (url === pathToFileURL(plugin.mainPath).toString()) return;
      event.preventDefault();
      if (/^https?:/i.test(url)) void shell.openExternal(url);
    });
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) void shell.openExternal(url);
      return { action: "deny" };
    });
    void window.loadURL(pathToFileURL(plugin.mainPath).toString());
    return window;
  }

  private registerIpc(): void {
    ipcMain.on("compat:ready", (event) => {
      const pluginId = this.webContentsPlugins.get(event.sender.id);
      if (!pluginId) return;
      const payload = this.pendingPayloads.get(pluginId);
      if (payload) event.sender.send("compat:plugin-enter", payload);
    });
    ipcMain.on("compat:api-sync", (event, operation: string, argument: unknown) => {
      event.returnValue = this.wrap(() =>
        this.dispatchSync(event.sender.id, operation, argument),
      );
    });
    ipcMain.handle("compat:api", async (event, operation: string, argument: unknown) =>
      this.wrapAsync(() => this.dispatchAsync(event.sender.id, operation, argument)),
    );
  }

  private pluginFor(webContentsId: number): string {
    const pluginId = this.webContentsPlugins.get(webContentsId);
    if (!pluginId) throw new Error("未识别的插件窗口");
    return pluginId;
  }

  private store(pluginId: string): PluginStore {
    let store = this.stores.get(pluginId);
    if (!store) {
      store = new PluginStore(path.join(app.getPath("userData"), "plugin-data"), pluginId);
      this.stores.set(pluginId, store);
    }
    return store;
  }

  private dispatchSync(webContentsId: number, operation: string, argument: unknown): unknown {
    const pluginId = this.pluginFor(webContentsId);
    const args = Array.isArray(argument) ? argument : [argument];
    const store = this.store(pluginId);
    switch (operation) {
      case "hideMainWindow":
        this.launcher.hide();
        return true;
      case "showMainWindow":
        this.launcher.show();
        return true;
      case "outPlugin":
        this.windows.get(pluginId)?.hide();
        return true;
      case "getAppName":
        return app.getName();
      case "getAppVersion":
        return app.getVersion();
      case "getPath":
        return app.getPath(String(args[0]) as Parameters<typeof app.getPath>[0]);
      case "getPluginLocalDataPath": {
        const directory = path.join(app.getPath("userData"), "plugin-files", pluginId);
        mkdirSync(directory, { recursive: true });
        return directory;
      }
      case "getPluginTempPath": {
        const directory = path.join(app.getPath("temp"), "dockwisp", pluginId);
        mkdirSync(directory, { recursive: true });
        return directory;
      }
      case "getFileIcon":
        return nativeImage.createFromPath(String(args[0])).toDataURL();
      case "copyText":
        clipboard.writeText(String(args[0] ?? ""));
        return true;
      case "copyImage":
        clipboard.writeImage(nativeImage.createFromPath(String(args[0])));
        return true;
      case "getCopiedFiles":
        return null;
      case "showNotification":
        new Notification({ body: String((args[0] as { body?: unknown })?.body ?? args[0]) }).show();
        return true;
      case "showOpenDialog": {
        const options = (args[0] ?? {}) as Electron.OpenDialogSyncOptions;
        const parent = this.windows.get(pluginId);
        return parent
          ? dialog.showOpenDialogSync(parent, options)
          : dialog.showOpenDialogSync(options);
      }
      case "showSaveDialog": {
        const options = (args[0] ?? {}) as Electron.SaveDialogSyncOptions;
        const parent = this.windows.get(pluginId);
        return parent
          ? dialog.showSaveDialogSync(parent, options)
          : dialog.showSaveDialogSync(options);
      }
      case "shellShowItemInFolder":
        shell.showItemInFolder(String(args[0]));
        return true;
      case "shellBeep":
        shell.beep();
        return true;
      case "getCursorScreenPoint":
        return screen.getCursorScreenPoint();
      case "getPrimaryDisplay":
        return screen.getPrimaryDisplay();
      case "getAllDisplays":
        return screen.getAllDisplays();
      case "getDisplayNearestPoint":
        return screen.getDisplayNearestPoint(args[0] as Electron.Point);
      case "getDisplayMatching":
        return screen.getDisplayMatching(args[0] as Electron.Rectangle);
      case "setFeature":
        return this.registry.setFeature(pluginId, args[0] as RawFeature);
      case "removeFeature":
        return this.registry.removeFeature(pluginId, String(args[0]));
      case "getFeatures":
        return this.registry.getFeatures(pluginId);
      case "dbStorageSetItem":
        store.setItem(String((args[0] as { key: unknown }).key), (args[0] as { value: unknown }).value);
        return undefined;
      case "dbStorageGetItem":
        return store.getItem(String(args[0]));
      case "dbStorageRemoveItem":
        store.removeItem(String(args[0]));
        return undefined;
      case "dbPut":
        return store.put(args[0] as Record<string, unknown>);
      case "dbGet":
        return store.get(String(args[0]));
      case "dbRemove":
        return store.remove(args[0] as string | Record<string, unknown>);
      case "dbBulkDocs":
        return store.bulkDocs(args[0] as Record<string, unknown>[]);
      case "dbAllDocs":
        return store.allDocs((args[0] ?? {}) as { include_docs?: boolean });
      case "createBrowserWindow":
        return this.createChildWindow(pluginId, args[0] as { url?: string; options?: Electron.BrowserWindowConstructorOptions });
      case "pluginBrowserWindowMethod":
        return this.callChildWindow(args[0] as Record<string, unknown>);
      default:
        throw new Error(`API 暂未兼容: ${operation}`);
    }
  }

  private async dispatchAsync(
    webContentsId: number,
    operation: string,
    argument: unknown,
  ): Promise<unknown> {
    const pluginId = this.pluginFor(webContentsId);
    const args = Array.isArray(argument) ? argument : [argument];
    switch (operation) {
      case "shellOpenPath":
      case "shellOpenItem":
        return shell.openPath(String(args[0]));
      case "shellTrashItem":
        return shell.trashItem(String(args[0]));
      case "shellOpenExternal":
        await shell.openExternal(String(args[0]));
        return true;
      case "getFileIconAsync":
        return (await app.getFileIcon(String(args[0]))).toDataURL();
      case "dbPromisePut":
        return this.store(pluginId).put(args[0] as Record<string, unknown>);
      case "dbPromiseGet":
        return this.store(pluginId).get(String(args[0]));
      case "dbPromiseRemove":
        return this.store(pluginId).remove(args[0] as string | Record<string, unknown>);
      case "dbPromiseBulkDocs":
        return this.store(pluginId).bulkDocs(args[0] as Record<string, unknown>[]);
      case "dbPromiseAllDocs":
        return this.store(pluginId).allDocs((args[0] ?? {}) as { include_docs?: boolean });
      case "hideMainWindowPasteText":
        this.launcher.hide();
        clipboard.writeText(String(args[0] ?? ""));
        await this.helper.paste();
        return true;
      default:
        throw new Error(`异步 API 暂未兼容: ${operation}`);
    }
  }

  private createChildWindow(
    pluginId: string,
    request: { url?: string; options?: Electron.BrowserWindowConstructorOptions },
  ): unknown {
    const parent = this.windows.get(pluginId);
    const options = request.options ?? {};
    const child = new BrowserWindow({
      parent,
      width: typeof options.width === "number" ? options.width : 800,
      height: typeof options.height === "number" ? options.height : 600,
      show: options.show !== false,
      frame: options.frame !== false,
      alwaysOnTop: options.alwaysOnTop === true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    this.childWindows.set(child.id, child);
    child.on("closed", () => this.childWindows.delete(child.id));
    if (request.url) void child.loadURL(request.url);
    return {
      id: child.id,
      methods: ["show", "hide", "close", "focus", "setAlwaysOnTop"],
      invokes: [],
      webContents: { methods: ["send", "openDevTools"], invokes: [] },
    };
  }

  private callChildWindow(request: Record<string, unknown>): unknown {
    const child = this.childWindows.get(Number(request.id));
    if (!child) throw new Error("子窗口不存在");
    const target = request.target === "webContents" ? child.webContents : child;
    const method = String(request.method);
    const allowed =
      request.target === "webContents"
        ? new Set(["send", "openDevTools"])
        : new Set(["show", "hide", "close", "focus", "setAlwaysOnTop"]);
    if (!allowed.has(method)) throw new Error(`不允许的子窗口方法: ${method}`);
    const callable = (target as unknown as Record<string, unknown>)[method];
    if (typeof callable !== "function") throw new Error(`子窗口方法不可用: ${method}`);
    return callable.apply(target, (request.args as unknown[]) ?? []);
  }

  private wrap(operation: () => unknown): ApiResponse {
    try {
      return { ok: true, value: operation() };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async wrapAsync(operation: () => Promise<unknown>): Promise<ApiResponse> {
    try {
      return { ok: true, value: await operation() };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}
