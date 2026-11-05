import { contextBridge, ipcRenderer, webUtils } from "electron";

const listen = (channel: string) => (callback: (payload: unknown) => void) =>
  ipcRenderer.on(channel, (_event, payload: unknown) => callback(payload));

contextBridge.exposeInMainWorld("lanTransfer", {
  getState: () => ipcRenderer.invoke("lan:get-state"),
  onState: listen("lan:state"),
  onFiles: listen("lan:files"),
  onReceived: listen("lan:received"),
  onProgress: listen("lan:progress"),
  addFiles: () => ipcRenderer.invoke("lan:add-files"),
  addDropped: (files: File[]) =>
    ipcRenderer.invoke(
      "lan:add-dropped",
      files.map((file) => webUtils.getPathForFile(file)).filter(Boolean),
    ),
  removeFile: (id: string) => ipcRenderer.invoke("lan:remove-file", id),
  clearFiles: () => ipcRenderer.invoke("lan:clear-files"),
  selectAddress: (address: string) => ipcRenderer.invoke("lan:select-address", address),
  restart: () => ipcRenderer.invoke("lan:restart"),
  chooseReceiveDir: () => ipcRenderer.invoke("lan:choose-receive-dir"),
  openReceiveDir: () => ipcRenderer.invoke("lan:open-receive-dir"),
  openFile: (filePath: string) => ipcRenderer.invoke("lan:open-file", filePath),
  revealFile: (filePath: string) => ipcRenderer.invoke("lan:reveal-file", filePath),
  close: () => ipcRenderer.send("lan:close"),
});
