import { contextBridge, ipcRenderer } from "electron";

interface LongPreview {
  dataUrl: string;
  height: number;
}

contextBridge.exposeInMainWorld("longshot", {
  onPreview: (callback: (preview: LongPreview) => void) =>
    ipcRenderer.on("longshot:preview", (_event, preview: LongPreview) => callback(preview)),
  done: () => ipcRenderer.send("longshot:done"),
  cancel: () => ipcRenderer.send("longshot:cancel"),
});
