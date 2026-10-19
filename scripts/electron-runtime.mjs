import { cp, mkdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function electronExecutable() {
  if (process.platform !== "win32") {
    return path.resolve("node_modules", "electron", "dist", "electron");
  }
  const source = path.resolve("node_modules", "electron", "dist");
  const version = (await readFile(path.join(source, "version"), "utf8")).trim();
  const cacheRoot = path.join(os.tmpdir(), "opencode", "dockwisp-electron", version);
  const executable = path.join(cacheRoot, "electron.exe");
  if (!(await exists(executable))) {
    await rm(cacheRoot, { recursive: true, force: true });
    await mkdir(path.dirname(cacheRoot), { recursive: true });
    await cp(source, cacheRoot, { recursive: true });
  }
  return executable;
}
