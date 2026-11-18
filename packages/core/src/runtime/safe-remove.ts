/**
 * Deleting a folder tree without ever following a link (M5 WP5: the older JSONL history folders that "delete all
 * history" removes).
 *
 * Every entry is looked at with `lstat` before anything is done to it. A symbolic link, and on Windows a junction (Node
 * reports both as symbolic links from `lstat`), is removed as a link: the link itself goes, what it points to is never
 * opened, listed or deleted. A folder is emptied entry by entry and then removed. `fsp.rm({ recursive: true })` is not
 * used, because what it does with a junction is up to the Node version.
 *
 * Windows locking: a file another process holds open fails with EBUSY or EPERM; each removal is retried a few times with
 * a short wait, then the error is thrown (the caller reports it; whatever was removed stays removed).
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';

/** Deeper than any folder the Huddle writes; a deeper tree is refused rather than recursed into without end. */
export const MAX_REMOVE_DEPTH = 64;

const RETRYABLE: ReadonlySet<string> = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY']);
const RETRIES = 4;
const RETRY_MS = 50;

export interface RemoveTreeResult {
  /** False when nothing was there. */
  existed: boolean;
  files: number;
  folders: number;
  /** Links (symbolic links, junctions) removed as links, without touching what they point to. */
  links: number;
}

function codeOf(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : '';
}

async function retry(work: () => Promise<void>): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await work();
      return;
    } catch (error) {
      if (codeOf(error) === 'ENOENT') return;
      if (attempt >= RETRIES || !RETRYABLE.has(codeOf(error))) throw error;
      await new Promise((resolve) => setTimeout(resolve, RETRY_MS * (attempt + 1)));
    }
  }
}

/** Removes a link itself. A directory link on Windows (symlink or junction) needs rmdir when unlink refuses. */
async function removeLink(p: string): Promise<void> {
  try {
    await fsp.unlink(p);
  } catch (error) {
    const code = codeOf(error);
    if (code === 'ENOENT') return;
    if (code !== 'EPERM' && code !== 'EISDIR') throw error;
    // rmdir on a link removes the link: it never deletes the contents of the folder it points to.
    await retry(() => fsp.rmdir(p));
  }
}

async function removeEntry(p: string, depth: number, out: RemoveTreeResult): Promise<void> {
  let stat;
  try {
    stat = await fsp.lstat(p);
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    await removeLink(p);
    out.links += 1;
    return;
  }
  if (stat.isDirectory()) {
    if (depth >= MAX_REMOVE_DEPTH) throw new Error(`folder tree deeper than ${String(MAX_REMOVE_DEPTH)} levels`);
    for (const name of await fsp.readdir(p)) await removeEntry(path.join(p, name), depth + 1, out);
    await retry(() => fsp.rmdir(p));
    out.folders += 1;
    return;
  }
  await retry(async () => {
    try {
      await fsp.unlink(p);
    } catch (error) {
      // A read-only file on Windows refuses unlink with EPERM until its read-only bit is cleared.
      if (codeOf(error) !== 'EPERM') throw error;
      await fsp.chmod(p, 0o600);
      await fsp.unlink(p);
    }
  });
  out.files += 1;
}

/**
 * Removes `target` and everything under it, never following a link (see the module comment). A `target` that is itself
 * a link is removed as a link. Resolves with what was removed; rejects on the first entry that cannot be removed.
 */
export async function removeTreeNoFollow(target: string): Promise<RemoveTreeResult> {
  const out: RemoveTreeResult = { existed: false, files: 0, folders: 0, links: 0 };
  try {
    await fsp.lstat(target);
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return out;
    throw error;
  }
  out.existed = true;
  await removeEntry(path.resolve(target), 0, out);
  return out;
}

/**
 * The newest modification time of any file under `target`, never following a link (M5 security review M1: the
 * retention removes an older JSONL folder only when nothing in it is newer than the cutoff). A link counts with its own
 * time and is not entered; folders are entered but their own times do not count. `-Infinity` when there is no file (or
 * no `target`). Rejects on a read error or a tree deeper than MAX_REMOVE_DEPTH, so the caller keeps the folder.
 */
export async function newestFileMtimeNoFollow(target: string): Promise<number> {
  const walk = async (p: string, depth: number): Promise<number> => {
    let stat;
    try {
      stat = await fsp.lstat(p);
    } catch (error) {
      if (codeOf(error) === 'ENOENT') return Number.NEGATIVE_INFINITY;
      throw error;
    }
    if (!stat.isDirectory()) return stat.mtimeMs;
    if (depth >= MAX_REMOVE_DEPTH) throw new Error(`folder tree deeper than ${String(MAX_REMOVE_DEPTH)} levels`);
    let newest = Number.NEGATIVE_INFINITY;
    for (const name of await fsp.readdir(p)) newest = Math.max(newest, await walk(path.join(p, name), depth + 1));
    return newest;
  };
  return walk(path.resolve(target), 0);
}
