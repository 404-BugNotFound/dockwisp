import { contextBridge, ipcRenderer } from "electron";

interface PreviewState {
  kind: "image" | "text" | "audio" | "video" | "pdf" | "unsupported";
  name: string;
  path: string;
  size: number;
  modified: number;
  theme: "light" | "dark";
  iconUrl?: string;
  mime?: string;
  dataUrl?: string;
  text?: string;
  message?: string;
}

contextBridge.exposeInMainWorld("preview", {
  onState: (callback: (state: PreviewState) => void) =>
    ipcRenderer.on("preview:state", (_event, state: PreviewState) => callback(state)),
  close: () => ipcRenderer.send("preview:close"),
  openExternal: () => ipcRenderer.invoke("preview:open-external"),
  reveal: () => ipcRenderer.invoke("preview:reveal"),
  copyPath: () => ipcRenderer.invoke("preview:copy-path"),
});
