import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CommandType, PinnedMatch, SearchInput } from "../core/types";

export interface TranslationSettings {
  provider: "mymemory" | "libretranslate";
  endpoint: string;
  apiKey: string;
}

export type ThemePreference = "system" | "light" | "dark";

export interface AppSettings {
  hotkey: string;
  screenshotHotkey: string;
  launchAtLogin: boolean;
  longPressMs: number;
  translationEnabled: boolean;
  translation: TranslationSettings;
  processBlacklist: string[];
  pluginDirectories: string[];
  customLaunchItems: string[];
  pinnedMatches: PinnedMatch[];
  theme: ThemePreference;
  launcherPosition: { x: number; y: number } | null;
  windowDragEnabled: boolean;
  panelTransparency: number;
}

export const DEFAULT_SETTINGS: AppSettings = {
  hotkey: "Alt+Space",
  screenshotHotkey: "Alt+Shift+S",
  launchAtLogin: false,
  longPressMs: 550,
  translationEnabled: true,
  translation: {
    provider: "mymemory",
    endpoint: "https://api.mymemory.translated.net/get",
    apiKey: "",
  },
  processBlacklist: [],
  pluginDirectories: [],
  customLaunchItems: [],
  pinnedMatches: [],
  theme: "system",
  launcherPosition: null,
  windowDragEnabled: true,
  panelTransparency: 12,
};

const THEME_VALUES = new Set<ThemePreference>(["system", "light", "dark"]);

const PINNED_KINDS = new Set<PinnedMatch["kind"]>(["app", "plugin", "builtin", "file"]);
const PINNED_LIMIT = 50;

function normalizePinnedMatch(value: unknown): PinnedMatch | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || typeof raw.kind !== "string") return null;
  if (!PINNED_KINDS.has(raw.kind as PinnedMatch["kind"])) return null;
  const match: PinnedMatch = {
    id: raw.id,
    kind: raw.kind as PinnedMatch["kind"],
    title: typeof raw.title === "string" ? raw.title : "",
    subtitle: typeof raw.subtitle === "string" ? raw.subtitle : "",
  };
  if (typeof raw.path === "string") match.path = raw.path;
  if (typeof raw.pluginId === "string") match.pluginId = raw.pluginId;
  if (typeof raw.featureCode === "string") match.featureCode = raw.featureCode;
  if (typeof raw.commandType === "string") match.commandType = raw.commandType as CommandType;
  if (typeof raw.iconPath === "string") match.iconPath = raw.iconPath;
  if (typeof raw.mainHide === "boolean") match.mainHide = raw.mainHide;
  if (typeof raw.action === "string") match.action = raw.action as PinnedMatch["action"];
  if (typeof raw.payload === "string") match.payload = raw.payload;
  else if (raw.payload && typeof raw.payload === "object") match.payload = raw.payload as SearchInput;
  return match;
}

function normalizePinnedMatches(value: unknown): PinnedMatch[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: PinnedMatch[] = [];
  for (const item of value) {
    const match = normalizePinnedMatch(item);
    if (!match || seen.has(match.id)) continue;
    seen.add(match.id);
    result.push(match);
    if (result.length >= PINNED_LIMIT) break;
  }
  return result;
}

const POSITION_LIMIT = 100_000;

/** Accept only a pair of finite, bounded integers; anything else becomes null. */
function normalizeLauncherPosition(value: unknown): { x: number; y: number } | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { x?: unknown; y?: unknown };
  if (typeof raw.x !== "number" || typeof raw.y !== "number") return null;
  if (!Number.isFinite(raw.x) || !Number.isFinite(raw.y)) return null;
  if (Math.abs(raw.x) > POSITION_LIMIT || Math.abs(raw.y) > POSITION_LIMIT) return null;
  return { x: Math.round(raw.x), y: Math.round(raw.y) };
}

function normalizeSettings(value: Partial<AppSettings>): AppSettings {
  const translation = value.translation ?? DEFAULT_SETTINGS.translation;
  return {
    hotkey:
      typeof value.hotkey === "string" && value.hotkey.trim()
        ? value.hotkey.trim()
        : DEFAULT_SETTINGS.hotkey,
    screenshotHotkey:
      typeof value.screenshotHotkey === "string" && value.screenshotHotkey.trim()
        ? value.screenshotHotkey.trim()
        : DEFAULT_SETTINGS.screenshotHotkey,
    launchAtLogin: value.launchAtLogin === true,
    longPressMs:
      typeof value.longPressMs === "number"
        ? Math.min(3_000, Math.max(250, Math.round(value.longPressMs)))
        : DEFAULT_SETTINGS.longPressMs,
    translationEnabled: value.translationEnabled !== false,
    translation: {
      provider:
        translation.provider === "libretranslate" ? "libretranslate" : "mymemory",
      endpoint:
        typeof translation.endpoint === "string" && translation.endpoint.trim()
          ? translation.endpoint.trim()
          : DEFAULT_SETTINGS.translation.endpoint,
      apiKey: typeof translation.apiKey === "string" ? translation.apiKey.trim() : "",
    },
    processBlacklist: Array.isArray(value.processBlacklist)
      ? value.processBlacklist.filter((item): item is string => typeof item === "string")
      : [],
    pluginDirectories: Array.isArray(value.pluginDirectories)
      ? value.pluginDirectories.filter((item): item is string => typeof item === "string")
      : [],
    customLaunchItems: Array.isArray(value.customLaunchItems)
      ? value.customLaunchItems.filter((item): item is string => typeof item === "string")
      : [],
    pinnedMatches: normalizePinnedMatches(value.pinnedMatches),
    theme:
      typeof value.theme === "string" && THEME_VALUES.has(value.theme as ThemePreference)
        ? (value.theme as ThemePreference)
        : DEFAULT_SETTINGS.theme,
    launcherPosition: normalizeLauncherPosition(value.launcherPosition),
    windowDragEnabled: value.windowDragEnabled !== false,
    panelTransparency:
      typeof value.panelTransparency === "number" && Number.isFinite(value.panelTransparency)
        ? Math.min(40, Math.max(0, Math.round(value.panelTransparency)))
        : DEFAULT_SETTINGS.panelTransparency,
  };
}

export class SettingsStore {
  readonly filePath: string;
  private value: AppSettings;

  constructor(userDataDirectory: string) {
    mkdirSync(userDataDirectory, { recursive: true });
    this.filePath = path.join(userDataDirectory, "settings.json");
    this.value = this.read();
  }

  get(): AppSettings {
    return structuredClone(this.value);
  }

  update(patch: Partial<AppSettings>): AppSettings {
    this.value = normalizeSettings({
      ...this.value,
      ...patch,
      translation: patch.translation
        ? { ...this.value.translation, ...patch.translation }
        : this.value.translation,
    });
    this.write();
    return this.get();
  }

  private read(): AppSettings {
    if (!existsSync(this.filePath)) return structuredClone(DEFAULT_SETTINGS);
    try {
      return normalizeSettings(JSON.parse(readFileSync(this.filePath, "utf8")));
    } catch {
      return structuredClone(DEFAULT_SETTINGS);
    }
  }

  private write(): void {
    const temporary = `${this.filePath}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.value, null, 2)}\n`, "utf8");
    renameSync(temporary, this.filePath);
  }
}
