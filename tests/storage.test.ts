import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PluginStore } from "../src/main/plugin-store";
import { SettingsStore } from "../src/main/settings";

test("persists plugin kv and revisioned documents", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dockwisp-store-"));
  const store = new PluginStore(root, "fixture");
  store.setItem("answer", 42);
  const first = store.put({ _id: "doc", value: "first" });
  const second = store.put({ _id: "doc", _rev: first.rev, value: "second" });
  assert.notEqual(first.rev, second.rev);

  const reopened = new PluginStore(root, "fixture");
  assert.equal(reopened.getItem("answer"), 42);
  assert.equal(reopened.get("doc")?.value, "second");
  assert.throws(() => reopened.put({ _id: "doc", _rev: first.rev }));
});

test("normalizes and rewrites settings", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dockwisp-settings-"));
  const settings = new SettingsStore(root);
  settings.update({ longPressMs: 10, hotkey: "Control+Shift+Space" });
  settings.update({ longPressMs: 9_000 });
  const reopened = new SettingsStore(root).get();
  assert.equal(reopened.hotkey, "Control+Shift+Space");
  assert.equal(reopened.longPressMs, 3_000);
});

test("persists and normalizes theme preference", () => {  const root = mkdtempSync(path.join(os.tmpdir(), "dockwisp-theme-"));
  const settings = new SettingsStore(root);
  assert.equal(settings.get().theme, "system");
  settings.update({ theme: "dark" });
  assert.equal(new SettingsStore(root).get().theme, "dark");
  settings.update({ theme: "neon" as never });
  assert.equal(new SettingsStore(root).get().theme, "system");
});

test("defaults window dragging on and persists disabling it", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dockwisp-drag-"));
  const settings = new SettingsStore(root);
  assert.equal(settings.get().windowDragEnabled, true);
  settings.update({ windowDragEnabled: false });
  assert.equal(new SettingsStore(root).get().windowDragEnabled, false);
  settings.update({ windowDragEnabled: true });
  assert.equal(new SettingsStore(root).get().windowDragEnabled, true);
});

test("defaults and clamps panel transparency", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dockwisp-opacity-"));
  const settings = new SettingsStore(root);
  assert.equal(settings.get().panelTransparency, 12);
  settings.update({ panelTransparency: 28.6 });
  assert.equal(new SettingsStore(root).get().panelTransparency, 29);
  settings.update({ panelTransparency: 99 });
  assert.equal(new SettingsStore(root).get().panelTransparency, 40);
  settings.update({ panelTransparency: -5 });
  assert.equal(new SettingsStore(root).get().panelTransparency, 0);
});

test("persists, dedupes and caps pinned matches", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dockwisp-pins-"));
  const settings = new SettingsStore(root);
  settings.update({
    pinnedMatches: [
      {
        id: "app:1",
        kind: "app",
        title: "Notepad",
        subtitle: "应用程序",
        path: "C:\\notepad.exe",
      },
      {
        id: "app:1",
        kind: "app",
        title: "Notepad duplicate",
        subtitle: "应用程序",
        path: "C:\\notepad.exe",
      },
      { id: "bad", kind: "unknown", title: "x", subtitle: "" } as never,
    ],
  });
  const reopened = new SettingsStore(root).get();
  assert.equal(reopened.pinnedMatches.length, 1);
  assert.equal(reopened.pinnedMatches[0]?.id, "app:1");
  assert.equal(reopened.pinnedMatches[0]?.title, "Notepad");

  const many = Array.from({ length: 60 }, (_, index) => ({
    id: `app:${index}`,
    kind: "app" as const,
    title: `App ${index}`,
    subtitle: "应用程序",
    path: `C:\\app-${index}.exe`,
  }));
  settings.update({ pinnedMatches: many });
  assert.equal(new SettingsStore(root).get().pinnedMatches.length, 50);
});

test("defaults and normalizes screenshot hotkey", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dockwisp-shot-"));
  const settings = new SettingsStore(root);
  assert.equal(settings.get().screenshotHotkey, "Alt+Shift+S");
  settings.update({ screenshotHotkey: "Ctrl+Alt+A" });
  assert.equal(new SettingsStore(root).get().screenshotHotkey, "Ctrl+Alt+A");
  settings.update({ screenshotHotkey: "   " });
  assert.equal(new SettingsStore(root).get().screenshotHotkey, "Alt+Shift+S");
  settings.update({ screenshotHotkey: 123 as never });
  assert.equal(new SettingsStore(root).get().screenshotHotkey, "Alt+Shift+S");
});

test("persists valid launcher position and rejects invalid", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dockwisp-pos-"));
  const settings = new SettingsStore(root);
  assert.equal(settings.get().launcherPosition, null);
  settings.update({ launcherPosition: { x: 240, y: 180 } });
  assert.deepEqual(new SettingsStore(root).get().launcherPosition, { x: 240, y: 180 });
  settings.update({ launcherPosition: { x: 10.7, y: -5.2 } });
  assert.deepEqual(new SettingsStore(root).get().launcherPosition, { x: 11, y: -5 });
  settings.update({ launcherPosition: { x: 999999, y: 0 } });
  assert.equal(new SettingsStore(root).get().launcherPosition, null);
  settings.update({ launcherPosition: { x: Number.NaN, y: 0 } as never });
  assert.equal(new SettingsStore(root).get().launcherPosition, null);
  settings.update({ launcherPosition: "nope" as never });
  assert.equal(new SettingsStore(root).get().launcherPosition, null);
});
