import { contextBridge, ipcRenderer } from "electron";

interface ScreenshotState {
  imageUrl: string;
  width: number;
  height: number;
  scaleFactor: number;
  // True when the image is loaded from a file:// URL, which taints the canvas
  // and blocks toDataURL; the renderer then re-fetches raw bytes for export.
  tainted: boolean;
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
  // Raw bytes of the current native screenshot, for the tainted-canvas export
  // fallback. Returns null when no native capture is active (e.g. data-URL path).
  imageBytes: (): Promise<Uint8Array | null> => ipcRenderer.invoke("screenshot:image-bytes"),
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
