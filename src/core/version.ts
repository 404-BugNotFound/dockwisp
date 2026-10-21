// 纯函数模块：语义化版本比较与 GitHub Release JSON 解析。
// 不得 import electron 或任何带副作用的运行时依赖，便于单元测试。

export interface ReleaseAsset {
  name: string;
  size?: number;
  browser_download_url?: string;
  // GitHub 资产的摘要字段，形如 "sha256:<hex>"；旧版本可能缺失。
  digest?: string | null;
}

export interface ReleaseJson {
  tag_name?: string;
  name?: string;
  body?: string | null;
  published_at?: string | null;
  html_url?: string | null;
  draft?: boolean;
  prerelease?: boolean;
  assets?: ReleaseAsset[];
}

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  // 预发布标识（如 beta.1），用于粗略比较；正式版排在预发布之后。
  prerelease: string[];
}

export interface SelectedAsset {
  name: string;
  size: number | null;
  downloadUrl: string;
  // 规范化后的 sha256 十六进制（小写），无摘要时为 null。
  sha256: string | null;
}

export type UpdateStatus = "latest" | "available" | "error";

export interface UpdateInfo {
  status: UpdateStatus;
  current: string;
  latest?: string;
  notes?: string;
  publishedAt?: string;
  size?: number;
  downloadUrl?: string;
  assetName?: string;
  sha256?: string | null;
  // true 表示资产缺少摘要，下载后无法做完整性校验。
  digestMissing?: boolean;
  htmlUrl?: string;
  message?: string;
}

const VERSION_PATTERN = /^\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+](.+))?\s*$/;

/**
 * 解析版本字符串，容忍前导 "v"、缺省的 minor/patch 以及预发布/构建后缀。
 * 无法解析时返回 null。
 */
export function parseVersion(input: unknown): ParsedVersion | null {
  if (typeof input !== "string") return null;
  const match = VERSION_PATTERN.exec(input);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = match[2] === undefined ? 0 : Number(match[2]);
  const patch = match[3] === undefined ? 0 : Number(match[3]);
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) {
    return null;
  }
  // 仅保留预发布部分（"-" 之后、"+" 之前）；构建元数据不参与比较。
  let prerelease: string[] = [];
  const suffix = match[4];
  if (suffix) {
    const pre = suffix.split("+")[0];
    if (pre) {
      prerelease = pre.split(".").filter((part) => part.length > 0);
    }
  }
  return { major, minor, patch, prerelease };
}

function comparePrerelease(a: string[], b: string[]): number {
  // 无预发布的版本视为更高（正式版 > 预发布）。
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const partA = a[i];
    const partB = b[i];
    if (partA === undefined) return -1;
    if (partB === undefined) return 1;
    const numA = /^\d+$/.test(partA) ? Number(partA) : null;
    const numB = /^\d+$/.test(partB) ? Number(partB) : null;
    if (numA !== null && numB !== null) {
      if (numA !== numB) return numA < numB ? -1 : 1;
    } else if (numA !== null) {
      return -1; // 数字标识优先级低于字母标识。
    } else if (numB !== null) {
      return 1;
    } else if (partA !== partB) {
      return partA < partB ? -1 : 1;
    }
  }
  return 0;
}

/**
 * 语义化比较两个版本字符串。
 * 返回负数表示 a < b，0 表示相等，正数表示 a > b。
 * 无法解析的一侧视为更小；两侧都无法解析时按字符串比较。
 */
export function compareVersions(a: unknown, b: unknown): number {
  const parsedA = parseVersion(a);
  const parsedB = parseVersion(b);
  if (!parsedA && !parsedB) {
    const strA = typeof a === "string" ? a : "";
    const strB = typeof b === "string" ? b : "";
    return strA < strB ? -1 : strA > strB ? 1 : 0;
  }
  if (!parsedA) return -1;
  if (!parsedB) return 1;
  if (parsedA.major !== parsedB.major) return parsedA.major < parsedB.major ? -1 : 1;
  if (parsedA.minor !== parsedB.minor) return parsedA.minor < parsedB.minor ? -1 : 1;
  if (parsedA.patch !== parsedB.patch) return parsedA.patch < parsedB.patch ? -1 : 1;
  return comparePrerelease(parsedA.prerelease, parsedB.prerelease);
}

/** latest 是否严格高于 current。 */
export function isNewerVersion(latest: unknown, current: unknown): boolean {
  return compareVersions(latest, current) > 0;
}

/** 去掉 release 版本号前导的 "v"，得到纯版本字符串。 */
export function releaseVersion(release: ReleaseJson): string {
  const raw = (release.tag_name || release.name || "").trim();
  return raw.replace(/^v/i, "");
}

function normalizeSha256(digest: unknown): string | null {
  if (typeof digest !== "string") return null;
  const trimmed = digest.trim();
  if (!trimmed) return null;
  const withoutPrefix = trimmed.toLowerCase().startsWith("sha256:")
    ? trimmed.slice("sha256:".length)
    : trimmed;
  const hex = withoutPrefix.trim().toLowerCase();
  // sha256 为 64 位十六进制。
  return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
}

/**
 * 从 release 中挑选 Windows x64 安装包资产。
 * 优先精确匹配期望文件名，否则回退到匹配 Dockwisp-*-x64.exe 命名规则。
 */
export function selectInstallerAsset(
  release: ReleaseJson,
  expectedName?: string,
): SelectedAsset | null {
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const usable = assets.filter(
    (asset) =>
      asset &&
      typeof asset.name === "string" &&
      typeof asset.browser_download_url === "string" &&
      asset.browser_download_url.length > 0,
  );
  if (usable.length === 0) return null;

  let chosen: ReleaseAsset | undefined;
  if (expectedName) {
    chosen = usable.find((asset) => asset.name === expectedName);
  }
  if (!chosen) {
    chosen = usable.find((asset) => /^Dockwisp-.*-x64\.exe$/i.test(asset.name));
  }
  if (!chosen) {
    chosen = usable.find((asset) => /x64\.exe$/i.test(asset.name));
  }
  if (!chosen) return null;

  return {
    name: chosen.name,
    size: typeof chosen.size === "number" && Number.isFinite(chosen.size) ? chosen.size : null,
    downloadUrl: chosen.browser_download_url as string,
    sha256: normalizeSha256(chosen.digest),
  };
}

/** 期望的安装包文件名，与 electron-builder artifactName 保持一致。 */
export function expectedInstallerName(version: string): string {
  return `Dockwisp-${version}-x64.exe`;
}

/**
 * 综合 release JSON 与当前版本，得出可直接发回渲染器的更新信息。
 * 纯函数：不发起网络请求，只做判定。
 */
export function interpretRelease(release: ReleaseJson, currentVersion: string): UpdateInfo {
  const latest = releaseVersion(release);
  if (!latest) {
    return {
      status: "error",
      current: currentVersion,
      message: "最新发布缺少版本号",
    };
  }

  if (!isNewerVersion(latest, currentVersion)) {
    return { status: "latest", current: currentVersion, latest };
  }

  const asset = selectInstallerAsset(release, expectedInstallerName(latest));
  if (!asset) {
    return {
      status: "error",
      current: currentVersion,
      latest,
      message: "新版本未提供 Windows x64 安装包",
    };
  }

  const notes = typeof release.body === "string" ? release.body : "";
  const info: UpdateInfo = {
    status: "available",
    current: currentVersion,
    latest,
    notes,
    downloadUrl: asset.downloadUrl,
    assetName: asset.name,
    sha256: asset.sha256,
    digestMissing: asset.sha256 === null,
  };
  if (typeof release.published_at === "string" && release.published_at) {
    info.publishedAt = release.published_at;
  }
  if (asset.size !== null) {
    info.size = asset.size;
  }
  if (typeof release.html_url === "string" && release.html_url) {
    info.htmlUrl = release.html_url;
  }
  return info;
}
