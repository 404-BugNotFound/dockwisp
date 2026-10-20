import { contextBridge, ipcRenderer, webUtils } from "electron";

contextBridge.exposeInMainWorld("dockwisp", {
  search: (input: unknown) => ipcRenderer.invoke("launcher:search", input),
  execute: (id: string) => ipcRenderer.invoke("launcher:execute", id),
  hide: () => ipcRenderer.send("launcher:hide"),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  updateSettings: (settings: unknown) => ipcRenderer.invoke("settings:update", settings),
  addPluginDirectory: () => ipcRenderer.invoke("launcher:add-plugin-directory"),
  installPluginPackage: () => ipcRenderer.invoke("launcher:install-plugin-package"),
  addCustomItem: () => ipcRenderer.invoke("launcher:add-custom-item"),
  addCustomDirectory: () => ipcRenderer.invoke("launcher:add-custom-directory"),
  listCustomItems: () => ipcRenderer.invoke("launcher:list-custom-items"),
  removeCustomItem: (filePath: string) =>
    ipcRenderer.invoke("launcher:remove-custom-item", filePath),
  refresh: () => ipcRenderer.invoke("launcher:refresh"),
  clearUsage: () => ipcRenderer.invoke("usage:clear"),
  resetPosition: () => ipcRenderer.invoke("launcher:reset-position"),
  listPlugins: () => ipcRenderer.invoke("plugins:list"),
  startScreenshot: () => ipcRenderer.send("screenshot:start"),
  dragStart: (screenX: number, screenY: number) =>
    ipcRenderer.send("launcher:drag-start", screenX, screenY),
  dragMove: (screenX: number, screenY: number) =>
    ipcRenderer.send("launcher:drag-move", screenX, screenY),
  dragEnd: () => ipcRenderer.send("launcher:drag-end"),
  setHubOpen: (open: boolean) => ipcRenderer.send("launcher:hub-open", open),
  resize: (height: number, width?: number) =>
    ipcRenderer.send("launcher:resize", height, width),
  addPaths: (paths: string[]) => ipcRenderer.invoke("launcher:add-paths", paths),
  pinMatch: (id: string, pinned: boolean) =>
    ipcRenderer.invoke("launcher:pin-match", id, pinned),
  itemAction: (
    id: string,
    action: "open" | "reveal" | "copy-path" | "copy-name" | "run-as-admin" | "preview",
  ) => ipcRenderer.invoke("launcher:item-action", id, action),
  pathsForFiles: (files: File[]) => files.map((file) => webUtils.getPathForFile(file)),
  onFocus: (callback: (point?: { x: number; y: number }) => void) =>
    ipcRenderer.on("launcher:focus", (_event, point) => callback(point)),
  onOpenSettings: (callback: (page?: string) => void) =>
    ipcRenderer.on("launcher:open-settings", (_event, page) => callback(page)),
  onIndexUpdated: (callback: () => void) =>
    ipcRenderer.on("launcher:index-updated", callback),
});
