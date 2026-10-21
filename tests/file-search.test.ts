import assert from "node:assert/strict";
import test from "node:test";
import { FileSearch, parseEverythingUninstallEntries } from "../src/main/file-search";

interface MutableFileSearch {
  queryHelper: (query: string, offset: number, limit: number) => Promise<unknown>;
  runHelper: (argument: string) => Promise<unknown>;
  startProvider: () => Promise<boolean>;
  indexingObservedAt: number;
}

test("warmUp reuses a running Everything instead of starting a provider", async () => {
  const search = new FileSearch("missing-helper", "missing-portable", "config", "db", () => []);
  const mutable = search as unknown as MutableFileSearch;
  let started = 0;
  mutable.startProvider = async () => {
    started += 1;
    return true;
  };

  mutable.runHelper = async () => ({ ok: true, ipc: true, dbLoaded: true });
  await search.warmUp();
  assert.equal(started, 0);

  mutable.runHelper = async () => ({ ok: true, ipc: false, dbLoaded: false });
  await search.warmUp();
  assert.equal(started, 1);
});

test("parses Everything install directories from registry uninstall output", () => {
  const output = [
    "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Everything",
    "    DisplayName    REG_SZ    Everything 1.4.1.1026 (x64)",
    "    DisplayIcon    REG_SZ    D:\\Tools\\Everything\\Everything.exe",
    "    UninstallString    REG_SZ    \"D:\\Tools\\Everything\\Uninstall.exe\"",
    "",
    "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Everything 1.5a",
    "    DisplayName    REG_SZ    Everything 1.5.0.1383a (x64)",
    "    InstallLocation    REG_SZ    E:\\Apps\\Everything 1.5a\\",
    "",
    "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Other",
    "    DisplayName    REG_SZ    Search Everything Toolbar",
    "    DisplayIcon    REG_SZ    C:\\Other\\other.exe,0",
    "",
  ].join("\r\n");
  assert.deepEqual(parseEverythingUninstallEntries(output), [
    "D:\\Tools\\Everything",
    "D:\\Tools\\Everything",
    "E:\\Apps\\Everything 1.5a",
  ]);
});

test("reports indexing phase and clears it when results become ready", async () => {
  const search = new FileSearch("missing-helper", "missing-portable", "config", "db", () => []);
  const mutable = search as unknown as MutableFileSearch;
  mutable.queryHelper = async () => ({ indexing: true });
  mutable.indexingObservedAt = Date.now() - 2_500;

  const indexing = await search.query("report");
  assert.equal(indexing.status, "indexing");
  assert.equal(indexing.progress?.phase, "indexing");
  assert.ok((indexing.progress?.elapsedMs ?? 0) >= 2_000);

  mutable.queryHelper = async () => ({
    ok: true,
    results: [{ path: "D:\\docs\\report.pdf" }],
  });
  const ready = await search.query("report");
  assert.equal(ready.status, "ok");
  assert.deepEqual(ready.paths, ["D:\\docs\\report.pdf"]);
  assert.equal(mutable.indexingObservedAt, 0);
});

test("returns complete file results in stable pages", async () => {
  const search = new FileSearch("missing-helper", "missing-portable", "config", "db", () => []);
  const mutable = search as unknown as MutableFileSearch;
  const paths = Array.from({ length: 205 }, (_, index) => `D:\\docs\\report-${index}.pdf`);
  mutable.queryHelper = async (_query, offset, limit) => {
    const page = paths.slice(offset, offset + limit);
    return {
      ok: true,
      offset,
      count: page.length,
      total: paths.length,
      results: page.map((filePath) => ({ path: filePath })),
    };
  };

  const first = await search.query("report", 0, 100);
  assert.equal(first.paths.length, 100);
  assert.equal(first.nextOffset, 100);
  assert.equal(first.total, 205);
  assert.equal(first.hasMore, true);

  const last = await search.query("report", 200, 100);
  assert.deepEqual(last.paths, paths.slice(200));
  assert.equal(last.nextOffset, 205);
  assert.equal(last.hasMore, false);
});
