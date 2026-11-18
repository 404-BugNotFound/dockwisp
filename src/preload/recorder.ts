import { contextBridge, ipcRenderer } from "electron";

type RecorderCommand = "pause" | "resume" | "stop";

contextBridge.exposeInMainWorld("recorder", {
  getConfig: () => ipcRenderer.invoke("recorder:get-config"),
  started: (info: { mimeType: string }) => ipcRenderer.send("recorder:started", info),
  chunk: (data: Uint8Array) => ipcRenderer.send("recorder:chunk", data),
  state: (paused: boolean) => ipcRenderer.send("recorder:state", paused),
  stopped: () => ipcRenderer.send("recorder:stopped"),
  error: (message: string) => ipcRenderer.send("recorder:error", message),
  onCommand: (callback: (command: RecorderCommand) => void) =>
    ipcRenderer.on("recorder:command", (_event, command: RecorderCommand) => callback(command)),
});
