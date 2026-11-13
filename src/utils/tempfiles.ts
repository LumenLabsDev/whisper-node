import fs from "fs";
import path from "path";
import { tmpRoot } from "../config/runtime";
import { createLogger } from "./logger";

const logger = createLogger("tempfiles");

/** `wh-stream-<pid>-XXXXXX` / `wh-<pid>-XXXXXX`, and the 1.0 names without a pid. */
const DIRECTORY = /^wh-(?:stream-)?(?:(\d{1,10})-)?[A-Za-z0-9]{6}$/;
/** Files this package writes inside those directories. */
const OWN_FILE = /^(?:chunk-\d+|tmp)\.wav$/;

export interface ICleanupOptions {
  /** Directory to scan. Default: the configured `tmpDir` (or `os.tmpdir()`). */
  dir?: string;
  /** Minimum age of directories from other or unknown processes. Default 10 minutes. */
  olderThanMs?: number;
  /** Age after which a directory is removed even if its recorded process id is in use again. Default 6 hours. */
  staleAfterMs?: number;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Remove temporary audio left by crashed or killed processes. Only directories named like this
 * package's and holding only its chunk files are touched; directories of live processes are kept.
 * Returns the removed directories.
 */
export function cleanupTempFiles(options: ICleanupOptions = {}): string[] {
  const dir = options.dir ?? tmpRoot();
  const olderThanMs = options.olderThanMs ?? 10 * 60 * 1000;
  const staleAfterMs = options.staleAfterMs ?? 6 * 60 * 60 * 1000;
  const removed: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return removed;
  }
  const now = Date.now();
  for (const entry of entries) {
    const match = DIRECTORY.exec(entry.name);
    if (!match || !entry.isDirectory()) continue;
    const target = path.join(dir, entry.name);
    try {
      const age = now - fs.statSync(target).mtimeMs;
      const pid = match[1] ? Number(match[1]) : undefined;
      if (pid === process.pid) continue;
      const ownerGone = pid !== undefined && !isAlive(pid);
      if (!ownerGone && age < (pid === undefined ? olderThanMs : staleAfterMs)) continue;
      const files = fs.readdirSync(target, { withFileTypes: true });
      if (!files.every(file => file.isFile() && OWN_FILE.test(file.name))) continue;
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 2 });
      removed.push(target);
    } catch (error) {
      logger.debug("Skipping temporary directory", { target, error: error instanceof Error ? error.message : error });
    }
  }
  if (removed.length) logger.info("Removed stale temporary audio", { count: removed.length, dir });
  return removed;
}

const cleaned = new Set<string>();

/** Run `cleanupTempFiles` once per process for each temporary directory in use. */
export function cleanupTempFilesOnce(): void {
  const dir = tmpRoot();
  if (cleaned.has(dir)) return;
  cleaned.add(dir);
  cleanupTempFiles({ dir });
}

/** Create a private temporary directory whose name records the owning process. */
export function makeTempDir(prefix: "wh-stream" | "wh"): string {
  cleanupTempFilesOnce();
  const parent = tmpRoot();
  fs.mkdirSync(parent, { recursive: true });
  return fs.mkdtempSync(path.join(parent, `${prefix}-${process.pid}-`));
}
