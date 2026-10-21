import { contextBridge, ipcRenderer } from "electron";

interface TranslateInitialState {
  theme: "light" | "dark";
  text: string;
  provider: "mymemory" | "libretranslate";
  providerName: string;
}

interface TranslateRunPayload {
  text: string;
  source: string;
  target: string;
}

contextBridge.exposeInMainWorld("translate", {
  onState: (callback: (state: TranslateInitialState) => void) =>
    ipcRenderer.on("translate:state", (_event, state: TranslateInitialState) => callback(state)),
  onTheme: (callback: (theme: "light" | "dark") => void) =>
    ipcRenderer.on("translate:theme", (_event, theme: "light" | "dark") => callback(theme)),
  run: (payload: TranslateRunPayload) => ipcRenderer.invoke("translate:run", payload),
  copy: (text: string) => ipcRenderer.invoke("translate:copy", text),
  close: () => ipcRenderer.send("translate:close"),
});
