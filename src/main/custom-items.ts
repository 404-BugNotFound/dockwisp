import { statSync } from "node:fs";
import path from "node:path";

export const LAUNCHABLE_EXTENSIONS = new Set([".lnk", ".exe", ".url", ".appref-ms"]);

export type CustomItemKind = "application" | "directory" | "file";

export interface CustomItemInfo {
  name: string;
  path: string;
  kind: CustomItemKind;
  exists: boolean;
}

export interface MergeCustomItemOptions {
  applications?: boolean;
  directories?: boolean;
}

export interface MergeCustomItemResult {
  paths: string[];
  added: CustomItemInfo[];
  skipped: string[];
}

export function customItemKey(filePath: string): string {
  return path.resolve(filePath).toLowerCase();
}

export function describeCustomItem(filePath: string): CustomItemInfo {
  const resolved = path.resolve(filePath);
  const extension = path.extname(resolved).toLowerCase();
  let exists = false;
  let isDirectory = false;
  let isFile = false;
  try {
    const stats = statSync(resolved);
    exists = true;
    isDirectory = stats.isDirectory();
    isFile = stats.isFile();
  } catch {
    // Missing entries remain visible so the user can remove stale paths.
  }
  const kind: CustomItemKind = isDirectory
    ? "directory"
    : LAUNCHABLE_EXTENSIONS.has(extension)
      ? "application"
      : "file";
  const name = path.basename(
    resolved,
    kind === "application" || (isFile && extension) ? extension : undefined,
  );
  return { name, path: resolved, kind, exists };
}

export function describeCustomItems(items: string[]): CustomItemInfo[] {
  return items.map(describeCustomItem);
}

export function mergeCustomItems(
  current: string[],
  candidates: string[],
  options: MergeCustomItemOptions = { applications: true, directories: true },
): MergeCustomItemResult {
  const paths = current.slice();
  const seen = new Set(current.map(customItemKey));
  const added: CustomItemInfo[] = [];
  const skipped: string[] = [];

  for (const raw of candidates) {
    const value = typeof raw === "string" ? raw.trim() : "";
    if (!value) continue;
    const resolved = path.resolve(value);
    let isDirectory = false;
    let isFile = false;
    try {
      const stats = statSync(resolved);
      isDirectory = stats.isDirectory();
      isFile = stats.isFile();
    } catch {
      skipped.push(resolved);
      continue;
    }
    const isApplication =
      isFile && LAUNCHABLE_EXTENSIONS.has(path.extname(resolved).toLowerCase());
    const accepted =
      (options.applications === true && isApplication) ||
      (options.directories === true && isDirectory);
    const key = customItemKey(resolved);
    if (!accepted || seen.has(key)) {
      skipped.push(resolved);
      continue;
    }
    seen.add(key);
    paths.push(resolved);
    added.push(describeCustomItem(resolved));
  }

  return { paths, added, skipped };
}

export function removeCustomItem(items: string[], target: string): string[] {
  const targetKey = customItemKey(target);
  return items.filter((item) => customItemKey(item) !== targetKey);
}
