import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

interface RatesCache {
  fetchedAt: number;
  date: string;
  rates: Record<string, number>;
}

const TTL_MS = 12 * 60 * 60 * 1000;
const ENDPOINT = "https://open.er-api.com/v6/latest/USD";

/**
 * Fetches and caches USD-based currency rates (units per USD). Only refreshed
 * when a currency conversion is requested, and never more often than the TTL.
 */
export class CurrencyRates {
  private readonly cachePath: string;
  private cache: RatesCache | null = null;

  constructor(userDataDirectory: string) {
    this.cachePath = path.join(userDataDirectory, "currency-rates.json");
    this.cache = this.readCache();
  }

  /** The date string of the currently held rates, if any. */
  get date(): string | null {
    return this.cache?.date ?? null;
  }

  /**
   * Return fresh rates, refreshing over the network when stale. Falls back to
   * any cached rates (even stale) on failure; null when nothing is available.
   */
  async ensureRates(): Promise<Record<string, number> | null> {
    const now = Date.now();
    if (this.cache && now - this.cache.fetchedAt < TTL_MS) {
      return this.cache.rates;
    }
    const fetched = await this.fetchRates();
    if (fetched) {
      this.cache = fetched;
      this.writeCache(fetched);
      return fetched.rates;
    }
    return this.cache?.rates ?? null;
  }

  /** Force a network refresh (used by launcher:refresh); failures are ignored. */
  async refresh(): Promise<void> {
    const fetched = await this.fetchRates();
    if (fetched) {
      this.cache = fetched;
      this.writeCache(fetched);
    }
  }

  private async fetchRates(): Promise<RatesCache | null> {
    try {
      const response = await fetch(ENDPOINT, { signal: AbortSignal.timeout(4000) });
      if (!response.ok) return null;
      const body = (await response.json()) as {
        result?: string;
        date?: string;
        time_last_update_utc?: string;
        rates?: Record<string, number>;
      };
      if (body.result && body.result !== "success") return null;
      if (!body.rates || typeof body.rates !== "object") return null;
      const rates: Record<string, number> = { USD: 1 };
      for (const [code, value] of Object.entries(body.rates)) {
        if (typeof value === "number" && Number.isFinite(value)) {
          rates[code.toUpperCase()] = value;
        }
      }
      const parsedDate = body.date
        ? body.date
        : body.time_last_update_utc
          ? new Date(body.time_last_update_utc)
          : null;
      const date =
        parsedDate instanceof Date
          ? Number.isFinite(parsedDate.getTime())
            ? parsedDate.toISOString().slice(0, 10)
            : new Date().toISOString().slice(0, 10)
          : typeof parsedDate === "string" && parsedDate
            ? parsedDate
            : new Date().toISOString().slice(0, 10);
      return {
        fetchedAt: Date.now(),
        date,
        rates,
      };
    } catch {
      return null;
    }
  }

  private readCache(): RatesCache | null {
    if (!existsSync(this.cachePath)) return null;
    try {
      const parsed = JSON.parse(readFileSync(this.cachePath, "utf8")) as RatesCache;
      if (parsed && parsed.rates && typeof parsed.rates === "object") return parsed;
    } catch {
      // Ignore a corrupt cache.
    }
    return null;
  }

  private writeCache(value: RatesCache): void {
    try {
      const temporary = `${this.cachePath}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
      renameSync(temporary, this.cachePath);
    } catch {
      // A write failure is non-fatal; rates stay in memory.
    }
  }
}
