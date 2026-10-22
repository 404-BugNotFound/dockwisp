import { app } from "electron";
import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";

const MAX_LOG_BYTES = 256 * 1024;

// Serialise writes per file so concurrent lines keep their order.
const queues = new Map<string, Promise<void>>();

/**
 * Append one timestamped diagnostic line to `<userData>/logs/<name>.log`,
 * rotating to `<name>.log.1` past 256 KB. Never throws; diagnostics must not
 * affect the feature being diagnosed.
 */
export function diagLog(name: string, message: string): void {
  let directory: string;
  try {
    directory = path.join(app.getPath("userData"), "logs");
  } catch {
    return;
  }
  const file = path.join(directory, `${name}.log`);
  const line = `${new Date().toISOString()} [${process.pid}] ${message}\n`;
  const previous = queues.get(file) ?? Promise.resolve();
  const next = previous.then(async () => {
    try {
      await mkdir(directory, { recursive: true });
      const info = await stat(file).catch(() => null);
      if (info && info.size > MAX_LOG_BYTES) await rename(file, `${file}.1`);
      await appendFile(file, line);
    } catch {
      // Ignore logging failures.
    }
  });
  queues.set(file, next);
}
