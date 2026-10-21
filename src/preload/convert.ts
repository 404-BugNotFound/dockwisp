import { contextBridge, ipcRenderer, webUtils } from "electron";

/** A file shown in the convert window. */
interface ConvertFile {
  id: string;
  path: string;
  name: string;
  ext: string;
  size: number;
  category: string | null;
}

interface TargetFormat {
  id: string;
  label: string;
  engine: string;
  available: boolean;
  needsDownload?: boolean;
  note?: string;
  quality?: boolean;
}

interface ConvertState {
  theme: "light" | "dark";
  capabilities: { office: boolean };
  office: { version: string; sizeMb: number };
}

interface ConvertRequest {
  id: string;
  path: string;
  targetExt: string;
  quality?: number;
  icoSizes?: number[];
  outputDir?: string;
}

interface ConvertProgress {
  id: string;
  percent: number;
}

interface ConvertResult {
  id: string;
  ok: boolean;
  outputPath?: string;
  message?: string;
  needsDownload?: boolean;
}

interface DownloadProgress {
  phase: "download" | "unpack" | "done";
  received?: number;
  total?: number;
  percent?: number;
}

contextBridge.exposeInMainWorld("convert", {
  onState: (callback: (state: ConvertState) => void) =>
    ipcRenderer.on("convert:state", (_event, state: ConvertState) => callback(state)),
  onFiles: (callback: (files: ConvertFile[]) => void) =>
    ipcRenderer.on("convert:files", (_event, files: ConvertFile[]) => callback(files)),
  onProgress: (callback: (progress: ConvertProgress) => void) =>
    ipcRenderer.on("convert:progress", (_event, progress: ConvertProgress) => callback(progress)),
  onResult: (callback: (result: ConvertResult) => void) =>
    ipcRenderer.on("convert:result", (_event, result: ConvertResult) => callback(result)),
  onPreset: (callback: (preset: { target?: string }) => void) =>
    ipcRenderer.on("convert:preset", (_event, preset) => callback(preset)),
  onPromptDownload: (callback: (info: { target: string }) => void) =>
    ipcRenderer.on("convert:prompt-download", (_event, info) => callback(info)),
  onDownloadProgress: (callback: (progress: DownloadProgress) => void) =>
    ipcRenderer.on("convert:download-progress", (_event, progress: DownloadProgress) =>
      callback(progress),
    ),

  listTargets: (ext: string): Promise<TargetFormat[]> =>
    ipcRenderer.invoke("convert:list-targets", ext),
  addFiles: (): Promise<void> => ipcRenderer.invoke("convert:add-files"),
  addDroppedPaths: (paths: string[]): Promise<void> =>
    ipcRenderer.invoke("convert:add-dropped", paths),
  pathsForFiles: (files: File[]): string[] =>
    files.map((file) => webUtils.getPathForFile(file)),
  removeFile: (id: string): Promise<void> => ipcRenderer.invoke("convert:remove-file", id),
  chooseOutputDir: (): Promise<string | null> =>
    ipcRenderer.invoke("convert:choose-output-dir"),
  readSource: (filePath: string): Promise<string> =>
    ipcRenderer.invoke("convert:read-source", filePath),
  start: (requests: ConvertRequest[]): Promise<void> =>
    ipcRenderer.invoke("convert:start", requests),
  downloadOffice: (): Promise<{ ok: boolean; message?: string; cancelled?: boolean }> =>
    ipcRenderer.invoke("convert:download-office"),
  cancelDownload: (): void => ipcRenderer.send("convert:cancel-download"),
  openFile: (filePath: string): Promise<{ ok: boolean; message?: string }> =>
    ipcRenderer.invoke("convert:open-file", filePath),
  revealFile: (filePath: string): Promise<boolean> =>
    ipcRenderer.invoke("convert:reveal-file", filePath),
  close: (): void => ipcRenderer.send("convert:close"),
});
