import { contextBridge, ipcRenderer } from "electron";

interface DiffInitialState {
  theme: "light" | "dark";
  left?: string;
  right?: string;
}

interface DiffComputeOptions {
  ignoreWhitespace?: boolean;
  ignoreCase?: boolean;
}

contextBridge.exposeInMainWorld("diff", {
  onState: (callback: (state: DiffInitialState) => void) =>
    ipcRenderer.on("diff:state", (_event, state: DiffInitialState) => callback(state)),
  onTheme: (callback: (theme: "light" | "dark") => void) =>
    ipcRenderer.on("diff:theme", (_event, theme: "light" | "dark") => callback(theme)),
  compute: (left: string, right: string, options: DiffComputeOptions) =>
    ipcRenderer.invoke("diff:compute", { left, right, options }),
  copy: (text: string) => ipcRenderer.invoke("diff:copy", text),
  close: () => ipcRenderer.send("diff:close"),
});
