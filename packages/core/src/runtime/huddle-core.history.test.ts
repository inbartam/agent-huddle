/**
 * HuddleCore on the SQLite store (M5 WP2, F22): the first start with an M1-M4 `events/` folder imports it, the
 * start-up replay loads open sessions, sessions active in the last 24 hours and the overall budgets, and leaves older
 * ended sessions in the database only.
 */
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { etaPriorsFrom, selectBudgetUsed, type HuddleEvent } from '@huddle/shared';
import { agentRunRows } from '../report/agent-runs.js';
import { computeScorecards } from '../report/scorecards.js';
import { replay, toHuddleState } from '../state/reduce.js';
import { serializeEvent } from '../store/codec.js';
import { JsonlEventStore } from '../store/jsonl-store.js';
import { META_MIGRATED_AT, migratedFolderName } from '../store/migrate-jsonl.js';
import { SqliteEventStore } from '../store/sqlite-store.js';
import { fixtureEvents } from '../test/replay-fixture.js';
import { BUDGET_SESSION_ID, HuddleCore, type HuddleLogger } from './huddle-core.js';
import { REPLAY_RECENT_MS } from './replay-window.js';

const NOW = Date.parse('2026-11-14T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function makeEnv(): Promise<{ root: string; dataDir: string; claudeDir: string; forwarder: string }> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'huddle-core-history-'));
  const env = {
    root,
    dataDir: path.join(root, 'data'),
    claudeDir: path.join(root, 'claude'),
    forwarder: path.join(root, 'forwarder.mjs'),
  };
  await fsp.mkdir(env.claudeDir, { recursive: true });
  await fsp.writeFile(env.forwarder, '// test forwarder\n');
  cleanups.push(() => fsp.rm(root, { recursive: true, force: true, maxRetries: 5 }));
  return env;
}

function makeCore(
  env: { dataDir: string; claudeDir: string; forwarder: string },
  logger?: HuddleLogger,
  history?: { priorsDelayMs: number },
): HuddleCore {
  const core = new HuddleCore({
    ...(history ? { history } : {}),
    dataDir: env.dataDir,
    claudeConfigDir: env.claudeDir,
    cwd: null,
    userAgentsDir: null,
    port: 0,
    now: () => NOW,
    forwarderSource: env.forwarder,
    newToken: () => 'test-token-0123456789',
    ...(logger ? { logger } : {}),
  });
  cleanups.push(() => core.dispose());
  return core;
}

/** Every string equal to `from`, or starting with `from::` (an agent key), now names session `to`. */
function renameSession(value: unknown, from: string, to: string): unknown {
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

/** A recorded fixture as session `sessionId`, unique ids, shifted so its last event is at `lastTs`. */
function session(fixture: string, sessionId: string, lastTs: number): HuddleEvent[] {
  const events = fixtureEvents(fixture);
  const shift = lastTs - Math.max(...events.map((e) => e.ts));
  return events.map((e) => {
    const renamed = renameSession(e, 'session-1', sessionId) as HuddleEvent;
    return { ...renamed, id: `${sessionId}:${e.id}`, ts: e.ts + shift };
  });
}

/** What a store hands back for an event. */
function stored(event: HuddleEvent): HuddleEvent {
  return JSON.parse(serializeEvent(event, () => undefined)) as HuddleEvent;
}

function overallBudget(ts: number): HuddleEvent {
  return {
    id: 'budget-old',
    type: 'budget.set',
    ts,
    sessionId: BUDGET_SESSION_ID,
    agentKey: BUDGET_SESSION_ID,
    source: 'user',
    scope: 'overall',
    targetKey: null,
    budget: { scope: 'overall', maxTokens: 1_000_000_000, warnAtFraction: 0.8, onExceed: 'notify' },
  };
}

describe('HuddleCore start-up on SQLite', () => {
  it('imports an old events folder and replays only open, recent and budget sessions', async () => {
    const env = await makeEnv();
    const recent = session('parallel-subagents.jsonl', 'recent-ended', NOW - HOUR);
    const oldEnded = session('single-agent.jsonl', 'old-ended', NOW - 3 * REPLAY_RECENT_MS);
    const oldOpen = session('agent-messages.jsonl', 'old-open', NOW - 3 * REPLAY_RECENT_MS);
    // Set after every session above, so it does not reach back to old-ended (see the budget test below).
    const budget = overallBudget(NOW - HOUR / 2);
    expect(oldEnded.some((e) => e.type === 'session.ended' && e.agentKey === 'old-ended')).toBe(true);
    expect(oldOpen.some((e) => e.type === 'session.ended')).toBe(false);
    const seed = new JsonlEventStore({ baseDir: path.join(env.dataDir, 'events') });
    await seed.append([...recent, ...oldEnded, ...oldOpen, budget]);
    await seed.close();
    const infos: string[] = [];
    const logger: HuddleLogger = {
      info: (m) => infos.push(m),
      warn: () => undefined,
      error: () => undefined,
    };

    const core = makeCore(env, logger);
    expect((await core.start()).ok).toBe(true);

    // What the M1-M4 JSONL replay built for the loaded sessions, in the order they began.
    const expected = toHuddleState(replay([...oldOpen, ...recent, budget].map(stored)));
    const state = core.getState();
    expect(state.agents).toEqual(expected.agents);
    expect(state.rootKeys).toEqual(expected.rootKeys);
    expect(state.budgets).toEqual(expected.budgets);
    expect(state.budgets?.length).toBe(1);
    expect(Object.keys(state.agents).some((k) => k.startsWith('old-ended'))).toBe(false);
    expect(core.stats().storeKind).toBe('sqlite');
    expect(infos).toContain('imported JSONL history into SQLite');

    // The folder was renamed, not deleted, and the old session is in the database for the history view.
    const names = await fsp.readdir(env.dataDir);
    expect(names).toContain(migratedFolderName(NOW));
    expect(names).not.toContain('events');
    await core.dispose();
    const db = new SqliteEventStore({ file: path.join(env.dataDir, 'huddle.sqlite') });
    try {
      const records = await db.listSessionRecords();
      expect(records.map((r) => r.sessionId).sort()).toEqual(
        [BUDGET_SESSION_ID, 'old-ended', 'old-open', 'recent-ended'].sort(),
      );
      expect(records.find((r) => r.sessionId === 'old-ended')).toMatchObject({ ended: true });
      expect(db.readMeta(META_MIGRATED_AT)).toBe(new Date(NOW).toISOString());
    } finally {
      await db.close();
    }
  });

  it('keeps every session that ran while an overall budget is in force, and counts it toward the budget', async () => {
    const env = await makeEnv();
    const budget = overallBudget(NOW - 3 * REPLAY_RECENT_MS);
    const underBudget = session('interactive-helpers.jsonl', 'under-budget', NOW - 2 * REPLAY_RECENT_MS);
    const beforeBudget = session('compaction.jsonl', 'before-budget', NOW - 5 * REPLAY_RECENT_MS);
    for (const [events, id] of [
      [underBudget, 'under-budget'],
      [beforeBudget, 'before-budget'],
    ] as const) {
      expect(events.some((e) => e.type === 'session.ended' && e.agentKey === id)).toBe(true);
      expect(events.some((e) => e.type === 'usage.recorded')).toBe(true);
    }
    const seed = new JsonlEventStore({ baseDir: path.join(env.dataDir, 'events') });
    await seed.append([...beforeBudget, budget, ...underBudget]);
    await seed.close();

    const core = makeCore(env);
    expect((await core.start()).ok).toBe(true);

    const state = core.getState();
    expect(state.rootKeys).toContain('under-budget');
    expect(state.rootKeys).not.toContain('before-budget');
    const entry = state.budgets?.find((b) => b.scope === 'overall');
    expect(entry?.setAt).toBe(budget.ts);
    if (entry === undefined) return;
    const used = selectBudgetUsed(state, entry, NOW);
    const expected = toHuddleState(replay([budget, ...underBudget].map(stored)));
    expect(used.tokens).toBeGreaterThan(0);
    expect(used).toEqual(selectBudgetUsed(expected, entry, NOW));
  });

  it('a second start does not import again and replays the same state', async () => {
    const env = await makeEnv();
    const seed = new JsonlEventStore({ baseDir: path.join(env.dataDir, 'events') });
    await seed.append(session('single-agent.jsonl', 'today', NOW - HOUR));
    await seed.close();
    const first = makeCore(env);
    expect((await first.start()).ok).toBe(true);
    const before = first.getState();
    await first.dispose();

    const infos: string[] = [];
    const second = makeCore(env, { info: (m) => infos.push(m), warn: () => undefined, error: () => undefined });
    expect((await second.start()).ok).toBe(true);
    expect(second.getState().agents).toEqual(before.agents);
    expect(infos).not.toContain('imported JSONL history into SQLite');
  });

  it('starts on the JSONL log when the database cannot be opened, and never touches the file', async () => {
    const env = await makeEnv();
    await fsp.mkdir(env.dataDir, { recursive: true });
    const file = path.join(env.dataDir, 'huddle.sqlite');
    await fsp.writeFile(file, 'this is not a database, but somebody might want it back');
    const errors: string[] = [];
    const core = makeCore(env, { info: () => undefined, warn: () => undefined, error: (m) => errors.push(m) });
    expect((await core.start()).ok).toBe(true);
    expect(core.stats().storeKind).toBe('jsonl-fallback');
    expect(errors).toContain('could not open the event database; recording to the JSONL log instead');
    expect(await fsp.readFile(file, 'utf8')).toBe('this is not a database, but somebody might want it back');
  });
});

describe('HuddleCore ETA priors (M5 WP7)', () => {
  it('fills getState().priors from the stored scorecards after the backfill and tells listeners to read the state', async () => {
    const env = await makeEnv();
    const runs = [
      session('parallel-subagents.jsonl', 'run-a', NOW - 4 * HOUR),
      session('nested-subagents.jsonl', 'run-b', NOW - 3 * HOUR),
      session('failure.jsonl', 'run-c', NOW - 2 * HOUR),
      session('single-agent.jsonl', 'run-d', NOW - HOUR),
    ];
    const seed = new JsonlEventStore({ baseDir: path.join(env.dataDir, 'events') });
    await seed.append(runs.flat());
    await seed.close();

    const core = makeCore(env, undefined, { priorsDelayMs: 0 });
    let emptyBatches = 0;
    core.onEvents((batch) => {
      if (batch.length === 0) emptyBatches += 1;
    });
    expect(core.getState().priors).toBeUndefined();
    expect((await core.start()).ok).toBe(true);
    const rows = runs.flatMap((events) => agentRunRows(events.map(stored)));
    const expected = etaPriorsFrom(computeScorecards(rows), NOW);
    expect(Object.keys(expected.byRoleModel).length).toBeGreaterThan(0);
    await vi.waitFor(() => {
      expect(core.getState().priors).toEqual(expected);
    });
    await vi.waitFor(() => {
      expect(emptyBatches).toBeGreaterThan(0);
    });
    // A copy: changing what getState returned does not change the core's priors.
    const first = core.getState().priors;
    if (first !== undefined) first.byRoleModel.x = 1;
    expect(core.getState().priors).toEqual(expected);
  });
});
