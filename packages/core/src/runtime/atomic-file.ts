/**
 * Atomic file writes: a temp file next to the target, then a rename over it. Windows can refuse a rename for a moment
 * while another process (Claude Code's watcher, an editor, a virus scanner) has the target open, so the rename is
 * retried a few times on the codes below. On any error the temp file is removed before the error is rethrown, the
 * temp write included (a full disk can leave a partly written temp file behind).
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';

/** Error codes of a rename on Windows that a moment later may succeed (the target is open or being replaced). */
export const RENAME_RETRYABLE: ReadonlySet<string> = new Set(['EPERM', 'EBUSY', 'EACCES']);
/** Retries after the first attempt; the waits are 25 ms × 1, 2, … */
const DEFAULT_RENAME_RETRIES = 5;
const RENAME_RETRY_MS = 25;

export interface RenameRetryOptions {
  /** Retries after the first attempt (default 5). */
  retries?: number;
  /** Tests only: stand-ins for the rename and the wait between attempts. */
  rename?: (from: string, to: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}

export function errorCodeOf(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : '';
}

export async function renameWithRetry(from: string, to: string, options: RenameRetryOptions = {}): Promise<void> {
  const rename = options.rename ?? fsp.rename;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const retries = options.retries ?? DEFAULT_RENAME_RETRIES;
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      if (attempt >= retries || !RENAME_RETRYABLE.has(errorCodeOf(error))) throw error;
      await sleep(RENAME_RETRY_MS * (attempt + 1));
    }
  }
}

let tmpCounter = 0;

/** `<file>.<tag>-<pid>-<n>`: unique within this process, and next to the target so the rename stays on one volume. */
export function tmpPathFor(file: string, tag = 'tmp'): string {
  tmpCounter += 1;
  return `${file}.${tag}-${String(process.pid)}-${String(tmpCounter)}`;
}

export interface WriteFileAtomicOptions {
  /** File mode of the temp file (and so of the result). Absent: the default. */
  mode?: number;
  /** The temp file's tag (`tmpPathFor`). */
  tmpTag?: string;
}

/** Temp file + rename (retried). Removes the temp file on any error, then rethrows. */
export async function writeFileAtomic(
  file: string,
  data: string | Buffer,
  options: WriteFileAtomicOptions = {},
): Promise<void> {
  const tmp = tmpPathFor(file, options.tmpTag);
  try {
    await fsp.writeFile(tmp, data, options.mode === undefined ? undefined : { mode: options.mode });
    await renameWithRetry(tmp, file);
  } catch (error) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Owner-only text file in an owner-only folder (created when missing), written atomically. */
export async function writeTextAtomic(target: string, text: string): Promise<void> {
  await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await writeFileAtomic(target, text, { mode: 0o600 });
}

/**
 * Moves a file the app could not use aside to `<file>.bad-<epoch ms>`, so the next write does not destroy it
 * (templates.json, policy-rules.json). Returns the new name, or null when there is no file.
 */
export async function preserveBadFile(file: string, now: number): Promise<string | null> {
  const to = `${file}.bad-${String(now)}`;
  try {
    await fsp.rename(file, to);
    return to;
  } catch (error) {
    if (errorCodeOf(error) === 'ENOENT') return null;
    throw error;
  }
}
