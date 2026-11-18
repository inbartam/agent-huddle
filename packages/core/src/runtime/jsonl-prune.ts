/**
 * History deletion on the JSONL fallback (M5 security review M1). When the database cannot be opened the Huddle records
 * to `<dataDir>/events/<sessionId>.jsonl` (ADR-021 §2); retention and "delete all history" then delete whole session
 * files. HuddleCore picks the files (live sessions and the overall budgets' file are never picked) and the store deletes
 * them on its write chain, without following links (runtime/safe-remove.ts).
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';

export interface SessionFileTime {
  sessionId: string;
  /** The file's own modification time (`lstat`). */
  mtimeMs: number;
}

export type JsonlPick = { kind: 'retention'; cutoff: number } | { kind: 'delete_all' };

/**
 * Pure. The sessions to delete: every file not in `keep`; for a retention only those last written before `cutoff`.
 * In file order (by session id).
 */
export function pickJsonlSessions(
  files: readonly SessionFileTime[],
  pick: JsonlPick,
  keep: ReadonlySet<string>,
): string[] {
  return files
    .filter((f) => !keep.has(f.sessionId) && (pick.kind === 'delete_all' || f.mtimeMs < pick.cutoff))
    .map((f) => f.sessionId);
}

/** The `events.migrated-*` folders an earlier import left in the data folder (links too: they are removed as links). */
export async function migratedJsonlFolders(dataDir: string): Promise<string[]> {
  const root = path.resolve(dataDir);
  let names: string[];
  try {
    names = await fsp.readdir(root);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.startsWith('events.migrated-'))
    .map((name) => path.join(root, name))
    .sort();
}
