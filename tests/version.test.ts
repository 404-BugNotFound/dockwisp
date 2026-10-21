import assert from "node:assert/strict";
import test from "node:test";
import {
  compareVersions,
  expectedInstallerName,
  interpretRelease,
  isNewerVersion,
  parseVersion,
  releaseVersion,
  selectInstallerAsset,
  type ReleaseJson,
} from "../src/core/version";

test("parseVersion 容忍前导 v、缺省段与预发布后缀", () => {
  assert.deepEqual(parseVersion("1.2.3"), { major: 1, minor: 2, patch: 3, prerelease: [] });
  assert.deepEqual(parseVersion("v2.0"), { major: 2, minor: 0, patch: 0, prerelease: [] });
  assert.deepEqual(parseVersion("v3"), { major: 3, minor: 0, patch: 0, prerelease: [] });
  assert.deepEqual(parseVersion("1.2.3-beta.1+build.5"), {
    major: 1,
    minor: 2,
    patch: 3,
    prerelease: ["beta", "1"],
  });
  assert.equal(parseVersion("not-a-version"), null);
  assert.equal(parseVersion(42), null);
});

test("compareVersions 按语义顺序排序", () => {
  assert.ok(compareVersions("1.0.0", "1.0.1") < 0);
  assert.ok(compareVersions("1.2.0", "1.1.9") > 0);
  assert.equal(compareVersions("1.4.0", "v1.4.0"), 0);
  assert.ok(compareVersions("2.0.0", "10.0.0") < 0);
  // 正式版高于其预发布版本。
  assert.ok(compareVersions("1.0.0", "1.0.0-beta.1") > 0);
  assert.ok(compareVersions("1.0.0-alpha", "1.0.0-beta") < 0);
});

test("isNewerVersion 仅在严格更高时为真", () => {
  assert.equal(isNewerVersion("0.1.5", "0.1.4"), true);
  assert.equal(isNewerVersion("0.1.4", "0.1.4"), false);
  assert.equal(isNewerVersion("0.1.3", "0.1.4"), false);
});

test("releaseVersion 去掉前导 v", () => {
  assert.equal(releaseVersion({ tag_name: "v0.1.5" }), "0.1.5");
  assert.equal(releaseVersion({ tag_name: "0.2.0" }), "0.2.0");
  assert.equal(releaseVersion({ name: "v1.0.0" }), "1.0.0");
});

test("expectedInstallerName 与打包命名一致", () => {
  assert.equal(expectedInstallerName("0.1.5"), "Dockwisp-0.1.5-x64.exe");
});

test("selectInstallerAsset 精确匹配文件名并规范化 sha256", () => {
  const release: ReleaseJson = {
    tag_name: "v0.1.5",
    assets: [
      { name: "other.txt", browser_download_url: "https://example.com/other.txt" },
      {
        name: "Dockwisp-0.1.5-x64.exe",
        size: 1234,
        browser_download_url: "https://example.com/Dockwisp-0.1.5-x64.exe",
        digest: "sha256:" + "A".repeat(64),
      },
    ],
  };
  const asset = selectInstallerAsset(release, "Dockwisp-0.1.5-x64.exe");
  assert.ok(asset);
  assert.equal(asset?.name, "Dockwisp-0.1.5-x64.exe");
  assert.equal(asset?.size, 1234);
  assert.equal(asset?.sha256, "a".repeat(64));
});

test("selectInstallerAsset 在缺少摘要或无匹配时的行为", () => {
  const noDigest: ReleaseJson = {
    assets: [
      {
        name: "Dockwisp-0.1.5-x64.exe",
        browser_download_url: "https://example.com/Dockwisp-0.1.5-x64.exe",
      },
    ],
  };
  assert.equal(selectInstallerAsset(noDigest)?.sha256, null);

  const noMatch: ReleaseJson = {
    assets: [{ name: "readme.md", browser_download_url: "https://example.com/readme.md" }],
  };
  assert.equal(selectInstallerAsset(noMatch), null);
});

test("interpretRelease 判定为已是最新", () => {
  const release: ReleaseJson = { tag_name: "v0.1.4", assets: [] };
  const info = interpretRelease(release, "0.1.4");
  assert.equal(info.status, "latest");
  assert.equal(info.current, "0.1.4");
  assert.equal(info.latest, "0.1.4");
});

test("interpretRelease 判定为有新版本并带校验信息", () => {
  const release: ReleaseJson = {
    tag_name: "v0.1.5",
    body: "修复若干问题",
    published_at: "2026-01-01T00:00:00Z",
    html_url: "https://github.com/404-BugNotFound/dockwisp/releases/tag/v0.1.5",
    assets: [
      {
        name: "Dockwisp-0.1.5-x64.exe",
        size: 9999,
        browser_download_url: "https://example.com/Dockwisp-0.1.5-x64.exe",
        digest: "sha256:" + "b".repeat(64),
      },
    ],
  };
  const info = interpretRelease(release, "0.1.4");
  assert.equal(info.status, "available");
  assert.equal(info.latest, "0.1.5");
  assert.equal(info.notes, "修复若干问题");
  assert.equal(info.size, 9999);
  assert.equal(info.sha256, "b".repeat(64));
  assert.equal(info.digestMissing, false);
  assert.equal(info.downloadUrl, "https://example.com/Dockwisp-0.1.5-x64.exe");
  assert.equal(info.publishedAt, "2026-01-01T00:00:00Z");
});

test("interpretRelease 在资产缺少摘要时标记 digestMissing", () => {
  const release: ReleaseJson = {
    tag_name: "v0.1.5",
    assets: [
      {
        name: "Dockwisp-0.1.5-x64.exe",
        browser_download_url: "https://example.com/Dockwisp-0.1.5-x64.exe",
      },
    ],
  };
  const info = interpretRelease(release, "0.1.4");
  assert.equal(info.status, "available");
  assert.equal(info.digestMissing, true);
  assert.equal(info.sha256, null);
});

test("interpretRelease 在新版本缺少安装包时报错", () => {
  const release: ReleaseJson = {
    tag_name: "v0.1.5",
    assets: [{ name: "notes.txt", browser_download_url: "https://example.com/notes.txt" }],
  };
  const info = interpretRelease(release, "0.1.4");
  assert.equal(info.status, "error");
  assert.ok(info.message && info.message.length > 0);
});
