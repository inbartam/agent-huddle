/**
 * JsonlEventStore: the M1–M4 event log on disk (ARCHITECTURE.md §7).
 *
 *   <baseDir>/<sessionId>.jsonl   one HuddleEvent per line, append-only
 *   <baseDir>/index.json          { version, sessions: { <sessionId>: { firstTs, lastTs } } }
 *
 * Rules it keeps:
 *  - Append-only. Writes are batched and serialized through one queue, so lines from concurrent
 *    appends never interleave. `append` returns at once; its promise settles when the batch is on disk.
 *    The hook server never waits for it (it answers before handing events on).
 *  - Crash tolerant. The app can be killed mid-write, leaving a half line at the end of a file. Readers
 *    skip any line that is not a complete event. Before the first write to an existing file, the store
 *    checks the last byte and starts a new line if needed, so the next event is never glued to the
 *    broken one.
 *  - Never stores `tool_response`: events have no such field, and the serializer drops that key at any
 *    depth as a second line of defence (counted in `stats().strippedToolResponses`).
 *  - Session ids become file names, so they are checked: letters, digits, `.`, `_`, `-` only, no
 *    leading dot, no Windows device names. Events with any other session id are not written.
 *
 * Secrets are masked again on write (see `serialize`). Retention (30 days) and "delete all" are M5: on the JSONL
 * fallback they delete whole session files (`sessionFiles`, `deleteSessionFiles`; HuddleCore picks which).
 */
import { open, mkdir, readFile, readdir, rename, writeFile, appendFile, lstat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { HUDDLE_SESSION_IDS, type AgentKey, type EventStore, type HuddleEvent } from '@huddle/shared';
import { isRecord, parseStoredEvent, serializeEvent, sessionOfAgentKey } from './codec.js';

/** Most events `readAgentEvents` returns (the IPC `huddle:get-events` cap). */
export const MAX_AGENT_EVENTS = 500;
const INDEX_FILE = 'index.json';
const INDEX_VERSION = 1;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;
/** Windows refuses these as file names, with or without an extension. */
const WINDOWS_DEVICE_NAMES = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;

export class InvalidSessionIdError extends Error {
  constructor() {
    // The id itself is not echoed: it came from outside and may be anything.
    super('invalid session id: only letters, digits, ".", "_" and "-" are allowed');
    this.name = 'InvalidSessionIdError';
  }
}

/** True when the id can safely be used as `<id>.jsonl` inside the events folder. */
export function isValidSessionId(sessionId: unknown): sessionId is string {
  if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) return false;
  if (sessionId.includes('..')) return false;
  const stem = sessionId.split('.')[0] ?? '';
  return !WINDOWS_DEVICE_NAMES.test(stem);
}

/**
 * A session id an outside source (a hook, telemetry, the status line) may name: one the store accepts, and not one of
 * the Huddle's own sessions (budgets, history, phone, tasks), which only the core writes to.
 */
export function isIngestSessionId(sessionId: unknown): sessionId is string {
  return isValidSessionId(sessionId) && !HUDDLE_SESSION_IDS.includes(sessionId);
}

/**
 * `%APPDATA%/agent-huddle/events`. Without APPDATA: `~/AppData/Roaming` on Windows, else
 * `$XDG_CONFIG_HOME` or `~/.config`. The desktop app may pass Electron's userData path instead.
 */
export function defaultEventsDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): string {
  const appData =
    env.APPDATA !== undefined && env.APPDATA !== ''
      ? env.APPDATA
      : platform === 'win32'
        ? path.join(home, 'AppData', 'Roaming')
        : env.XDG_CONFIG_HOME !== undefined && env.XDG_CONFIG_HOME !== ''
          ? env.XDG_CONFIG_HOME
          : path.join(home, '.config');
  return path.join(appData, 'agent-huddle', 'events');
}

export interface SessionSummary {
  sessionId: string;
  firstTs: number;
  lastTs: number;
}

export interface JsonlEventStoreOptions {
  /** Defaults to `defaultEventsDir()`. */
  baseDir?: string;
  /** How long appends are gathered before one write. Defaults to 25 ms. */
  flushDelayMs?: number;
}

export interface JsonlEventStoreStats {
  written: number;
  /** Events not written because their session id cannot be a file name. */
  rejectedInvalidSession: number;
  /** `tool_response` keys removed by the serializer (should stay 0). */
  strippedToolResponses: number;
  /** Lines skipped while reading (half-written or not an event). */
  skippedLines: number;
}

/** What the desktop uses: the shared contract plus the per-agent read behind `huddle:get-events`. */
export interface HuddleEventStore extends EventStore {
  readAgentEvents(agentKey: AgentKey, limit?: number): Promise<HuddleEvent[]>;
  listSessions(options?: { limit?: number }): Promise<SessionSummary[]>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

interface Waiter {
  resolve: () => void;
  reject: (error: unknown) => void;
}

interface PendingSession {
  lines: string[];
  firstTs: number;
  lastTs: number;
  waiters: Waiter[];
}

export class JsonlEventStore implements HuddleEventStore {
  readonly baseDir: string;
  private readonly flushDelayMs: number;
  private pending = new Map<string, PendingSession>();
  private timer: NodeJS.Timeout | null = null;
  /** Every disk write runs on this chain, one after another. */
  private chain: Promise<void> = Promise.resolve();
  private index: Map<string, { firstTs: number; lastTs: number }> | null = null;
  /** Sessions whose file tail has been checked (and repaired) in this process. */
  private readonly tailChecked = new Set<string>();
  private dirReady = false;
  private closed = false;
  private readonly counters: JsonlEventStoreStats = {
    written: 0,
    rejectedInvalidSession: 0,
    strippedToolResponses: 0,
    skippedLines: 0,
  };

  constructor(options: JsonlEventStoreOptions = {}) {
    this.baseDir = path.resolve(options.baseDir ?? defaultEventsDir());
    this.flushDelayMs = options.flushDelayMs ?? 25;
  }

  stats(): JsonlEventStoreStats {
    return { ...this.counters };
  }

  /**
   * Queues events for writing and returns at once. The promise resolves when they are on disk and
   * rejects if that write failed. Events with an invalid session id are skipped and counted.
   */
  append(events: readonly HuddleEvent[]): Promise<void> {
    if (this.closed) return Promise.reject(new Error('JsonlEventStore is closed'));
    const touched = new Map<string, PendingSession>();
    for (const event of events) {
      if (!isValidSessionId(event.sessionId)) {
        this.counters.rejectedInvalidSession += 1;
        continue;
      }
      let entry = this.pending.get(event.sessionId);
      if (!entry) {
        entry = { lines: [], firstTs: event.ts, lastTs: event.ts, waiters: [] };
        this.pending.set(event.sessionId, entry);
      }
      entry.lines.push(this.serialize(event));
      entry.firstTs = Math.min(entry.firstTs, event.ts);
      entry.lastTs = Math.max(entry.lastTs, event.ts);
      touched.set(event.sessionId, entry);
    }
    if (touched.size === 0) return Promise.resolve();
    const done = Promise.all(
      [...touched.values()].map(
        (entry) =>
          new Promise<void>((resolve, reject) => {
            entry.waiters.push({ resolve, reject });
          }),
      ),
    ).then(() => undefined);
    this.schedule();
    return done;
  }

  /** Writes everything queued so far; resolves when it is on disk. Never rejects. */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // Failures reach the append promises; the chain itself must never stay rejected.
    this.chain = this.chain.then(() => this.writePending()).catch(() => undefined);
    return this.chain;
  }

  /** Flushes and stops accepting appends. */
  async close(): Promise<void> {
    this.closed = true;
    await this.flush();
  }

  /** Events of one session in file order. Pending appends are flushed first. */
  async *readSession(sessionId: string): AsyncIterable<HuddleEvent> {
    if (!isValidSessionId(sessionId)) throw new InvalidSessionIdError();
    await this.flush();
    yield* this.readFileEvents(this.sessionFile(sessionId));
  }

  /**
   * The newest `limit` events of one agent (oldest first), for `huddle:get-events`.
   * `limit` is clamped to 1..500; anything not a finite number means 500.
   */
  async readAgentEvents(agentKey: AgentKey, limit: number = MAX_AGENT_EVENTS): Promise<HuddleEvent[]> {
    const sessionId = sessionOfAgentKey(agentKey);
    if (!isValidSessionId(sessionId)) throw new InvalidSessionIdError();
    const cap = Number.isFinite(limit) ? Math.min(MAX_AGENT_EVENTS, Math.max(1, Math.floor(limit))) : MAX_AGENT_EVENTS;
    const ring: HuddleEvent[] = [];
    for await (const event of this.readSession(sessionId)) {
      if (event.agentKey !== agentKey) continue;
      ring.push(event);
      if (ring.length > cap) ring.shift();
    }
    return ring;
  }

  /** Sessions, most recently active first. */
  async listSessions(options: { limit?: number } = {}): Promise<SessionSummary[]> {
    await this.flush();
    const index = await this.loadIndex();
    const all = [...index.entries()]
      .map(([sessionId, span]) => ({ sessionId, firstTs: span.firstTs, lastTs: span.lastTs }))
      .sort((a, b) => b.lastTs - a.lastTs || a.sessionId.localeCompare(b.sessionId));
    const limit = options.limit;
    return limit !== undefined && Number.isFinite(limit) ? all.slice(0, Math.max(0, Math.floor(limit))) : all;
  }

  /**
   * The JSONL fallback's retention and "delete all" (M5 security review M1): every `<sessionId>.jsonl` in the folder
   * with its own modification time, read with `lstat` (a link is not followed; its own time counts). Pending appends
   * are flushed first. Names that are not a session file, and folders, are left out. Never rejects.
   */
  async sessionFiles(): Promise<{ sessionId: string; mtimeMs: number }[]> {
    await this.flush();
    let names: string[];
    try {
      names = await readdir(this.baseDir);
    } catch {
      return [];
    }
    const out: { sessionId: string; mtimeMs: number }[] = [];
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const sessionId = name.slice(0, -'.jsonl'.length);
      if (!isValidSessionId(sessionId)) continue;
      try {
        const stat = await lstat(this.sessionFile(sessionId));
        if (stat.isFile() || stat.isSymbolicLink()) out.push({ sessionId, mtimeMs: stat.mtimeMs });
      } catch {
        // Gone meanwhile.
      }
    }
    return out.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  }

  /**
   * Deletes these sessions' files with `remove` (the caller's no-follow removal, runtime/safe-remove.ts), on the write
   * chain, so no append to them runs meanwhile; pending lines are written first. The index forgets them. Resolves with
   * the ids whose file went and the problems in words (never file contents); never rejects.
   */
  deleteSessionFiles(
    ids: readonly string[],
    remove: (file: string) => Promise<unknown>,
  ): Promise<{ deleted: string[]; problems: string[] }> {
    const result = { deleted: [] as string[], problems: [] as string[] };
    const work = async (): Promise<void> => {
      await this.writePending();
      const index = await this.loadIndex().catch(() => null);
      let indexChanged = false;
      for (const sessionId of ids) {
        if (!isValidSessionId(sessionId)) continue;
        try {
          await remove(this.sessionFile(sessionId));
          result.deleted.push(sessionId);
          this.tailChecked.delete(sessionId);
          if (index?.delete(sessionId) === true) indexChanged = true;
        } catch (error) {
          result.problems.push(
            `${sessionId}.jsonl: ${error instanceof Error ? error.message : 'could not be removed'}`,
          );
        }
      }
      if (index !== null && indexChanged) await this.saveIndex(index).catch(() => undefined);
    };
    const run = this.chain.then(work);
    this.chain = run.catch(() => undefined);
    return run.then(
      () => result,
      () => result,
    );
  }

  // ---------------------------------------------------------------------------

  private sessionFile(sessionId: string): string {
    return path.join(this.baseDir, `${sessionId}.jsonl`);
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.flushDelayMs);
  }

  /** The shared store serializer (codec.ts): `tool_response` dropped at any depth, secrets masked again. */
  private serialize(event: HuddleEvent): string {
    return serializeEvent(event, () => {
      this.counters.strippedToolResponses += 1;
    });
  }

  private async ensureDir(): Promise<void> {
    if (this.dirReady) return;
    await mkdir(this.baseDir, { recursive: true, mode: 0o700 });
    this.dirReady = true;
  }

  /** One flush cycle. Each session is written separately; one failure does not lose the others. */
  private async writePending(): Promise<void> {
    if (this.pending.size === 0) return;
    const batch = this.pending;
    this.pending = new Map();
    let indexChanged = false;
    let index: Map<string, { firstTs: number; lastTs: number }>;
    try {
      await this.ensureDir();
      index = await this.loadIndex();
    } catch (error) {
      for (const entry of batch.values()) for (const waiter of entry.waiters) waiter.reject(error);
      return;
    }
    const written: Waiter[] = [];
    for (const [sessionId, entry] of batch) {
      try {
        const file = this.sessionFile(sessionId);
        const prefix = (await this.needsNewline(sessionId, file)) ? '\n' : '';
        await appendFile(file, prefix + entry.lines.join('\n') + '\n', { encoding: 'utf8', mode: 0o600 });
        this.counters.written += entry.lines.length;
        const span = index.get(sessionId);
        if (!span) {
          index.set(sessionId, { firstTs: entry.firstTs, lastTs: entry.lastTs });
          indexChanged = true;
        } else if (entry.firstTs < span.firstTs || entry.lastTs > span.lastTs) {
          span.firstTs = Math.min(span.firstTs, entry.firstTs);
          span.lastTs = Math.max(span.lastTs, entry.lastTs);
          indexChanged = true;
        }
        written.push(...entry.waiters);
      } catch (error) {
        for (const waiter of entry.waiters) waiter.reject(error);
      }
    }
    if (indexChanged) {
      // The index is a cache of the session files: if writing it fails, the next start rebuilds it.
      await this.saveIndex(index).catch(() => undefined);
    }
    for (const waiter of written) waiter.resolve();
  }

  /** True if the file exists, is not empty and does not end in a newline (a crash cut the last line). */
  private async needsNewline(sessionId: string, file: string): Promise<boolean> {
    if (this.tailChecked.has(sessionId)) return false;
    this.tailChecked.add(sessionId);
    let handle;
    try {
      handle = await open(file, 'r');
    } catch {
      return false; // no file yet
    }
    try {
      const { size } = await handle.stat();
      if (size === 0) return false;
      const last = Buffer.alloc(1);
      await handle.read(last, 0, 1, size - 1);
      return last[0] !== 0x0a;
    } finally {
      await handle.close();
    }
  }

  private async *readFileEvents(file: string): AsyncIterable<HuddleEvent> {
    const stream = createReadStream(file, { encoding: 'utf8' });
    const missing = new Promise<boolean>((resolve) => {
      stream.once('error', (error: NodeJS.ErrnoException) => {
        resolve(error.code === 'ENOENT');
      });
      stream.once('open', () => {
        resolve(false);
      });
    });
    if (await missing) return;
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (line.trim() === '') continue;
        const event = parseStoredEvent(line);
        if (event) yield event;
        else this.counters.skippedLines += 1;
      }
    } finally {
      lines.close();
      stream.destroy();
    }
  }

  private async loadIndex(): Promise<Map<string, { firstTs: number; lastTs: number }>> {
    if (this.index) return this.index;
    const loaded = await this.readIndexFile();
    this.index = loaded ?? (await this.rebuildIndex());
    return this.index;
  }

  private async readIndexFile(): Promise<Map<string, { firstTs: number; lastTs: number }> | null> {
    try {
      const raw: unknown = JSON.parse(await readFile(path.join(this.baseDir, INDEX_FILE), 'utf8'));
      if (!isRecord(raw) || raw.version !== INDEX_VERSION || !isRecord(raw.sessions)) return null;
      const index = new Map<string, { firstTs: number; lastTs: number }>();
      for (const [sessionId, span] of Object.entries(raw.sessions)) {
        if (!isValidSessionId(sessionId) || !isRecord(span)) continue;
        if (typeof span.firstTs !== 'number' || typeof span.lastTs !== 'number') continue;
        index.set(sessionId, { firstTs: span.firstTs, lastTs: span.lastTs });
      }
      return index;
    } catch {
      return null; // missing or corrupt: rebuild from the session files
    }
  }

  private async rebuildIndex(): Promise<Map<string, { firstTs: number; lastTs: number }>> {
    const index = new Map<string, { firstTs: number; lastTs: number }>();
    let names: string[];
    try {
      names = await readdir(this.baseDir);
    } catch {
      return index;
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const sessionId = name.slice(0, -'.jsonl'.length);
      if (!isValidSessionId(sessionId)) continue;
      let firstTs = Infinity;
      let lastTs = -Infinity;
      for await (const event of this.readFileEvents(this.sessionFile(sessionId))) {
        firstTs = Math.min(firstTs, event.ts);
        lastTs = Math.max(lastTs, event.ts);
      }
      if (Number.isFinite(firstTs)) index.set(sessionId, { firstTs, lastTs });
    }
    return index;
  }

  /** Write to a temp file, then rename over the old index, so a crash never leaves half an index. */
  private async saveIndex(index: Map<string, { firstTs: number; lastTs: number }>): Promise<void> {
    const target = path.join(this.baseDir, INDEX_FILE);
    const temp = `${target}.tmp`;
    const text = JSON.stringify({ version: INDEX_VERSION, sessions: Object.fromEntries(index) }, null, 2);
    await writeFile(temp, text, { encoding: 'utf8', mode: 0o600 });
    try {
      await rename(temp, target);
    } catch {
      // Windows can refuse the rename while another process (an indexer, antivirus) has the file open.
      await writeFile(target, text, { encoding: 'utf8', mode: 0o600 });
    }
  }
}
