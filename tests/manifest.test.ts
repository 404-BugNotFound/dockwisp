import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ManifestError, parsePluginManifest } from "../src/core/manifest";

function fixture(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "dockwisp-manifest-"));
  writeFileSync(path.join(directory, "index.html"), "<main></main>");
  writeFileSync(path.join(directory, "preload.js"), "window.fixture = true");
  return directory;
}

test("parses a common plugin manifest", () => {
  const directory = fixture();
  const plugin = parsePluginManifest(
    {
      name: "fixture",
      pluginName: "Fixture",
      version: "1.0.0",
      main: "index.html",
      preload: "preload.js",
      features: [{ code: "hello", description: "Hello", cmds: ["hello"] }],
    },
    directory,
  );
  assert.equal(plugin.id, "fixture");
  assert.equal(plugin.manifest.features[0].cmds[0], "hello");
});

test("rejects a plugin entry escaping its directory", () => {
  const directory = fixture();
  mkdirSync(path.join(directory, "child"));
  assert.throws(
    () =>
      parsePluginManifest(
        {
          name: "fixture",
          pluginName: "Fixture",
          main: "../outside.html",
          features: [],
        },
        path.join(directory, "child"),
      ),
    ManifestError,
  );
});

test("rejects an icon path escaping its directory", () => {
  const directory = fixture();
  assert.throws(
    () =>
      parsePluginManifest(
        {
          name: "fixture",
          pluginName: "Fixture",
          main: "index.html",
          features: [
            { code: "hello", icon: "../secret.png", cmds: ["hello"] },
          ],
        },
        directory,
      ),
    ManifestError,
  );
});
