import assert from "node:assert/strict";
import { createReadStream, createWriteStream, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import test from "node:test";
import { createGzip } from "node:zlib";
import { PluginPackageInstaller } from "../src/main/plugin-package";

test("installs a gzip-ASAR plugin package without overwriting", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dockwisp-upx-test-"));
  const source = path.join(root, "source");
  const plugins = path.join(root, "plugins");
  mkdirSync(source);
  writeFileSync(path.join(source, "index.html"), "<main>fixture</main>");
  writeFileSync(
    path.join(source, "plugin.json"),
    JSON.stringify({
      name: "fixture-package",
      pluginName: "Fixture Package",
      version: "1.2.3",
      main: "index.html",
      features: [{ code: "home", cmds: ["fixture"] }],
    }),
  );
  const archive = path.join(root, "fixture.asar");
  const packagePath = path.join(root, "fixture.upx");
  const asar = await import("@electron/asar");
  await asar.createPackage(source, archive);
  await pipeline(createReadStream(archive), createGzip(), createWriteStream(packagePath));

  const installer = new PluginPackageInstaller(plugins);
  const installed = await installer.install(packagePath);
  assert.equal(installed.id, "fixture-package");
  assert.equal(installed.version, "1.2.3");
  assert.ok(installed.directory.startsWith(plugins));
  await assert.rejects(() => installer.install(packagePath), /已安装/);
});
