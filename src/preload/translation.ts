import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("translation", {
  close: () => ipcRenderer.send("translation:close"),
  copy: () => ipcRenderer.send("translation:copy"),
  pin: (pinned: boolean) => ipcRenderer.send("translation:pin", pinned),
  onState: (callback: (state: unknown) => void) =>
    ipcRenderer.on("translation:state", (_event, state) => callback(state)),
});
