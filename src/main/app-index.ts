import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
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
  return [...result.values()];
}
