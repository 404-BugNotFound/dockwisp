import { createHash, randomUUID } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { loadPluginFromDirectory } from "../core/manifest";

const MAX_PACKAGE_BYTES = 128 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 768 * 1024 * 1024;
const MAX_ENTRIES = 25_000;

export interface InstalledPluginPackage {
  id: string;
  pluginName: string;
  version: string;
  directory: string;
}

interface ArchiveNode {
  files?: Record<string, ArchiveNode>;
  size?: number;
  link?: string;
  unpacked?: boolean;
}

class ByteLimitTransform extends Transform {
  private bytes = 0;

  constructor(private readonly maximum: number) {
    super();
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null, data?: Buffer) => void,
  ): void {
    this.bytes += chunk.length;
    if (this.bytes > this.maximum) {
      callback(new Error(`解压后的插件包超过 ${Math.round(this.maximum / 1024 / 1024)} MiB 限制`));
      return;
    }
    callback(null, chunk);
  }
}

function validateArchivePath(entry: string): void {
  const normalized = entry.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("\0") || path.posix.isAbsolute(normalized)) {
    throw new Error(`插件包包含无效路径: ${entry}`);
  }
  if (normalized.split("/").some((part) => part === ".." || part === "")) {
    throw new Error(`插件包路径越界: ${entry}`);
  }
  if (/^[a-zA-Z]:/.test(normalized)) throw new Error(`插件包包含绝对路径: ${entry}`);
}

function inspectHeader(node: ArchiveNode): { entries: number; bytes: number } {
  let entries = 0;
  let bytes = 0;
  const walk = (current: ArchiveNode): void => {
    for (const child of Object.values(current.files ?? {})) {
      entries += 1;
      if (entries > MAX_ENTRIES) throw new Error(`插件包文件数超过 ${MAX_ENTRIES} 限制`);
      if (child.link) throw new Error("插件包包含符号链接，已拒绝安装");
      if (child.unpacked) throw new Error("离线插件包包含外置文件引用，已拒绝安装");
      if (typeof child.size === "number") {
        bytes += child.size;
        if (bytes > MAX_EXTRACTED_BYTES) throw new Error("插件包展开体积超过安全限制");
      }
      walk(child);
    }
  };
  walk(node);
  return { entries, bytes };
}

function targetName(pluginId: string): string {
  const readable = pluginId.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  const digest = createHash("sha256").update(pluginId).digest("hex").slice(0, 10);
  return `${readable.slice(0, 48) || "plugin"}-${digest}`;
}

export class PluginPackageInstaller {
  constructor(private readonly pluginRoot: string) {
    mkdirSync(pluginRoot, { recursive: true });
  }

  async install(packagePath: string): Promise<InstalledPluginPackage> {
    const extension = path.extname(packagePath).toLowerCase();
    if (extension !== ".upx" && extension !== ".upxs") {
      throw new Error("仅支持 .upx 或 .upxs 离线插件包");
    }
    const stats = statSync(packagePath);
    if (!stats.isFile() || stats.size > MAX_PACKAGE_BYTES) {
      throw new Error("插件包不存在或超过 128 MiB 限制");
    }

    const workRoot = path.join(this.pluginRoot, `.install-${randomUUID()}`);
    const archivePath = path.join(workRoot, "plugin.asar");
    const extractedPath = path.join(workRoot, "extracted");
    mkdirSync(workRoot, { recursive: true });
    try {
      await pipeline(
        createReadStream(packagePath),
        createGunzip(),
        new ByteLimitTransform(MAX_ARCHIVE_BYTES),
        createWriteStream(archivePath, { flags: "wx" }),
      );

      const asar = await import("@electron/asar");
      const entries = asar.listPackage(archivePath, { isPack: false });
      if (entries.length > MAX_ENTRIES) throw new Error("插件包文件数超过安全限制");
      entries.forEach(validateArchivePath);
      if (!entries.some((entry) => entry.replace(/\\/g, "/").replace(/^\/+/, "") === "plugin.json")) {
        throw new Error("插件包根目录缺少 plugin.json");
      }
      inspectHeader(asar.getRawHeader(archivePath).header as ArchiveNode);

      mkdirSync(extractedPath, { recursive: true });
      asar.extractAll(archivePath, extractedPath);
      const plugin = loadPluginFromDirectory(extractedPath);
      const destination = path.join(this.pluginRoot, targetName(plugin.id));
      if (existsSync(destination)) {
        throw new Error(`插件 ${plugin.manifest.pluginName} 已安装；为避免覆盖，请先移除旧版本`);
      }
      renameSync(extractedPath, destination);
      return {
        id: plugin.id,
        pluginName: plugin.manifest.pluginName,
        version: plugin.manifest.version,
        directory: destination,
      };
    } catch (error) {
      if (error instanceof Error && /incorrect header check|unexpected end of file/i.test(error.message)) {
        throw new Error("插件包不是受支持的 gzip-ASAR 格式，或文件已损坏");
      }
      throw error;
    } finally {
      rmSync(workRoot, { recursive: true, force: true });
    }
  }
}
