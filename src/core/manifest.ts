import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  LoadedPlugin,
  PluginManifest,
  RawCommand,
  RawFeature,
} from "./types";

export class ManifestError extends Error {}

function assertString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ManifestError(`${field} 必须是非空字符串`);
  }
}

function resolveInside(directory: string, relativePath: string, field: string): string {
  const root = path.resolve(directory);
  const resolved = path.resolve(root, relativePath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new ManifestError(`${field} 不能离开插件目录`);
  }
  return resolved;
}

function parseCommands(value: unknown, featureCode: string): Array<string | RawCommand> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ManifestError(`feature ${featureCode} 至少需要一个 cmds 项`);
  }
  return value.map((command, index) => {
    if (typeof command === "string") {
      assertString(command, `feature ${featureCode}.cmds[${index}]`);
      return command;
    }
    if (!command || typeof command !== "object" || Array.isArray(command)) {
      throw new ManifestError(`feature ${featureCode}.cmds[${index}] 格式无效`);
    }
    const raw = command as RawCommand;
    if (raw.type !== undefined && typeof raw.type !== "string") {
      throw new ManifestError(`feature ${featureCode}.cmds[${index}].type 格式无效`);
    }
    if (raw.label !== undefined && typeof raw.label !== "string") {
      throw new ManifestError(`feature ${featureCode}.cmds[${index}].label 格式无效`);
    }
    return raw;
  });
}

export function parsePluginManifest(
  raw: unknown,
  directory: string,
): LoadedPlugin {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ManifestError("plugin.json 根节点必须是对象");
  }
  const source = raw as Record<string, unknown>;
  assertString(source.name, "name");
  assertString(source.pluginName, "pluginName");
  assertString(source.main, "main");
  const version = typeof source.version === "string" ? source.version : "0.0.0";
  const featuresSource = source.features;
  if (!Array.isArray(featuresSource)) {
    throw new ManifestError("features 必须是数组");
  }
  const seenCodes = new Set<string>();
  const features: RawFeature[] = featuresSource.map((feature, index) => {
    if (!feature || typeof feature !== "object" || Array.isArray(feature)) {
      throw new ManifestError(`features[${index}] 必须是对象`);
    }
    const item = feature as Record<string, unknown>;
    assertString(item.code, `features[${index}].code`);
    if (seenCodes.has(item.code)) {
      throw new ManifestError(`重复的 feature code: ${item.code}`);
    }
    seenCodes.add(item.code);
    const icon = typeof item.icon === "string" ? item.icon : undefined;
    if (icon) resolveInside(directory, icon, `features[${index}].icon`);
    return {
      code: item.code,
      description:
        typeof item.description === "string" ? item.description : undefined,
      explain: typeof item.explain === "string" ? item.explain : undefined,
      icon,
      mainHide: item.mainHide === true,
      cmds: parseCommands(item.cmds, item.code),
    };
  });

  const mainPath = resolveInside(directory, source.main, "main");
  if (!existsSync(mainPath)) {
    throw new ManifestError(`插件入口不存在: ${source.main}`);
  }
  let preloadPath: string | undefined;
  if (typeof source.preload === "string" && source.preload.trim()) {
    preloadPath = resolveInside(directory, source.preload, "preload");
    if (!existsSync(preloadPath)) {
      throw new ManifestError(`插件 preload 不存在: ${source.preload}`);
    }
  }
  const logo = typeof source.logo === "string" ? source.logo : undefined;
  if (logo) resolveInside(directory, logo, "logo");
  const manifest: PluginManifest = {
    name: source.name,
    pluginName: source.pluginName,
    version,
    main: source.main,
    preload: typeof source.preload === "string" ? source.preload : undefined,
    logo,
    features,
  };
  return {
    id: manifest.name,
    directory: path.resolve(directory),
    mainPath,
    preloadPath,
    manifest,
  };
}

export function loadPluginFromDirectory(directory: string): LoadedPlugin {
  const manifestPath = path.join(directory, "plugin.json");
  if (!existsSync(manifestPath)) {
    throw new ManifestError(`缺少 plugin.json: ${directory}`);
  }
  const raw = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
  return parsePluginManifest(raw, directory);
}
