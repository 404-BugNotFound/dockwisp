import { contextBridge, ipcRenderer } from "electron";

interface ScreenshotState {
  // Native captures: raw top-down RGBA pixels. Fallback: a JPEG data URL.
  pixels?: Uint8Array;
  imageUrl?: string;
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
  onReset: (callback: () => void) =>
    ipcRenderer.on("screenshot:reset", () => callback()),
  ready: () => ipcRenderer.send("screenshot:ready"),
  // Main shows the window off-screen, then waits for a painted frame before
  // moving it on-screen (avoids a black first frame) and announces the reveal.
  onShown: (callback: () => void) => ipcRenderer.on("screenshot:shown", () => callback()),
  painted: () => ipcRenderer.send("screenshot:painted"),
  onRevealed: (callback: () => void) =>
    ipcRenderer.on("screenshot:revealed", () => callback()),
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
