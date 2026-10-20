import { contextBridge, ipcRenderer } from "electron";

interface ScreenshotState {
  image: string;
  width: number;
  height: number;
  scaleFactor: number;
}

interface TranslationResult {
  translatedText: string;
  sourceLanguage: string;
  targetLanguage: string;
  provider: string;
}

contextBridge.exposeInMainWorld("screenshot", {
  onState: (callback: (state: ScreenshotState) => void) =>
    ipcRenderer.on("screenshot:state", (_event, state: ScreenshotState) => callback(state)),
  ready: () => ipcRenderer.send("screenshot:ready"),
  close: () => ipcRenderer.send("screenshot:close"),
  copyImage: (dataUrl: string): Promise<boolean> =>
    ipcRenderer.invoke("screenshot:copy-image", dataUrl),
  copyText: (text: string): Promise<boolean> =>
    ipcRenderer.invoke("screenshot:copy-text", text),
  saveImage: (dataUrl: string): Promise<string | null> =>
    ipcRenderer.invoke("screenshot:save-image", dataUrl),
  ocr: (dataUrl: string): Promise<string> => ipcRenderer.invoke("screenshot:ocr", dataUrl),
  translate: (text: string): Promise<TranslationResult> =>
    ipcRenderer.invoke("screenshot:translate", text),
});
