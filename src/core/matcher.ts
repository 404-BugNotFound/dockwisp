import path from "node:path";
import vm from "node:vm";
import { pinyin } from "pinyin-pro";
import {
  AppEntry,
  AppMatch,
  CommandMatch,
  CommandType,
  LoadedPlugin,
  NormalizedCommand,
  RawCommand,
  SearchForms,
  SearchInput,
  SearchMatch,
  WindowInput,
} from "./types";

const SUPPORTED_TYPES = new Set<CommandType>([
  "base",
  "regex",
  "over",
  "files",
  "img",
  "window",
]);

/**
 * Split a label into lowercase search tokens on spaces, dashes, underscores,
 * dots and CamelCase boundaries so that "HiBitUninstaller-Portable" yields
 * ["hibituninstaller-portable" via searchText] plus tokens hi/bit/uninstaller/portable.
 */
export function tokenize(value: string): string[] {
  const tokens = new Set<string>();
  for (const part of value.split(/[\s\-_.]+/)) {
    if (!part) continue;
    const spaced = part
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
    for (const piece of spaced.split(/\s+/)) {
      const token = piece.toLowerCase();
      if (token) tokens.add(token);
    }
  }
  return [...tokens];
}

export function buildSearchForms(value: string): SearchForms {
  const searchText = value.trim().toLowerCase();
  if (!searchText) return { searchText: "", tokens: [], pinyin: "", initials: "" };
  const syllables = pinyin(value, {
    toneType: "none",
    type: "array",
    nonZh: "consecutive",
  }).map((item) => item.toLowerCase());
  return {
    searchText,
    tokens: tokenize(value),
    pinyin: syllables.join(""),
    initials: syllables.map((item) => item[0] ?? "").join(""),
  };
}

function commandType(command: RawCommand): CommandType | null {
  const type = (command.type ?? "base") as CommandType;
  return SUPPORTED_TYPES.has(type) ? type : null;
}

export function normalizePluginCommands(plugin: LoadedPlugin): NormalizedCommand[] {
  const commands: NormalizedCommand[] = [];
  for (const feature of plugin.manifest.features) {
    feature.cmds.forEach((raw, index) => {
      const source: RawCommand = typeof raw === "string" ? { label: raw } : raw;
      const type = commandType(source);
      if (!type) return;
      const label = (source.label || feature.description || feature.code).trim();
      const match =
        typeof source.match === "string"
          ? source.match
          : type === "base"
            ? label.toLowerCase()
            : undefined;
      const forms = buildSearchForms(
        `${label} ${feature.description ?? ""} ${plugin.manifest.pluginName}`,
      );
      const windowMatch =
        type === "window" && source.match && typeof source.match === "object"
          ? source.match
          : undefined;
      commands.push({
        id: `${plugin.id}:${feature.code}:${index}`,
        pluginId: plugin.id,
        pluginName: plugin.manifest.pluginName,
        featureCode: feature.code,
        featureDescription: feature.description ?? label,
        featureMainHide: feature.mainHide === true,
        type,
        label,
        match,
        exclude: source.exclude,
        minLength: source.minLength,
        maxLength: source.maxLength,
        fileType: source.fileType,
        extensions: source.extensions?.map((item) => item.toLowerCase()),
        windowApps: windowMatch?.app,
        windowTitle: windowMatch?.title,
        weight: Number.isFinite(source.weight) ? Number(source.weight) : 0,
        iconPath: feature.icon
          ? path.resolve(plugin.directory, feature.icon)
          : plugin.manifest.logo
            ? path.resolve(plugin.directory, plugin.manifest.logo)
            : undefined,
        ...forms,
      });
    });
  }
  return commands;
}

function subsequenceScore(query: string, target: string): number {
  if (!query || !target) return -1;
  let cursor = 0;
  let gaps = 0;
  for (const character of query) {
    const index = target.indexOf(character, cursor);
    if (index < 0) return -1;
    gaps += index - cursor;
    cursor = index + 1;
  }
  return Math.max(1, 450 - gaps * 3 - (target.length - query.length));
}

/**
 * Score a lowercase query against an entry's search forms. Higher is a stronger
 * match. Tiers, strongest first: exact, name startsWith, token exact, token
 * startsWith, word-boundary substring, substring, pinyin startsWith, initials
 * startsWith, subsequence.
 */
export function scoreQuery(
  query: string,
  entry: Pick<AppEntry, "searchText" | "tokens" | "pinyin" | "initials">,
): number {
  if (!query) return 0;
  if (entry.searchText === query) return 1200;
  if (entry.searchText.startsWith(query)) return 1000 - entry.searchText.length;
  const tokens = entry.tokens ?? [];
  if (tokens.includes(query)) return 980;
  if (tokens.some((token) => token.startsWith(query))) return 900;
  const boundary = entry.searchText.match(/[\s\-_.]+/) ? entry.searchText.split(/[\s\-_.]+/) : [];
  if (boundary.some((part) => part.startsWith(query) && part !== entry.searchText)) return 820;
  const textIndex = entry.searchText.indexOf(query);
  if (textIndex >= 0) return 700 - textIndex;
  if (entry.pinyin.startsWith(query)) return 620 - entry.pinyin.length;
  if (entry.initials.startsWith(query)) return 600 - entry.initials.length;
  return Math.max(
    subsequenceScore(query, entry.searchText),
    subsequenceScore(query, entry.pinyin),
    subsequenceScore(query, entry.initials),
  );
}

function parseRegex(value: string | undefined): RegExp | null {
  if (!value) return null;
  const slash = value.match(/^\/(.*)\/([dgimsuvy]*)$/s);
  try {
    return slash ? new RegExp(slash[1], slash[2]) : new RegExp(value);
  } catch {
    return null;
  }
}

function safeRegexTest(pattern: string | undefined, input: string): boolean {
  const regex = parseRegex(pattern);
  if (!regex || input.length > 10_000) return false;
  try {
    return vm.runInNewContext("regex.test(input)", { regex, input }, { timeout: 25 }) === true;
  } catch {
    return false;
  }
}

function withinLength(command: NormalizedCommand, length: number): boolean {
  return !(
    (command.minLength !== undefined && length < command.minLength) ||
    (command.maxLength !== undefined && length > command.maxLength)
  );
}

function matchesWindow(command: NormalizedCommand, input: WindowInput): boolean {
  if (command.windowApps?.length) {
    const app = input.app.toLowerCase();
    if (!command.windowApps.some((item) => item.toLowerCase() === app)) return false;
  }
  return !command.windowTitle || safeRegexTest(command.windowTitle, input.title);
}

function dataCommandScore(command: NormalizedCommand, input: SearchInput): number {
  if (input.type === "text") {
    if (!withinLength(command, input.data.length)) return -1;
    if (command.type === "regex") return safeRegexTest(command.match, input.data) ? 930 : -1;
    if (command.type === "over") {
      return !command.exclude || !safeRegexTest(command.exclude, input.data) ? 320 : -1;
    }
    return -1;
  }
  if (input.type === "img") return command.type === "img" ? 800 : -1;
  if (input.type === "window") {
    return command.type === "window" && matchesWindow(command, input.data) ? 760 : -1;
  }
  if (command.type !== "files" || !withinLength(command, input.data.length)) return -1;
  for (const file of input.data) {
    if (command.fileType === "file" && !file.isFile) return -1;
    if (command.fileType === "directory" && !file.isDirectory) return -1;
    if (command.extensions?.length && file.isFile) {
      const extension = path.extname(file.name).slice(1).toLowerCase();
      if (!command.extensions.includes(extension)) return -1;
    }
    if (command.match && !safeRegexTest(command.match, file.name)) return -1;
  }
  return 800;
}

function asCommandMatch(
  command: NormalizedCommand,
  input: SearchInput,
  score: number,
): CommandMatch {
  return {
    id: command.id,
    kind: "plugin",
    title: command.label,
    subtitle: `${command.pluginName} · ${command.featureDescription}`,
    score: score + command.weight,
    pluginId: command.pluginId,
    featureCode: command.featureCode,
    commandType: command.type,
    payload: input,
    iconPath: command.iconPath,
    mainHide: command.featureMainHide,
  };
}

export function searchCommands(
  commands: NormalizedCommand[],
  input: SearchInput,
  limit = 30,
): CommandMatch[] {
  const matches: CommandMatch[] = [];
  const query = input.type === "text" ? input.data.trim().toLowerCase() : "";
  for (const command of commands) {
    if (command.type === "base" && input.type === "text") {
      // An empty text query must not dump every base command onto the home page.
      if (!query) continue;
      const score = scoreQuery(query, command);
      if (score > 0) matches.push(asCommandMatch(command, input, score));
      continue;
    }
    const score = dataCommandScore(command, input);
    if (score >= 0) matches.push(asCommandMatch(command, input, score));
  }
  return matches.sort((left, right) => right.score - left.score).slice(0, limit);
}

const CUSTOM_APP_BOOST = 350;
const PINNED_APP_BOOST = 250;

export function searchApps(
  apps: AppEntry[],
  queryText: string,
  options: { limit?: number; pinnedPaths?: Set<string> } = {},
): AppMatch[] {
  const { limit = 20, pinnedPaths } = options;
  const query = queryText.trim().toLowerCase();
  if (!query) return [];
  const pinned = pinnedPaths ?? new Set<string>();
  return apps
    .filter((entry) => entry.isApp)
    .map((entry) => {
      const base = scoreQuery(query, entry);
      if (base < 0) return null;
      const isPinned = pinned.has(entry.path.toLowerCase());
      const boost =
        (entry.source === "custom" ? CUSTOM_APP_BOOST : 0) + (isPinned ? PINNED_APP_BOOST : 0);
      return { entry, score: base + boost, isPinned };
    })
    .filter((item): item is { entry: AppEntry; score: number; isPinned: boolean } => item !== null)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map(({ entry, score, isPinned }) => ({
      id: entry.id,
      kind: "app" as const,
      title: entry.name,
      subtitle: entry.source === "custom" ? "自定义应用" : "应用程序",
      score,
      path: entry.path,
      pinned: isPinned,
      ...(entry.iconPath ? { iconPath: entry.iconPath } : {}),
    }));
}

const NOISY_PATH_SEGMENTS = [
  "\\windows\\",
  "\\winsxs\\",
  "\\$recycle.bin\\",
  "\\appdata\\local\\temp\\",
  "\\node_modules\\",
  "\\.git\\",
  "\\__pycache__\\",
];

const NOISY_EXTENSIONS = new Set([".pf", ".pyc"]);

/** Reject system/cache paths and noise extensions from file-search results. */
export function isNoisyPath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  if (NOISY_PATH_SEGMENTS.some((segment) => lower.includes(segment))) return true;
  return NOISY_EXTENSIONS.has(path.extname(lower));
}

const EXECUTABLE_EXTENSIONS = new Set([".exe", ".lnk", ".url", ".appref-ms"]);

/** Rank raw Everything/index file paths by basename relevance to the query. */
export function rankFilePaths(
  paths: string[],
  queryText: string,
  limit = Number.POSITIVE_INFINITY,
): Array<{ path: string; title: string; score: number }> {
  const query = queryText.trim().toLowerCase();
  const seen = new Set<string>();
  const scored: Array<{ path: string; title: string; score: number }> = [];
  for (const filePath of paths) {
    if (!filePath) continue;
    const key = filePath.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const basename = path.basename(filePath);
    // File ranking is deliberately pinyin-free: Everything can return hundreds
    // of candidates and building pinyin forms for each one is far too expensive.
    const score = query
      ? scoreQuery(query, {
          searchText: basename.toLowerCase(),
          tokens: tokenize(basename),
          pinyin: "",
          initials: "",
        })
      : 0;
    const extension = path.extname(basename).toLowerCase();
    const executableBoost = EXECUTABLE_EXTENSIONS.has(extension) ? 100 : 0;
    scored.push({
      path: filePath,
      title: basename,
      score: Math.max(0, score) + executableBoost,
    });
  }
  return scored
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.title.length - right.title.length ||
        left.title.localeCompare(right.title),
    )
    .slice(0, limit);
}

export function mergeMatches(groups: SearchMatch[][], limit = 30): SearchMatch[] {
  return groups
    .flat()
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.title.length - right.title.length ||
        left.title.localeCompare(right.title),
    )
    .slice(0, limit);
}
