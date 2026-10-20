import { BrowserWindow, screen } from "electron";
import path from "node:path";

export const LAUNCHER_WIDTH = 720;
export const LAUNCHER_HEIGHT = 64;
export const SETTINGS_WIDTH = 1000;
export const SETTINGS_HEIGHT = 660;

export interface LauncherPosition {
  x: number;
  y: number;
}

export function createLauncherWindow(keepOpenOnBlur: () => boolean = () => false): BrowserWindow {
  const window = new BrowserWindow({
    width: LAUNCHER_WIDTH,
    height: LAUNCHER_HEIGHT,
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
      if (
        !window.isDestroyed() &&
        !window.isFocused() &&
        !window.webContents.isDevToolsOpened() &&
        !keepOpenOnBlur()
      ) {
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

/** Default placement: centered on the cursor's display, near 18% from the top. */
export function defaultLauncherPosition(width: number, height: number): LauncherPosition {
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const x = Math.round(display.workArea.x + (display.workArea.width - width) / 2);
  const y = Math.round(display.workArea.y + display.workArea.height * 0.18);
  return { x, y };
}

/**
 * Decide whether a saved position is usable: either the window's top-left lands
 * inside some display's work area, or at least 80px of the window stays visible
 * on one of them. Guards against positions left over from an unplugged monitor.
 */
function isPositionVisible(position: LauncherPosition, width: number, height: number): boolean {
  const MIN_VISIBLE = 80;
  for (const display of screen.getAllDisplays()) {
    const area = display.workArea;
    const inside =
      position.x >= area.x &&
      position.y >= area.y &&
      position.x < area.x + area.width &&
      position.y < area.y + area.height;
    if (inside) return true;
    const overlapX = Math.min(position.x + width, area.x + area.width) - Math.max(position.x, area.x);
    const overlapY = Math.min(position.y + height, area.y + area.height) - Math.max(position.y, area.y);
    if (overlapX >= MIN_VISIBLE && overlapY >= MIN_VISIBLE) return true;
  }
  return false;
}

/** Clamp a position so a window of the given size stays within its display's work area. */
function clampToWorkArea(
  position: LauncherPosition,
  width: number,
  height: number,
): LauncherPosition {
  const display = screen.getDisplayNearestPoint(position);
  const area = display.workArea;
  const x = Math.round(Math.max(area.x, Math.min(position.x, area.x + area.width - width)));
  const y = Math.round(Math.max(area.y, Math.min(position.y, area.y + area.height - height)));
  return { x, y };
}

export function showLauncher(
  window: BrowserWindow,
  openSettings = false,
  position?: LauncherPosition | null,
): void {
  if (openSettings) {
    window.setSize(SETTINGS_WIDTH, SETTINGS_HEIGHT, false);
  }
  const [width, height] = window.getSize();
  // Prefer a persisted position when it is still visible on the current
  // monitor layout; otherwise fall back to the cursor-centered default.
  let target: LauncherPosition;
  if (position && isPositionVisible(position, width, height)) {
    // When opening settings the taller window may spill past the work area, so
    // clamp it back in. The compact launcher is left exactly where saved.
    target = openSettings ? clampToWorkArea(position, width, height) : position;
  } else {
    target = defaultLauncherPosition(width, height);
    if (openSettings) target = clampToWorkArea(target, width, height);
  }
  const { x, y } = target;
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
