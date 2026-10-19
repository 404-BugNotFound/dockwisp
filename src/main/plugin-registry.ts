import { EventEmitter } from "node:events";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { loadPluginFromDirectory, ManifestError } from "../core/manifest";
import { normalizePluginCommands } from "../core/matcher";
import { LoadedPlugin, NormalizedCommand, RawFeature } from "../core/types";

export interface PluginLoadError {
  directory: string;
  message: string;
}

export class PluginRegistry extends EventEmitter {
  private readonly roots: string[];
  private readonly plugins = new Map<string, LoadedPlugin>();
  private readonly dynamicFeatures = new Map<string, Map<string, RawFeature>>();
  private errors: PluginLoadError[] = [];

  constructor(roots: string[]) {
    super();
    this.roots = [...new Set(roots.map((item) => path.resolve(item)))];
  }

  addRoot(root: string): void {
    const resolved = path.resolve(root);
    if (!this.roots.includes(resolved)) this.roots.push(resolved);
    this.reload();
  }

  reload(): void {
    this.plugins.clear();
    this.errors = [];
    for (const root of this.roots) {
      if (!existsSync(root)) continue;
      let candidates: string[];
      try {
        candidates = existsSync(path.join(root, "plugin.json"))
          ? [root]
          : readdirSync(root, { withFileTypes: true })
              .filter((entry) => entry.isDirectory())
              .map((entry) => path.join(root, entry.name));
      } catch (error) {
        this.errors.push({
          directory: root,
          message: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      for (const directory of candidates) {
        try {
          const plugin = loadPluginFromDirectory(directory);
          if (!this.plugins.has(plugin.id)) this.plugins.set(plugin.id, plugin);
        } catch (error) {
          this.errors.push({
            directory,
            message: error instanceof ManifestError || error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    this.emit("changed");
  }

  list(): LoadedPlugin[] {
    return [...this.plugins.values()];
  }

  get(pluginId: string): LoadedPlugin | undefined {
    return this.plugins.get(pluginId);
  }

  getErrors(): PluginLoadError[] {
    return [...this.errors];
  }

  getCommands(): NormalizedCommand[] {
    const commands: NormalizedCommand[] = [];
    for (const plugin of this.plugins.values()) {
      const dynamic = this.dynamicFeatures.get(plugin.id);
      const effective = dynamic?.size
        ? {
            ...plugin,
            manifest: {
              ...plugin.manifest,
              features: [
                ...plugin.manifest.features.filter((feature) => !dynamic.has(feature.code)),
                ...dynamic.values(),
              ],
            },
          }
        : plugin;
      commands.push(...normalizePluginCommands(effective));
    }
    return commands;
  }

  setFeature(pluginId: string, feature: RawFeature): boolean {
    if (!this.plugins.has(pluginId) || !feature || typeof feature.code !== "string") return false;
    let features = this.dynamicFeatures.get(pluginId);
    if (!features) {
      features = new Map();
      this.dynamicFeatures.set(pluginId, features);
    }
    features.set(feature.code, structuredClone(feature));
    this.emit("changed");
    return true;
  }

  removeFeature(pluginId: string, featureCode: string): boolean {
    const removed = this.dynamicFeatures.get(pluginId)?.delete(featureCode) ?? false;
    if (removed) this.emit("changed");
    return removed;
  }

  getFeatures(pluginId: string): RawFeature[] {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) return [];
    const dynamic = this.dynamicFeatures.get(pluginId);
    return [
      ...plugin.manifest.features.filter((feature) => !dynamic?.has(feature.code)),
      ...(dynamic?.values() ?? []),
    ].map((feature) => structuredClone(feature));
  }
}
