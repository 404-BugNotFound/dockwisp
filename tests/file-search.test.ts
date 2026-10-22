import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, stat, utimes, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { FileSearch, parseEverythingUninstallEntries } from "../src/main/file-search";

interface MutableFileSearch {
  queryHelper: (query: string, offset: number, limit: number) => Promise<unknown>;
  runHelper: (argument: string) => Promise<unknown>;
  startProvider: (reason: string) => Promise<boolean>;
  syncPortable: () => Promise<void>;
  installedEverything: () => Promise<string | null>;
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

test("syncPortable copies the bundled Everything when the target is missing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dockwisp-sync-"));
  try {
    const bundled = path.join(root, "bundled");
    const runDir = path.join(root, "run");
    await mkdir(bundled, { recursive: true });
    await writeFile(path.join(bundled, "Everything.exe"), "EXE-CONTENT");
    await writeFile(path.join(bundled, "Everything.lng"), "LNG-CONTENT");

    const search = new FileSearch(
      "missing-helper",
      path.join(runDir, "Everything.exe"),
      path.join(root, "everything.ini"),
      path.join(root, "everything.db"),
      () => [],
      bundled,
    );
    await (search as unknown as MutableFileSearch).syncPortable();

    assert.equal(await readFile(path.join(runDir, "Everything.exe"), "utf8"), "EXE-CONTENT");
    assert.equal(await readFile(path.join(runDir, "Everything.lng"), "utf8"), "LNG-CONTENT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("syncPortable recopies only when the bundled source differs", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dockwisp-sync-"));
  try {
    const bundled = path.join(root, "bundled");
    const runDir = path.join(root, "run");
    await mkdir(bundled, { recursive: true });
    await writeFile(path.join(bundled, "Everything.exe"), "V1");
    await writeFile(path.join(bundled, "Everything.lng"), "LNG");

    const target = path.join(runDir, "Everything.exe");
    const search = new FileSearch(
      "missing-helper",
      target,
      path.join(root, "everything.ini"),
      path.join(root, "everything.db"),
      () => [],
      bundled,
    );
    const mutable = search as unknown as MutableFileSearch;

    await mutable.syncPortable();
    const firstCopy = await stat(target);

    // An identical source (same size, source not newer) must not trigger a copy.
    await mutable.syncPortable();
    const secondCopy = await stat(target);
    assert.equal(secondCopy.mtimeMs, firstCopy.mtimeMs);

    // A changed source (different size, newer mtime) must trigger a recopy.
    await writeFile(path.join(bundled, "Everything.exe"), "VERSION-2");
    const future = new Date(Date.now() + 10_000);
    await utimes(path.join(bundled, "Everything.exe"), future, future);
    await mutable.syncPortable();
    assert.equal(await readFile(target, "utf8"), "VERSION-2");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("syncPortable tolerates a missing optional language file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dockwisp-sync-"));
  try {
    const bundled = path.join(root, "bundled");
    const runDir = path.join(root, "run");
    await mkdir(bundled, { recursive: true });
    await writeFile(path.join(bundled, "Everything.exe"), "EXE");

    const search = new FileSearch(
      "missing-helper",
      path.join(runDir, "Everything.exe"),
      path.join(root, "everything.ini"),
      path.join(root, "everything.db"),
      () => [],
      bundled,
    );
    await (search as unknown as MutableFileSearch).syncPortable();

    assert.equal(await readFile(path.join(runDir, "Everything.exe"), "utf8"), "EXE");
    const lng = await stat(path.join(runDir, "Everything.lng")).catch(() => null);
    assert.equal(lng, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("startProvider syncs the writable portable copy before spawning", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dockwisp-start-"));
  try {
    const bundled = path.join(root, "bundled");
    const runDir = path.join(root, "run");
    await mkdir(bundled, { recursive: true });
    await writeFile(path.join(bundled, "Everything.exe"), "PORTABLE");

    const target = path.join(runDir, "Everything.exe");
    const search = new FileSearch(
      "missing-helper",
      target,
      path.join(root, "everything.ini"),
      path.join(root, "everything.db"),
      () => [],
      bundled,
    );
    const mutable = search as unknown as MutableFileSearch;
    // No system Everything, so the portable provider is chosen.
    mutable.installedEverything = async () => null;
    // Spy on the sync step while still letting it copy, to prove startProvider
    // syncs the writable copy before it would spawn Everything.
    let syncedBeforeSpawn = false;
    const realSync = mutable.syncPortable.bind(search);
    mutable.syncPortable = async () => {
      syncedBeforeSpawn = true;
      await realSync();
    };

    // The fake exe is not a real PE, so the spawn is a no-op here; we only assert
    // that the writable copy was produced from the bundled source first.
    await mutable.startProvider("test");

    assert.equal(syncedBeforeSpawn, true);
    assert.equal(await readFile(target, "utf8"), "PORTABLE");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
