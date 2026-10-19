import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { UsageStore } from "../src/main/usage-store";

const DAY_MS = 24 * 60 * 60 * 1000;

test("records uses and boosts by frequency and recency", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dockwisp-usage-"));
  const store = new UsageStore(path.join(root, "usage.json"));
  const now = Date.now();
  store.record("app:a", now);
  store.record("app:a", now);
  store.record("app:a", now);
  // frequency = round(30 * log2(4)) = 60; recency (same day) = 40.
  assert.equal(store.boost("app:a", now), 100);
  assert.equal(store.boost("missing", now), 0);
});

test("recency decays with injected now", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dockwisp-usage-"));
  const store = new UsageStore(path.join(root, "usage.json"));
  const base = Date.now();
  store.record("x", base); // count 1 -> frequency 30
  assert.equal(store.boost("x", base), 70); // 30 + 40 (<=1d)
  assert.equal(store.boost("x", base + 3 * DAY_MS), 50); // 30 + 20 (<=7d)
  assert.equal(store.boost("x", base + 15 * DAY_MS), 38); // 30 + 8 (<=30d)
  assert.equal(store.boost("x", base + 60 * DAY_MS), 30); // 30 + 0
});

test("caps the boost at 220", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dockwisp-usage-"));
  const store = new UsageStore(path.join(root, "usage.json"));
  const now = Date.now();
  for (let index = 0; index < 100_000; index += 1) store.record("hot", now);
  assert.ok(store.boost("hot", now) <= 220);
  assert.equal(store.boost("hot", now), 220);
});

test("clear forgets everything", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dockwisp-usage-"));
  const store = new UsageStore(path.join(root, "usage.json"));
  store.record("y");
  store.clear();
  assert.equal(store.boost("y"), 0);
});

test("persists across instances and caps entries at 1000", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dockwisp-usage-"));
  const filePath = path.join(root, "usage.json");
  const store = new UsageStore(filePath);
  const base = Date.now();
  for (let index = 0; index < 1_200; index += 1) {
    store.record(`id:${index}`, base + index);
  }
  store.flush();
  const reopened = new UsageStore(filePath);
  // The 200 oldest entries were evicted; the newest survive.
  assert.equal(reopened.boost("id:0", base), 0);
  assert.ok(reopened.boost("id:1199", base + 1_199) > 0);
});
