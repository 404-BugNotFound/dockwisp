import { ipcRenderer, webUtils } from "electron";

declare global {
  interface Window {
    utools: Record<string, unknown>;
  }
}

interface ApiResponse {
  ok: boolean;
  value?: unknown;
  error?: string;
}

function decodeArgument(name: string): string {
  const prefix = `--${name}=`;
  const argument = process.argv.find((item) => item.startsWith(prefix));
  if (!argument) return "";
  return Buffer.from(argument.slice(prefix.length), "base64url").toString("utf8");
}

const pluginId = decodeArgument("compat-plugin-id");
const pluginPreload = decodeArgument("compat-plugin-preload");
const events: Record<string, ((...args: unknown[]) => unknown) | undefined> = {};
let currentEnterPayload: unknown;

function unwrap(response: ApiResponse): unknown {
  if (!response?.ok) throw new Error(response?.error || "插件 API 调用失败");
  return response.value;
}

function sync(operation: string, ...args: unknown[]): unknown {
  return unwrap(ipcRenderer.sendSync("compat:api-sync", operation, args) as ApiResponse);
}

async function invoke(operation: string, ...args: unknown[]): Promise<unknown> {
  return unwrap((await ipcRenderer.invoke("compat:api", operation, args)) as ApiResponse);
}

function registerEvent(name: string, callback: unknown): void {
  events[name] = typeof callback === "function" ? (callback as (...args: unknown[]) => unknown) : undefined;
  if (name === "pluginEnter" && events[name] && currentEnterPayload) {
    events[name]?.(currentEnterPayload);
  }
}

function childWindowProxy(description: unknown): unknown {
  const value = description as {
    id: number;
    methods: string[];
    invokes: string[];
    webContents: { methods: string[]; invokes: string[] };
  };
  const proxy: Record<string, unknown> = { id: value.id, webContents: {} };
  for (const method of value.methods ?? []) {
    proxy[method] = (...args: unknown[]) =>
      sync("pluginBrowserWindowMethod", { id: value.id, method, args });
  }
  for (const method of value.invokes ?? []) {
    proxy[method] = (...args: unknown[]) =>
      invoke("pluginBrowserWindowMethod", { id: value.id, method, args });
  }
  const webContents = proxy.webContents as Record<string, unknown>;
  for (const method of value.webContents?.methods ?? []) {
    webContents[method] = (...args: unknown[]) =>
      sync("pluginBrowserWindowMethod", {
        id: value.id,
        target: "webContents",
        method,
        args,
      });
  }
  return proxy;
}

const utools = {
  __event__: events,
  onPluginReady: (callback: unknown) => registerEvent("pluginReady", callback),
  onPluginEnter: (callback: unknown) => registerEvent("pluginEnter", callback),
  onPluginOut: (callback: unknown) => registerEvent("pluginOut", callback),
  onPluginDetach: (callback: unknown) => registerEvent("pluginDetach", callback),
  onDbPull: (callback: unknown) => registerEvent("dbPull", callback),
  hideMainWindow: (restoreFocus = true) => sync("hideMainWindow", restoreFocus),
  showMainWindow: () => sync("showMainWindow"),
  outPlugin: (close = false) => sync("outPlugin", close),
  setExpendHeight: (_height: number) => false,
  setExpandHeight: (_height: number) => false,
  setSubInput: () => false,
  removeSubInput: () => false,
  setSubInputValue: () => false,
  subInputFocus: () => false,
  subInputSelect: () => false,
  subInputBlur: () => false,
  createBrowserWindow: (url: string, options: unknown, callback?: (value: unknown) => void) => {
    const result = childWindowProxy(sync("createBrowserWindow", { url, options }));
    callback?.(result);
    return result;
  },
  showNotification: (body: string, clickFeatureCode?: string) =>
    sync("showNotification", { body, clickFeatureCode }),
  showOpenDialog: (options: unknown) => sync("showOpenDialog", options),
  showSaveDialog: (options: unknown) => sync("showSaveDialog", options),
  getAppName: () => sync("getAppName"),
  getAppVersion: () => sync("getAppVersion"),
  getPath: (name: string) => sync("getPath", name),
  getPluginLocalDataPath: () => sync("getPluginLocalDataPath"),
  getPluginTempPath: () => sync("getPluginTempPath"),
  getFileIcon: (filePath: string) => sync("getFileIcon", filePath),
  getFileIconAsync: (filePath: string) => invoke("getFileIconAsync", filePath),
  copyText: (text: string) => sync("copyText", text),
  copyImage: (filePath: string) => sync("copyImage", filePath),
  getCopyedFiles: () => sync("getCopiedFiles"),
  getCopiedFiles: () => sync("getCopiedFiles"),
  hideMainWindowPasteText: (text: string) => invoke("hideMainWindowPasteText", text),
  shellOpenItem: (filePath: string) => invoke("shellOpenItem", filePath),
  shellOpenPath: (filePath: string) => invoke("shellOpenPath", filePath),
  shellTrashItem: (filePath: string) => invoke("shellTrashItem", filePath),
  shellShowItemInFolder: (filePath: string) => sync("shellShowItemInFolder", filePath),
  shellOpenExternal: (url: string) => invoke("shellOpenExternal", url),
  shellBeep: () => sync("shellBeep"),
  getCursorScreenPoint: () => sync("getCursorScreenPoint"),
  getPrimaryDisplay: () => sync("getPrimaryDisplay"),
  getAllDisplays: () => sync("getAllDisplays"),
  getDisplayNearestPoint: (point: unknown) => sync("getDisplayNearestPoint", point),
  getDisplayMatching: (rectangle: unknown) => sync("getDisplayMatching", rectangle),
  setFeature: (feature: unknown) => sync("setFeature", feature),
  removeFeature: (featureCode: string) => sync("removeFeature", featureCode),
  getFeatures: () => sync("getFeatures"),
  isDev: () => !process.resourcesPath.includes("app.asar"),
  isMacOs: () => process.platform === "darwin",
  isMacOS: () => process.platform === "darwin",
  isWindows: () => process.platform === "win32",
  isLinux: () => process.platform === "linux",
  getWindowType: () => "plugin",
  dbStorage: Object.freeze({
    setItem: (key: string, value: unknown) => sync("dbStorageSetItem", { key, value }),
    getItem: (key: string) => sync("dbStorageGetItem", key),
    removeItem: (key: string) => sync("dbStorageRemoveItem", key),
  }),
  dbCryptoStorage: Object.freeze({
    setItem: (key: string, value: unknown) =>
      sync("dbStorageSetItem", { key: `crypto:${key}`, value }),
    getItem: (key: string) => sync("dbStorageGetItem", `crypto:${key}`),
    removeItem: (key: string) => sync("dbStorageRemoveItem", `crypto:${key}`),
  }),
  db: Object.freeze({
    put: (document: unknown) => sync("dbPut", document),
    get: (id: string) => sync("dbGet", id),
    remove: (document: unknown) => sync("dbRemove", document),
    bulkDocs: (documents: unknown[]) => sync("dbBulkDocs", documents),
    allDocs: (options?: unknown) => sync("dbAllDocs", options ?? {}),
    promises: Object.freeze({
      put: (document: unknown) => invoke("dbPromisePut", document),
      get: (id: string) => invoke("dbPromiseGet", id),
      remove: (document: unknown) => invoke("dbPromiseRemove", document),
      bulkDocs: (documents: unknown[]) => invoke("dbPromiseBulkDocs", documents),
      allDocs: (options?: unknown) => invoke("dbPromiseAllDocs", options ?? {}),
    }),
  }),
  get ubrowser(): never {
    throw new Error("ubrowser 尚未在 MVP 中实现");
  },
  runFFmpeg: (): never => {
    throw new Error("runFFmpeg 尚未在 MVP 中实现");
  },
  registerTool: (): never => {
    throw new Error("AI Tool 注册尚未在 MVP 中实现");
  },
};

Object.defineProperty(window.File.prototype, "path", {
  get() {
    return webUtils.getPathForFile(this);
  },
  configurable: true,
  enumerable: true,
});

window.utools = Object.freeze(utools);

ipcRenderer.on("compat:plugin-enter", (_event, payload) => {
  currentEnterPayload = payload;
  events.pluginEnter?.(payload);
});
ipcRenderer.on("compat:plugin-out", () => events.pluginOut?.());

if (pluginPreload) {
  try {
    require(pluginPreload);
  } catch (error) {
    console.error(`[Dockwisp] plugin preload failed (${pluginId})`, error);
  }
}

events.pluginReady?.();
ipcRenderer.send("compat:ready");
