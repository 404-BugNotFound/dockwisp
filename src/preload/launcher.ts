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
  refresh: () => ipcRenderer.invoke("launcher:refresh"),
  clearUsage: () => ipcRenderer.invoke("usage:clear"),
  resize: (height: number) => ipcRenderer.send("launcher:resize", height),
  addPaths: (paths: string[]) => ipcRenderer.invoke("launcher:add-paths", paths),
  pinMatch: (id: string, pinned: boolean) =>
    ipcRenderer.invoke("launcher:pin-match", id, pinned),
  itemAction: (
    id: string,
    action: "open" | "reveal" | "copy-path" | "copy-name" | "run-as-admin",
  ) => ipcRenderer.invoke("launcher:item-action", id, action),
  pathsForFiles: (files: File[]) => files.map((file) => webUtils.getPathForFile(file)),
  onFocus: (callback: (point?: { x: number; y: number }) => void) =>
    ipcRenderer.on("launcher:focus", (_event, point) => callback(point)),
  onOpenSettings: (callback: () => void) =>
    ipcRenderer.on("launcher:open-settings", callback),
  onIndexUpdated: (callback: () => void) =>
    ipcRenderer.on("launcher:index-updated", callback),
});
