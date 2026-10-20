import assert from "node:assert/strict";
import test from "node:test";
import { FileSearch } from "../src/main/file-search";

interface MutableFileSearch {
  queryHelper: (query: string) => Promise<unknown>;
  indexingObservedAt: number;
}

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
