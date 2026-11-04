import { contextBridge, ipcRenderer } from "electron";

interface PinImage {
  dataUrl: string;
  cssWidth: number;
  cssHeight: number;
  scale?: number;
}

contextBridge.exposeInMainWorld("pin", {
  onImage: (callback: (image: PinImage) => void) =>
    ipcRenderer.on("pin:image", (_event, image: PinImage) => callback(image)),
  dragStart: () => ipcRenderer.send("pin:drag-start"),
  dragMove: (dx: number, dy: number) => ipcRenderer.send("pin:drag-move", { dx, dy }),
  dragEnd: () => ipcRenderer.send("pin:drag-end"),
  zoom: (scale: number): Promise<number> => ipcRenderer.invoke("pin:zoom", scale),
  menu: () => ipcRenderer.send("pin:menu"),
  close: () => ipcRenderer.send("pin:close"),
  minimize: () => ipcRenderer.send("pin:minimize"),
});
