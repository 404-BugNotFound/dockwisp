import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

// Package into a fresh staging directory under temp/ and copy only the installer
// into release/. electron-builder's win-unpacked folder therefore never lives in
// release/, so a program holding a stale handle on an old app.asar can no longer
// block the next build.
const STAGING_ROOT = path.join("temp", "electron-builder");
const RELEASE = "release";

const pkg = JSON.parse(await readFile("package.json", "utf8"));
const installerName = `Dockwisp-${pkg.version}-x64.exe`;

// Best-effort cleanup of previous staging builds; locked ones stay until later.
await mkdir(STAGING_ROOT, { recursive: true });
for (const entry of await readdir(STAGING_ROOT)) {
  await rm(path.join(STAGING_ROOT, entry), { recursive: true, force: true }).catch(() => {});
}

const staging = path.join(STAGING_ROOT, String(Date.now()));
const cli = path.join("node_modules", "electron-builder", "cli.js");
const result = spawnSync(
  process.execPath,
  [cli, "--win", "nsis", `-c.directories.output=${staging}`],
  { stdio: "inherit" },
);
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

// Exercise the packaged OCR worker, native ONNX binding and bundled models
// before publishing the installer. Development-mode OCR does not prove that
// asar unpacking and extraResources paths are correct.
const packagedExecutable = path.join(staging, "win-unpacked", "Dockwisp.exe");
const ocrFixture = path.resolve("docs", "images", "translation.png");
const ocrSmokeData = path.resolve("temp", "packaged-ocr-smoke-userdata");
await rm(ocrSmokeData, { recursive: true, force: true }).catch(() => {});
const ocrSmoke = spawnSync(
  packagedExecutable,
  [`--ocr-smoke-test=${ocrFixture}`, `--user-data-dir=${ocrSmokeData}`],
  { stdio: "inherit", windowsHide: true, timeout: 120_000 },
);
if (ocrSmoke.status !== 0) {
  console.error(`dist: packaged OCR smoke test failed (${ocrSmoke.status ?? ocrSmoke.error})`);
  process.exit(ocrSmoke.status ?? 1);
}

await mkdir(RELEASE, { recursive: true });
for (const entry of await readdir(RELEASE)) {
  if (/\.(exe|blockmap|yml)$/i.test(entry)) {
    await rm(path.join(RELEASE, entry), { force: true });
  }
}
const target = path.join(RELEASE, installerName);
await copyFile(path.join(staging, installerName), target);
console.log(`dist: installer written to ${target}`);
