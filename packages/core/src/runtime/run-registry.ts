/**
 * The live-run registry (M4 follow-up, ADR-020 known limits): `<dataDir>/runs.json`, the Huddle's own file. One entry per
 * managed run whose process this Huddle started and has not seen exit: `{ runId, pid, startedAt, command }`. Written
 * right after the spawn and removed at the exit, so after a crash it names the processes that may still be running.
 * Start-up reconciliation (orphans.ts, RunHost.reconcileOrphans) reads it, checks each pid, and empties it.
 *
 * Format: `{ "version": 1, "runs": RunRegistryEntry[] }`. Read with zod; unknown fields (top level and per entry) are
 * kept, and entries that do not validate are kept as they are, so a write never drops what a newer build wrote. A file
 * that is not JSON of that shape is moved aside (`runs.json.bad-<ts>`) before the next write, never overwritten.
 * Writes are atomic and owner-only (`writeTextAtomic`) and run one after another (`RunRegistry` queues them).
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { writeTextAtomic } from './atomic-file.js';

export const RUN_REGISTRY_FILENAME = 'runs.json';
export const RUN_REGISTRY_VERSION = 1;

/** A run id is the run's `--session-id`, a UUID (runs.ts). */
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const entrySchema = z.looseObject({
  runId: z.string().regex(RUN_ID),
  /** The pid of the spawned `claude` (the process whose tree a stop ends). */
  pid: z.number().int().positive().max(0xffffffff),
  /** Epoch ms, when the process started. */
  startedAt: z.number().int().nonnegative(),
  /** The executable spawned (an absolute path, or the harness's command), clipped. */
  command: z.string().max(4096),
});

export type RunRegistryEntry = z.output<typeof entrySchema>;

export interface RunRegistryFile {
  entries: RunRegistryEntry[];
  /** Entries that did not validate: kept so a write never drops them. Never acted on. */
  invalid: unknown[];
  /** Other top-level fields, kept as they are. */
  extra: Record<string, unknown>;
  /** The file exists but is not JSON of the expected shape; it is moved aside before the next write. */
  corrupt: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Pure: file text (null: no file) to entries. Never throws. A second entry for one run id is kept as invalid. */
export function parseRunRegistry(text: string | null): RunRegistryFile {
  const empty: RunRegistryFile = { entries: [], invalid: [], extra: {}, corrupt: false };
  if (text === null) return empty;
  let raw: unknown;
  try {
    raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return { ...empty, corrupt: true };
  }
  if (!isRecord(raw) || !Array.isArray(raw.runs)) return { ...empty, corrupt: true };
  const { runs, version: _version, ...extra } = raw;
  const entries: RunRegistryEntry[] = [];
  const invalid: unknown[] = [];
  const seen = new Set<string>();
  for (const item of runs as unknown[]) {
    const parsed = entrySchema.safeParse(item);
    if (parsed.success && !seen.has(parsed.data.runId.toLowerCase())) {
      seen.add(parsed.data.runId.toLowerCase());
      entries.push(parsed.data);
    } else {
      invalid.push(item);
    }
  }
  return { entries, invalid, extra, corrupt: false };
}

export function serializeRunRegistry(file: Pick<RunRegistryFile, 'entries' | 'invalid' | 'extra'>): string {
  return `${JSON.stringify(
    { ...file.extra, version: RUN_REGISTRY_VERSION, runs: [...file.entries, ...file.invalid] },
    null,
    2,
  )}\n`;
}

export function runRegistryPath(dataDir: string): string {
  return path.join(path.resolve(dataDir), RUN_REGISTRY_FILENAME);
}

function errorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : '';
}

/**
 * `runs.json`, read-modify-write one change at a time. Every method resolves after its change is on disk (or rejects
 * with the write error); a failed change does not block the ones queued after it.
 */
export class RunRegistry {
  readonly file: string;
  private readonly now: () => number;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: { dataDir: string; now: () => number }) {
    this.file = runRegistryPath(options.dataDir);
    this.now = options.now;
  }

  /** The file as it is now (missing: empty). Rejects only when the file exists and cannot be read. */
  async read(): Promise<RunRegistryFile> {
    let text: string | null;
    try {
      text = await fsp.readFile(this.file, 'utf8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return parseRunRegistry(null);
      throw error;
    }
    return parseRunRegistry(text);
  }

  /** Adds (or replaces) the entry for `entry.runId`. */
  add(entry: RunRegistryEntry): Promise<void> {
    return this.change((file) => ({
      ...file,
      entries: [...file.entries.filter((e) => e.runId.toLowerCase() !== entry.runId.toLowerCase()), entry],
    }));
  }

  /** Removes the entries of these runs (no file and nothing to remove: nothing is written). */
  remove(runIds: readonly string[]): Promise<void> {
    const gone = new Set(runIds.map((id) => id.toLowerCase()));
    return this.change((file) => {
      const entries = file.entries.filter((e) => !gone.has(e.runId.toLowerCase()));
      return entries.length === file.entries.length && !file.corrupt ? null : { ...file, entries };
    });
  }

  /** `edit` returns the new file, or null to write nothing. */
  private change(edit: (file: RunRegistryFile) => RunRegistryFile | null): Promise<void> {
    const run = this.queue.then(async () => {
      const file = await this.read();
      const next = edit(file);
      if (next === null) return;
      if (file.corrupt) {
        // Never overwrite a file that could not be read as ours: keep it aside.
        await fsp.rename(this.file, `${this.file}.bad-${String(this.now())}`).catch(() => undefined);
      }
      await writeTextAtomic(this.file, serializeRunRegistry(next));
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}
