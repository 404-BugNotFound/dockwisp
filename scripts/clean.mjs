import { readdir, rm } from "node:fs/promises";
import path from "node:path";

// Files under these directories are sometimes held open by other programs (an
// Electron app that peeked into app.asar, an Explorer preview, antivirus).
// Windows refuses to delete them, so remove everything that can be removed and
// only warn about the locked leftovers instead of failing the whole build.
const LOCKED_CODES = new Set(["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"]);
const locked = [];

async function removeTree(target) {
  try {
    await rm(target, { recursive: true, force: true });
    return;
  } catch (error) {
    if (!LOCKED_CODES.has(error?.code)) throw error;
  }
  let entries = null;
  try {
    entries = await readdir(target, { withFileTypes: true });
  } catch {
    // A locked file rather than a directory.
  }
  if (entries) {
    for (const entry of entries) await removeTree(path.join(target, entry.name));
    try {
      await rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!LOCKED_CODES.has(error?.code)) throw error;
    }
  }
  if (!entries || entries.length === 0) locked.push(target);
}

for (const directory of ["dist", "dist-test", "release"]) {
  await removeTree(directory);
}

if (locked.length) {
  console.warn("clean: these files are locked by another program and were left in place:");
  for (const item of locked) console.warn(`  ${item}`);
}
