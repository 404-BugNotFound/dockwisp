import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { shell } from "electron";
import { buildSearchForms } from "../core/matcher";
import { AppEntry } from "../core/types";

export const LAUNCHABLE_EXTENSIONS = new Set([".lnk", ".exe", ".url", ".appref-ms"]);

function entryId(filePath: string): string {
  return createHash("sha1").update(filePath.toLowerCase()).digest("hex");
}

function scanDirectory(
  directory: string,
  source: AppEntry["source"],
  result: Map<string, AppEntry>,
  depth = 0,
): void {
  if (depth > 8 || !existsSync(directory) || result.size >= 25_000) return;
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (result.size >= 25_000) return;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      scanDirectory(fullPath, source, result, depth + 1);
      continue;
    }
    if (!entry.isFile() || !LAUNCHABLE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      continue;
    }
    const key = fullPath.toLowerCase();
    if (result.has(key)) continue;
    const name = path.basename(entry.name, path.extname(entry.name));
    result.set(key, {
      id: entryId(fullPath),
      name,
      path: fullPath,
      source,
      isApp: true,
      ...buildSearchForms(name),
    });
  }
}

function addCustomItem(filePath: string, result: Map<string, AppEntry>): void {
  if (!existsSync(filePath)) return;
  let stats;
  try {
    stats = statSync(filePath);
  } catch {
    return;
  }
  if (!stats.isFile() && !stats.isDirectory()) return;
  const resolved = path.resolve(filePath);
  const key = resolved.toLowerCase();
  const name = path.basename(filePath, stats.isFile() ? path.extname(filePath) : undefined);
  // A custom item is launchable only when it is a file with a launchable
  // extension. Directories and other files remain indexed but are excluded from
  // the default (app) search; they can still surface via file search.
  const isApp =
    stats.isFile() && LAUNCHABLE_EXTENSIONS.has(path.extname(resolved).toLowerCase());
  const existing = result.get(key);
  result.set(key, {
    id: entryId(key),
    name,
    path: resolved,
    // Preserve the stronger source when a custom item duplicates a scanned app.
    source: existing ? existing.source : "custom",
    isApp: existing ? existing.isApp || isApp : isApp,
    ...buildSearchForms(name),
  });
}

function resolvedAppKey(entry: AppEntry): string {
  if (path.extname(entry.path).toLowerCase() !== ".lnk") {
    return path.resolve(entry.path).toLowerCase();
  }
  try {
    const target = shell.readShortcutLink(entry.path).target;
    if (target) return path.resolve(target).toLowerCase();
  } catch {
    // Unreadable or non-file shortcuts (for example UWP entries) keep their path.
  }
  return path.resolve(entry.path).toLowerCase();
}

export function buildApplicationIndex(
  customItems: string[],
  pinnedPaths: string[] = [],
): AppEntry[] {
  const result = new Map<string, AppEntry>();
  const appData = process.env.APPDATA;
  const programData = process.env.ProgramData;
  const userProfile = os.homedir();
  if (appData) {
    scanDirectory(path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs"), "start-menu", result);
  }
  if (programData) {
    scanDirectory(path.join(programData, "Microsoft", "Windows", "Start Menu", "Programs"), "start-menu", result);
  }
  scanDirectory(path.join(userProfile, "Desktop"), "desktop", result);
  scanDirectory(path.join(process.env.PUBLIC ?? "C:\\Users\\Public", "Desktop"), "desktop", result);
  for (const item of customItems) addCustomItem(item, result);
  // Ensure pinned app/file paths are present even if removed from custom items.
  for (const item of pinnedPaths) {
    if (!result.has(path.resolve(item).toLowerCase())) addCustomItem(item, result);
  }

  // A Start Menu shortcut and a desktop shortcut commonly point at the same
  // executable. They are indexed under different filesystem paths, so without
  // this pass the launcher shows the same app twice. Group by display name and
  // resolve .lnk targets only for duplicate names; this preserves genuinely
  // different apps that happen to share a name while keeping startup scanning
  // cheap. A pinned entry wins over the Start Menu/desktop duplicate.
  const pinned = new Set(pinnedPaths.map((item) => path.resolve(item).toLowerCase()));
  const groups = new Map<string, AppEntry[]>();
  for (const entry of result.values()) {
    const key = entry.name.toLowerCase();
    const group = groups.get(key);
    if (group) group.push(entry);
    else groups.set(key, [entry]);
  }
  const deduped: AppEntry[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      deduped.push(group[0]);
      continue;
    }
    const ordered = [...group].sort((left, right) => {
      const leftPinned = pinned.has(left.path.toLowerCase()) ? 0 : 1;
      const rightPinned = pinned.has(right.path.toLowerCase()) ? 0 : 1;
      return leftPinned - rightPinned;
    });
    const seen = new Set<string>();
    for (const entry of ordered) {
      const key = resolvedAppKey(entry);
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(entry);
      }
    }
  }
  return deduped;
}
