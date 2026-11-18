/**
 * Test helper for the history tests (M5 WP4b): recorded fixtures as stored sessions of their own (renamed session id,
 * unique event ids, shifted times, a folder of their own), longer logs that cross the replay checkpoints, and a temp
 * SQLite store. Not exported from the package.
 */
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentKey, type HuddleEvent } from '@huddle/shared';
import { serializeEvent } from '../store/codec.js';
import { SqliteEventStore } from '../store/sqlite-store.js';
import { fixtureEvents } from './replay-fixture.js';

/** Every string equal to `from`, or starting with `from::` (an agent key), now names session `to`. */
export function renameSession(value: unknown, from: string, to: string): unknown {
  if (typeof value === 'string') {
    if (value === from) return to;
    return value.startsWith(`${from}::`) ? to + value.slice(from.length) : value;
  }
  if (Array.isArray(value)) return value.map((v) => renameSession(v, from, to));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renameSession(v, from, to)]));
  }
  return value;
}

export interface SessionOptions {
  /** The last event's time. */
  lastTs: number;
  /** Replaces the root `session.started` cwd. */
  cwd?: string;
  /** Drop the session's `session.ended` (a run that has no end in the log, or ended by `run.exited`). */
  dropEnd?: boolean;
}

/** A recorded fixture (session-1) as session `sessionId`, unique ids, shifted so its last event is at `lastTs`. */
export function fixtureSession(fixture: string, sessionId: string, options: SessionOptions): HuddleEvent[] {
  const events = fixtureEvents(fixture).filter((e) => !(options.dropEnd === true && e.type === 'session.ended'));
  const shift = options.lastTs - Math.max(...events.map((e) => e.ts));
  return events.map((e) => {
    const renamed = renameSession(e, 'session-1', sessionId) as HuddleEvent;
    const moved = { ...renamed, id: `${sessionId}:${e.id}`, ts: e.ts + shift };
    if (options.cwd !== undefined && moved.type === 'session.started' && moved.agentKey === sessionId) {
      return { ...moved, cwd: options.cwd };
    }
    return moved;
  });
}

/**
 * A fixture session with `extra` more events after it (tool calls of the root, then the original ending moved to the
 * end), so a log crosses the replay checkpoints at 500 and 1000.
 */
export function longSession(fixture: string, sessionId: string, extra: number, lastTs: number): HuddleEvent[] {
  const base = fixtureSession(fixture, sessionId, { lastTs: lastTs - extra * 1000 - 1000 });
  const endIndex = base.findIndex((e) => e.type === 'session.ended');
  const ending = endIndex < 0 ? [] : base.splice(endIndex);
  const root = agentKey(sessionId);
  const start = Math.max(...base.map((e) => e.ts));
  const padding: HuddleEvent[] = [];
  for (let n = 0; n < extra; n++) {
    const toolUseId = `${sessionId}-pad-${String(n >> 1)}`;
    const ts = start + (n + 1) * 1000;
    padding.push(
      n % 2 === 0
        ? {
            id: `${sessionId}:pad-${String(n)}`,
            type: 'tool.started',
            ts,
            sessionId,
            agentKey: root,
            source: 'hook',
            toolUseId,
            toolName: 'Read',
            summary: `C:/Users/user/project/file-${String(n)}.ts`,
            filePath: `C:/Users/user/project/file-${String(n)}.ts`,
            inputDigest: `pad-${String(n)}`,
          }
        : {
            id: `${sessionId}:pad-${String(n)}`,
            type: 'tool.finished',
            ts,
            sessionId,
            agentKey: root,
            source: 'hook',
            toolUseId,
            toolName: 'Read',
            durationMs: 900,
          },
    );
  }
  const endTs = start + (extra + 1) * 1000;
  return [...base, ...padding, ...ending.map((e, i) => ({ ...e, ts: endTs + i }))];
}

/**
 * A telemetry-only fragment as seen in real data (M5 runbook): `model.observed`, `usage.recorded` and
 * `context.measured` for a session that has no session start, no prompt and so no main agent. Its last event is at
 * `lastTs`.
 */
export function fragmentSession(sessionId: string, lastTs: number): HuddleEvent[] {
  const key = agentKey(sessionId);
  const base = { sessionId, agentKey: key, source: 'telemetry' as const };
  return [
    {
      ...base,
      id: `${sessionId}:f1`,
      type: 'model.observed',
      ts: lastTs - 2000,
      model: 'claude-opus-5-5',
      via: 'telemetry',
    },
    {
      ...base,
      id: `${sessionId}:f2`,
      type: 'usage.recorded',
      ts: lastTs - 1000,
      model: 'claude-opus-5-5',
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      estimatedCostUsd: 0.001,
      requestId: `${sessionId}:q1`,
      querySourceKind: 'main',
    },
    {
      ...base,
      id: `${sessionId}:f3`,
      type: 'context.measured',
      ts: lastTs,
      usedTokens: 15,
      windowTokens: 200_000,
      measuredBy: 'telemetry',
    },
  ];
}

/**
 * A session opened and closed without a prompt: a root (session start, model unknown) that did nothing, ended
 * `durationMs` after it began, its end at `lastTs`. A run in the history list, but not a run of "main" for the
 * scorecards.
 */
export function idleSession(sessionId: string, lastTs: number, durationMs = 0): HuddleEvent[] {
  const key = agentKey(sessionId);
  const base = { sessionId, agentKey: key, source: 'hook' as const };
  return [
    {
      ...base,
      id: `${sessionId}:i1`,
      type: 'session.started',
      ts: lastTs - durationMs,
      origin: 'attached',
      cwd: 'C:/code/idle',
      title: null,
      model: null,
      startKind: 'startup',
    },
    { ...base, id: `${sessionId}:i2`, type: 'session.ended', ts: lastTs, reason: 'other' },
  ];
}

/** What a store hands back for an event (masked, `tool_response` dropped). */
export function stored(event: HuddleEvent): HuddleEvent {
  return JSON.parse(serializeEvent(event, () => undefined)) as HuddleEvent;
}

export interface TempStore {
  dir: string;
  store: SqliteEventStore;
  /** Closes the store and removes the folder. */
  cleanup: () => Promise<void>;
}

export async function tempStore(prefix = 'huddle-history-'): Promise<TempStore> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  const store = new SqliteEventStore({ file: path.join(dir, 'huddle.sqlite'), flushDelayMs: 1 });
  return {
    dir,
    store,
    cleanup: async () => {
      await store.close();
      await fsp.rm(dir, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}

/** Appends events in batches and waits until they are committed. */
export async function appendAll(store: SqliteEventStore, events: readonly HuddleEvent[], batch = 1000): Promise<void> {
  for (let i = 0; i < events.length; i += batch) {
    const done = store.append(events.slice(i, i + batch));
    await store.flush();
    await done;
  }
}

/** Every event of one session as the store reads it back. */
export async function readBack(store: SqliteEventStore, sessionId: string): Promise<HuddleEvent[]> {
  const out: HuddleEvent[] = [];
  for await (const e of store.readSession(sessionId)) out.push(e);
  return out;
}
