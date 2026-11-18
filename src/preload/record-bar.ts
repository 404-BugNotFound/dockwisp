import { contextBridge, ipcRenderer } from "electron";

interface RecordBarState {
  paused: boolean;
  elapsedMs: number;
  stopping: boolean;
}

contextBridge.exposeInMainWorld("recordBar", {
  onState: (callback: (state: RecordBarState) => void) =>
    ipcRenderer.on("record-bar:state", (_event, state: RecordBarState) => callback(state)),
  togglePause: () => ipcRenderer.send("record-bar:toggle-pause"),
  stop: () => ipcRenderer.send("record-bar:stop"),
});
