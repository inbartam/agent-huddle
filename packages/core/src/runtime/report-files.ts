/**
 * The run reports' Markdown files (M5 WP4b, F23): `<dataDir>/reports/<sessionId>.md`.
 *
 *  - The path comes only from a session id the store accepts (`isValidSessionId`: letters, digits, `.`, `_`, `-`, no
 *    `..`), and the resolved path is checked again to be a file directly inside the reports folder, so no id can name
 *    a file anywhere else. The renderer never sends a path; open and copy go by session id.
 *  - Written whole or not at all: a temp file next to it (created exclusively, mode 0o600), then a rename over the old
 *    one. The folder is created user-only (0o700) and both modes are set again on POSIX; on Windows the mode bits are
 *    mostly ignored and `%APPDATA%` is user-only already.
 *  - The content is what `renderReportMarkdown` made (agent text escaped there); nothing is read back from the file.
 *  - One write per session at a time (`ReportFileWriter`). On Windows a rename over a file that another rename is
 *    replacing fails with EPERM: two writes of one report at once (the end-of-run report and `report.make`) failed
 *    about 1 in 10 pairs in a test. A request made while that session's write is in flight waits for the next write,
 *    and requests that wait together share it, with the newest content.
 *  - The rename is retried a few times with a short wait on EPERM, EBUSY and EACCES, for what the writer cannot
 *    serialize: another program (an editor, an indexer, antivirus) holding the old file open for a moment. Then it fails
 *    and the temp file is removed; the caller logs it and the next open writes it again.
 */
import { randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { isValidSessionId } from '../store/jsonl-store.js';
import { renameWithRetry } from './atomic-file.js';

export const REPORTS_DIRNAME = 'reports';
const EXTENSION = '.md';

export function reportsDirOf(dataDir: string): string {
  return path.join(path.resolve(dataDir), REPORTS_DIRNAME);
}

/** True when `candidate` resolves to a file directly inside `dir` (not `dir` itself, not deeper, not outside). */
export function isInsideReportsDir(
  dir: string,
  candidate: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const api = platform === 'win32' ? path.win32 : path.posix;
  const root = api.resolve(dir);
  const resolved = api.resolve(candidate);
  const parent = api.dirname(resolved);
  const same = platform === 'win32' ? parent.toLowerCase() === root.toLowerCase() : parent === root;
  return same && resolved.length > root.length + 1;
}

/** `<dataDir>/reports/<sessionId>.md`, or null for a session id the store would not accept or a path outside. */
export function reportPathFor(dataDir: string, sessionId: string): string | null {
  if (!isValidSessionId(sessionId)) return null;
  const dir = reportsDirOf(dataDir);
  const file = path.join(dir, `${sessionId}${EXTENSION}`);
  return isInsideReportsDir(dir, file) ? file : null;
}

async function restrict(target: string, mode: number): Promise<void> {
  if (process.platform === 'win32') return;
  try {
    await fsp.chmod(target, mode);
  } catch {
    // Best effort (another owner, a file system without modes); the file is still written.
  }
}

/** Retries after the first attempt; the waits are 25 ms × 1, 2, 3, 4 (250 ms in all). */
export const RENAME_RETRIES = 4;

/** Tests only: stand-ins for the rename and the wait between attempts. */
export interface ReportFileOps {
  rename?: (from: string, to: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Writes the report file atomically: a temp file, then a rename over the old one (retried, see the module comment).
 * Rejects on any I/O error, after removing the temp file (the caller logs it and retries later). Two calls for one
 * session at once can still collide; go through `ReportFileWriter`.
 */
export async function writeReportFile(
  dataDir: string,
  sessionId: string,
  markdown: string,
  ops: ReportFileOps = {},
): Promise<string> {
  const file = reportPathFor(dataDir, sessionId);
  if (file === null) throw new Error('invalid session id for a report file');
  const dir = path.dirname(file);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  await restrict(dir, 0o700);
  const temp = path.join(dir, `.${sessionId}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await fsp.writeFile(temp, markdown, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await restrict(temp, 0o600);
    await renameWithRetry(temp, file, { ...ops, retries: RENAME_RETRIES });
  } catch (error) {
    await fsp.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
  return file;
}

interface PendingWrite {
  markdown: string;
  waiters: { resolve: (file: string | null) => void; reject: (error: unknown) => void }[];
}

/**
 * The run reports' writer: one `writeReportFile` per session at a time. A request made while that session's write is in
 * flight waits for the next write; the requests that wait together are coalesced into it, which writes the newest
 * content (the last request's) and settles them all with its result. Different sessions write in parallel.
 *
 * Deleted sessions (M5 WP5, F22): `refuse` marks session ids whose history is being or was deleted. A marked id gets no
 * write: a new request, and one already waiting in the queue, resolve with null (not written) instead. A write already
 * past that check (in flight) is not stopped; the deletion waits for it with `idle()` after marking and then removes
 * the file. `allow` clears a mark (the history service calls it when the session has a new event).
 */
export class ReportFileWriter {
  /** Per session with a write in flight: its drain loop (ends when nothing is waiting). */
  private readonly running = new Map<string, Promise<void>>();
  private readonly pending = new Map<string, PendingWrite>();
  /** Kept for the life of the process (one short string per deleted session). */
  private readonly refused = new Set<string>();

  constructor(
    private readonly dataDir: string,
    private readonly ops: ReportFileOps = {},
  ) {}

  /** Marks these sessions as deleted: no report file is written for them until `allow`. */
  refuse(sessionIds: Iterable<string>): void {
    for (const id of sessionIds) this.refused.add(id);
  }

  /** Clears a session's mark: its reports are written again. */
  allow(sessionId: string): void {
    this.refused.delete(sessionId);
  }

  isRefused(sessionId: string): boolean {
    return this.refused.has(sessionId);
  }

  /**
   * Resolves with the file once a write that started after this call (with this content or newer) succeeded, or with
   * null when the session is marked deleted (nothing is written). Rejects when that write failed.
   */
  write(sessionId: string, markdown: string): Promise<string | null> {
    // Checked here too, not only in drain(): drain()'s first step must always find this request and write it (see below).
    if (this.refused.has(sessionId)) return Promise.resolve(null);
    return new Promise<string | null>((resolve, reject) => {
      const waiting = this.pending.get(sessionId);
      if (waiting === undefined) {
        this.pending.set(sessionId, { markdown, waiters: [{ resolve, reject }] });
      } else {
        waiting.markdown = markdown;
        waiting.waiters.push({ resolve, reject });
      }
      // A `running` entry means a loop will look at `pending` again: drain() removes its entry in the same step that
      // finds nothing waiting, and its first step (which always finds this request) never does.
      if (!this.running.has(sessionId)) this.running.set(sessionId, this.drain(sessionId));
    });
  }

  /** Waits until no write is in flight (quit, deleting history). */
  async idle(): Promise<void> {
    while (this.running.size > 0) await Promise.allSettled([...this.running.values()]);
  }

  private async drain(sessionId: string): Promise<void> {
    for (;;) {
      const job = this.pending.get(sessionId);
      if (job === undefined) {
        this.running.delete(sessionId);
        return;
      }
      this.pending.delete(sessionId);
      // Marked while it waited (a deletion started): it must not recreate the file.
      if (this.refused.has(sessionId)) {
        for (const w of job.waiters) w.resolve(null);
        continue;
      }
      try {
        const file = await writeReportFile(this.dataDir, sessionId, job.markdown, this.ops);
        for (const w of job.waiters) w.resolve(file);
      } catch (error) {
        for (const w of job.waiters) w.reject(error);
      }
    }
  }
}

/** Whether the file is there (a regular file); never throws. */
export async function reportFileExists(file: string): Promise<boolean> {
  try {
    return (await fsp.stat(file)).isFile();
  } catch {
    return false;
  }
}

/** Total size of the regular files directly in the reports folder; 0 when it does not exist. */
export async function reportsDirBytes(dataDir: string): Promise<number> {
  const dir = reportsDirOf(dataDir);
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return 0;
  }
  let total = 0;
  for (const name of names) {
    try {
      const stat = await fsp.stat(path.join(dir, name));
      if (stat.isFile()) total += stat.size;
    } catch {
      // Gone in between.
    }
  }
  return total;
}
