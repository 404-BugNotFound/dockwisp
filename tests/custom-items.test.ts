import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  describeCustomItem,
  mergeCustomItems,
  removeCustomItem,
} from "../src/main/custom-items";

test("adds launchable applications while rejecting unsupported files", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dockwisp-custom-app-"));
  const executable = path.join(root, "Portable Tool.exe");
  const document = path.join(root, "notes.txt");
  writeFileSync(executable, "fixture");
  writeFileSync(document, "fixture");

  const result = mergeCustomItems([], [executable, document], {
    applications: true,
    directories: false,
  });

  assert.deepEqual(result.paths, [path.resolve(executable)]);
  assert.equal(result.added[0]?.name, "Portable Tool");
  assert.equal(result.added[0]?.kind, "application");
  assert.deepEqual(result.skipped, [path.resolve(document)]);
});

test("adds directories separately and deduplicates existing paths", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dockwisp-custom-dir-"));
  const directory = path.join(root, "Projects");
  mkdirSync(directory);

  const first = mergeCustomItems([], [directory], {
    applications: false,
    directories: true,
  });
  const duplicate = mergeCustomItems(first.paths, [directory], {
    applications: false,
    directories: true,
  });

  assert.equal(first.added[0]?.kind, "directory");
  assert.equal(duplicate.added.length, 0);
  assert.deepEqual(duplicate.skipped, [path.resolve(directory)]);
});

test("keeps missing custom items visible and removes paths case-insensitively", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dockwisp-custom-missing-"));
  const missing = path.join(root, "Missing App.exe");
  const item = describeCustomItem(missing);
  assert.equal(item.kind, "application");
  assert.equal(item.exists, false);

  const remaining = removeCustomItem([missing, "C:\\Tools\\Other.exe"], missing.toUpperCase());
  assert.deepEqual(remaining, ["C:\\Tools\\Other.exe"]);
});
