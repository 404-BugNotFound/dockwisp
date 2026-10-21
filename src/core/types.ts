export type CommandType =
  | "base"
  | "regex"
  | "over"
  | "files"
  | "img"
  | "window";

export interface FileInput {
  path: string;
  name: string;
  isFile: boolean;
  isDirectory: boolean;
}

export interface WindowInput {
  app: string;
  title: string;
  appPath?: string;
}

export type SearchInput =
  | { type: "text"; data: string }
  | { type: "files"; data: FileInput[] }
  | { type: "img"; data: string }
  | { type: "window"; data: WindowInput };

export interface RawCommand {
  type?: string;
  label?: string;
  match?: string | { app?: string[]; title?: string };
  exclude?: string;
  minLength?: number;
  maxLength?: number;
  fileType?: "file" | "directory";
  extensions?: string[];
  weight?: number;
}

export interface RawFeature {
  code: string;
  description?: string;
  explain?: string;
  icon?: string;
  mainHide?: boolean;
  cmds: Array<string | RawCommand>;
}

export interface PluginManifest {
  name: string;
  pluginName: string;
  version: string;
  main: string;
  preload?: string;
  logo?: string;
  features: RawFeature[];
}

export interface LoadedPlugin {
  id: string;
  directory: string;
  mainPath: string;
  preloadPath?: string;
  manifest: PluginManifest;
}

export interface SearchForms {
  searchText: string;
  tokens: string[];
  pinyin: string;
  initials: string;
}

export interface NormalizedCommand {
  id: string;
  pluginId: string;
  pluginName: string;
  featureCode: string;
  featureDescription: string;
  featureMainHide: boolean;
  type: CommandType;
  label: string;
  match?: string;
  exclude?: string;
  minLength?: number;
  maxLength?: number;
  fileType?: "file" | "directory";
  extensions?: string[];
  windowApps?: string[];
  windowTitle?: string;
  weight: number;
  iconPath?: string;
  searchText: string;
  tokens: string[];
  pinyin: string;
  initials: string;
}

export interface CommandMatch {
  id: string;
  kind: "plugin";
  title: string;
  subtitle: string;
  score: number;
  pluginId: string;
  featureCode: string;
  commandType: CommandType;
  payload: SearchInput;
  iconPath?: string;
  mainHide: boolean;
  pinned?: boolean;
  iconUrl?: string;
}

export interface AppEntry {
  id: string;
  name: string;
  path: string;
  source: "start-menu" | "desktop" | "custom" | "start-apps";
  isApp: boolean;
  /** Absolute path to a pre-resolved icon (used by Start Apps entries). */
  iconPath?: string;
  searchText: string;
  tokens: string[];
  pinyin: string;
  initials: string;
}

export interface AppMatch {
  id: string;
  kind: "app";
  title: string;
  subtitle: string;
  score: number;
  path: string;
  pinned?: boolean;
  iconUrl?: string;
  iconPath?: string;
}

export interface FileMatch {
  id: string;
  kind: "file";
  title: string;
  subtitle: string;
  score: number;
  path: string;
  pinned?: boolean;
  iconUrl?: string;
}

export interface BuiltinMatch {
  id: string;
  kind: "builtin";
  action:
    | "translate"
    | "settings"
    | "file-search"
    | "copy"
    | "info"
    | "file-indexing"
    | "system"
    | "focus-window"
    | "window-search"
    | "screenshot"
    | "plugins"
    | "hosts"
    | "diff"
    | "convert"
    | "translate-window"
    | "convert-to";
  title: string;
  subtitle: string;
  score: number;
  payload?: string;
  pinned?: boolean;
  iconUrl?: string;
}

export type SearchMatch = CommandMatch | AppMatch | BuiltinMatch | FileMatch;

/**
 * A cleaned, serialisable snapshot of a pinned match. Stored in settings; the
 * volatile fields (score/pinned/iconUrl) are stripped and re-derived when the
 * home page is rebuilt.
 */
export interface PinnedMatch {
  id: string;
  kind: SearchMatch["kind"];
  title: string;
  subtitle: string;
  path?: string;
  pluginId?: string;
  featureCode?: string;
  commandType?: CommandType;
  payload?: SearchInput | string;
  iconPath?: string;
  mainHide?: boolean;
  action?: BuiltinMatch["action"];
}
