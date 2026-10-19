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
