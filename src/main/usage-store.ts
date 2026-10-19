import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

interface UsageEntry {
  count: number;
  lastUsed: number;
}

const MAX_ENTRIES = 1000;
const FLUSH_DELAY_MS = 300;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Tracks how often and how recently a match id was executed, and converts that
 * into a ranking boost. Writes are debounced and atomic (tmp + rename).
 */
export class UsageStore {
  private data: Record<string, UsageEntry> = {};
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(private readonly filePath: string) {
    this.data = this.read();
  }

  /** Record one use of an id at the given time (defaults to now). */
  record(id: string, now = Date.now()): void {
    if (!id) return;
    const entry = this.data[id];
    if (entry) {
      entry.count += 1;
      entry.lastUsed = now;
    } else {
      this.data[id] = { count: 1, lastUsed: now };
      this.evictIfNeeded();
    }
    this.scheduleFlush();
  }

  /** Ranking boost for an id: frequency (log2) plus a recency bonus, capped. */
  boost(id: string, now = Date.now()): number {
    const entry = this.data[id];
    if (!entry) return 0;
    const frequency = Math.min(180, Math.round(30 * Math.log2(1 + entry.count)));
    const age = now - entry.lastUsed;
    let recency = 0;
    if (age <= DAY_MS) recency = 40;
    else if (age <= 7 * DAY_MS) recency = 20;
    else if (age <= 30 * DAY_MS) recency = 8;
    return Math.min(220, frequency + recency);
  }

  /** Forget all usage and persist immediately. */
  clear(): void {
    this.data = {};
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.write();
  }

  /** Flush any pending debounced write now. */
  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.write();
  }

  private evictIfNeeded(): void {
    const keys = Object.keys(this.data);
    if (keys.length <= MAX_ENTRIES) return;
    // Drop the least recently used entries down to the cap.
    const sorted = keys.sort((a, b) => this.data[a].lastUsed - this.data[b].lastUsed);
    for (const key of sorted.slice(0, keys.length - MAX_ENTRIES)) {
      delete this.data[key];
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.write();
    }, FLUSH_DELAY_MS);
    this.flushTimer.unref?.();
  }

  private read(): Record<string, UsageEntry> {
    if (!existsSync(this.filePath)) return {};
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Record<string, unknown>;
      const result: Record<string, UsageEntry> = {};
      for (const [id, value] of Object.entries(parsed)) {
        if (value && typeof value === "object") {
          const entry = value as { count?: unknown; lastUsed?: unknown };
          if (typeof entry.count === "number" && typeof entry.lastUsed === "number") {
            result[id] = { count: entry.count, lastUsed: entry.lastUsed };
          }
        }
      }
      return result;
    } catch {
      return {};
    }
  }

  private write(): void {
    try {
      const temporary = `${this.filePath}.tmp`;
      writeFileSync(temporary, JSON.stringify(this.data), "utf8");
      renameSync(temporary, this.filePath);
    } catch {
      // Non-fatal: usage stats are best-effort.
    }
  }
}
