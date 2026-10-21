import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildSearchForms,
  isNoisyPath,
  mergeMatches,
  normalizePluginCommands,
  rankFilePaths,
  searchApps,
  searchCommands,
  tokenize,
} from "../src/core/matcher";
import { parsePluginManifest } from "../src/core/manifest";
import { AppEntry, SearchMatch } from "../src/core/types";

function appEntry(
  name: string,
  filePath: string,
  source: AppEntry["source"],
  isApp = true,
): AppEntry {
  return {
    id: filePath.toLowerCase(),
    name,
    path: filePath,
    source,
    isApp,
    ...buildSearchForms(name),
  };
}

function plugin() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "dockwisp-matcher-"));
  writeFileSync(path.join(directory, "index.html"), "<main></main>");
  return parsePluginManifest(
    {
      name: "fixture",
      pluginName: "Fixture",
      main: "index.html",
      features: [
        { code: "translate", description: "聚合翻译", cmds: ["翻译"] },
        {
          code: "url",
          description: "打开 URL",
          cmds: [{ type: "regex", label: "打开网址", match: "/^https?:\\/\\//i" }],
        },
        {
          code: "markdown",
          description: "Markdown 文件",
          cmds: [{ type: "files", label: "打开 Markdown", extensions: ["md"] }],
        },
      ],
    },
    directory,
  );
}

test("matches Chinese commands by pinyin initials", () => {
  const commands = normalizePluginCommands(plugin());
  const matches = searchCommands(commands, { type: "text", data: "fy" });
  assert.equal(matches[0]?.featureCode, "translate");
});

test("matches regex and file data commands", () => {
  const commands = normalizePluginCommands(plugin());
  const url = searchCommands(commands, { type: "text", data: "https://example.com" });
  assert.ok(url.some((item) => item.featureCode === "url"));
  const files = searchCommands(commands, {
    type: "files",
    data: [{ path: "C:\\note.md", name: "note.md", isFile: true, isDirectory: false }],
  });
  assert.equal(files[0]?.featureCode, "markdown");
});

test("empty text query returns no plugin commands", () => {
  const commands = normalizePluginCommands(plugin());
  const matches = searchCommands(commands, { type: "text", data: "   " });
  assert.equal(matches.length, 0);
});

test("custom portable app outranks a start-menu entry for the same query", () => {
  const apps = [
    appEntry(
      "Uninstall",
      "C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Uninstall.lnk",
      "start-menu",
    ),
    appEntry(
      "Uninstall Driver",
      "C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Uninstall Driver.lnk",
      "start-menu",
    ),
    appEntry(
      "HiBitUninstaller-Portable",
      "D:\\HiBitUninstaller\\HiBitUninstaller-Portable.exe",
      "custom",
    ),
  ];
  const matches = searchApps(apps, "uninstall");
  assert.equal(matches[0]?.title, "HiBitUninstaller-Portable");
  assert.ok(matches[0].score > (matches[1]?.score ?? 0));
});

test("non-app custom items are excluded from app search", () => {
  const apps = [
    appEntry("Projects", "D:\\Projects", "custom", false),
    appEntry("Projects Launcher", "D:\\Projects Launcher.lnk", "custom", true),
  ];
  const matches = searchApps(apps, "projects");
  assert.ok(matches.every((item) => item.path !== "D:\\Projects"));
  assert.ok(matches.some((item) => item.path === "D:\\Projects Launcher.lnk"));
});

test("pinned apps receive the pinned boost and flag", () => {
  const apps = [
    appEntry("Notepad", "C:\\Windows\\System32\\notepad.exe", "start-menu"),
    appEntry("Notepad Plus", "D:\\npp\\notepadplus.exe", "start-menu"),
  ];
  const pinnedPaths = new Set(["c:\\windows\\system32\\notepad.exe"]);
  const matches = searchApps(apps, "notepad", { pinnedPaths });
  const pinned = matches.find((item) => item.path.toLowerCase() === "c:\\windows\\system32\\notepad.exe");
  assert.equal(pinned?.pinned, true);
  assert.equal(matches[0]?.path.toLowerCase(), "c:\\windows\\system32\\notepad.exe");
});

test("tokenize splits CamelCase and separators", () => {
  const tokens = tokenize("HiBitUninstaller-Portable");
  assert.ok(tokens.includes("uninstaller"));
  assert.ok(tokens.includes("portable"));
  assert.ok(tokens.includes("hi"));
  assert.ok(tokens.includes("bit"));
});

test("file ranking keeps every unique path and sorts by basename relevance", () => {
  assert.equal(isNoisyPath("C:\\Windows\\System32\\drivers\\x.sys"), true);
  assert.equal(isNoisyPath("C:\\Users\\me\\report.pf"), true);
  assert.equal(isNoisyPath("D:\\docs\\report.pdf"), false);
  const ranked = rankFilePaths(
    [
      "C:\\Windows\\report.txt",
      "D:\\docs\\report.pdf",
      "D:\\docs\\report.pdf",
      "D:\\docs\\annual-report-draft.pdf",
    ],
    "report",
  );
  assert.ok(ranked.some((item) => item.path.toLowerCase().includes("\\windows\\")));
  assert.equal(ranked.filter((item) => item.path === "D:\\docs\\report.pdf").length, 1);
  assert.equal(ranked[0]?.title, "report.pdf");

  const complete = rankFilePaths(
    Array.from({ length: 75 }, (_, index) => `D:\\docs\\report-${index}.txt`),
    "report",
  );
  assert.equal(complete.length, 75);
});

test("mergeMatches breaks ties by title length then locale", () => {
  const groups: SearchMatch[][] = [
    [
      {
        id: "a",
        kind: "app",
        title: "Beta",
        subtitle: "应用程序",
        score: 500,
        path: "C:\\beta.exe",
      },
      {
        id: "b",
        kind: "app",
        title: "Al",
        subtitle: "应用程序",
        score: 500,
        path: "C:\\al.exe",
      },
      {
        id: "c",
        kind: "app",
        title: "Zeta",
        subtitle: "应用程序",
        score: 800,
        path: "C:\\zeta.exe",
      },
    ],
  ];
  const merged = mergeMatches(groups);
  assert.deepEqual(
    merged.map((item) => item.id),
    ["c", "b", "a"],
  );
});
