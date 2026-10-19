import { BrowserWindow, screen } from "electron";
import path from "node:path";

export function createLauncherWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 780,
    height: 72,
    show: false,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    transparent: true,
    hasShadow: false,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "launcher.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  void window.loadFile(path.join(__dirname, "..", "renderer", "launcher", "index.html"));
  let blurTimer: NodeJS.Timeout | null = null;
  window.on("blur", () => {
    if (blurTimer) clearTimeout(blurTimer);
    blurTimer = setTimeout(() => {
      if (!window.isDestroyed() && !window.isFocused() && !window.webContents.isDevToolsOpened()) {
        window.hide();
      }
    }, 140);
  });
  window.on("focus", () => {
    if (blurTimer) clearTimeout(blurTimer);
    blurTimer = null;
  });
  return window;
}

export function showLauncher(window: BrowserWindow, openSettings = false): void {
  if (openSettings) {
    window.setSize(780, 600, false);
  }
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const [width, height] = window.getSize();
  const x = Math.round(display.workArea.x + (display.workArea.width - width) / 2);
  const y = Math.round(display.workArea.y + display.workArea.height * 0.18);
  const showAtTarget = (): void => {
    if (window.isDestroyed() || !window.isVisible()) return;
    window.setPosition(x, y, false);
    window.focus();
  };
  if (window.isVisible()) {
    window.setPosition(x, y, false);
    window.focus();
  } else {
    // Windows fades a newly shown transparent window in over ~100 ms, which
    // looks like a flicker. Show it off-screen first so the fade finishes where
    // the user cannot see it, then move the fully opaque window into place.
    window.setPosition(-20000, -20000, false);
    window.show();
    setTimeout(showAtTarget, 120);
  }
  window.webContents.send(
    openSettings ? "launcher:open-settings" : "launcher:focus",
    openSettings ? undefined : screen.getCursorScreenPoint(),
  );
}
