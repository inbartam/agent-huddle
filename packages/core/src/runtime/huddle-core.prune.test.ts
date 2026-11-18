/**
 * HuddleCore history deletion (M5 WP5, F22): the retention (on `history.setRetention`, at start and once a day on an
 * injected timer) deletes exactly what its preview counted, never a running session or the overall budget;
 * "delete all history" keeps nicknames (and they still show when a session comes back), removes reports and the older
 * JSONL folders without following a junction, and is refused without the exact confirm word.
 */
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OVERALL_BUDGET_LOWERED_WORDS,
  selectBudgetUsed,
  type CommandResult,
  type EventOfType,
  type HuddleCommand,
  type HuddleEvent,
  type QueryResult,
} from '@huddle/shared';
import { replay, toHuddleState } from '../state/reduce.js';
import { fixtureSession, stored } from '../test/history-sessions.js';
import { SqliteEventStore } from '../store/sqlite-store.js';
import { JsonlEventStore } from '../store/jsonl-store.js';
import {
  BUDGET_SESSION_ID,
  HISTORY_SESSION_ID,
  HuddleCore,
  JSONL_DELETE_ALL_NOTE,
  RETENTION_CONFIRM_MISSING,
  retentionConfirmChanged,
  type HuddleCoreDeps,
} from './huddle-core.js';
import { readHuddleSettings, userSettingsOf } from './huddle-settings.js';
import { reportsDirOf } from './report-files.js';
import { activeOverallBudgetSince } from './replay-window.js';
import { templateBudgetScope } from './runs.js';

const NOW = Date.parse('2026-11-14T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

interface Env {
  root: string;
  dataDir: string;
  claudeDir: string;
  forwarder: string;
  clock: { now: number };
}

async function makeEnv(): Promise<Env> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'huddle-core-prune-'));
  const env: Env = {
    root,
    dataDir: path.join(root, 'data'),
    claudeDir: path.join(root, 'claude'),
    forwarder: path.join(root, 'forwarder.mjs'),
    clock: { now: NOW },
  };
  await fsp.mkdir(env.claudeDir, { recursive: true });
  await fsp.mkdir(env.dataDir, { recursive: true });
  await fsp.writeFile(env.forwarder, '// test forwarder\n');
  cleanups.push(() => fsp.rm(root, { recursive: true, force: true, maxRetries: 5 }));
  return env;
}

function makeCore(env: Env, over: Partial<HuddleCoreDeps> = {}): HuddleCore {
  const core = new HuddleCore({
    dataDir: env.dataDir,
    claudeConfigDir: env.claudeDir,
    cwd: null,
    userAgentsDir: null,
    port: 0,
    now: () => env.clock.now,
    forwarderSource: env.forwarder,
    newToken: () => 'test-token-0123456789',
    runIsLive: (runId) => runId === 'live-run',
    ...over,
    history: { backfillAtStart: false, retentionAtStart: false, reportDelayMs: 0, ...over.history },
  });
  cleanups.push(() => core.dispose());
  return core;
}

async function seed(env: Env, events: readonly HuddleEvent[]): Promise<void> {
  const store = new SqliteEventStore({ file: path.join(env.dataDir, 'huddle.sqlite'), flushDelayMs: 1 });
  try {
    const done = store.append(events);
    await store.flush();
    await done;
  } finally {
    await store.close();
  }
}

function rename(sessionId: string, agentKey: string, name: string, ts: number): HuddleEvent {
  const event: EventOfType<'control.applied'> = {
    id: `rename-${agentKey}-${String(ts)}`,
    type: 'control.applied',
    ts,
    sessionId,
    agentKey,
    source: 'user',
    action: 'rename',
    detail: name,
  };
  return event;
}

function overallBudget(ts: number): HuddleEvent {
  const event: EventOfType<'budget.set'> = {
    id: 'budget-overall',
    type: 'budget.set',
    ts,
    sessionId: BUDGET_SESSION_ID,
    agentKey: BUDGET_SESSION_ID,
    source: 'user',
    scope: 'overall',
    targetKey: null,
    budget: { scope: 'overall', maxTokens: 1_000_000_000, warnAtFraction: 0.8, onExceed: 'notify' },
  };
  return event;
}

function resumed(sessionId: string, ts: number): HuddleEvent {
  const event: EventOfType<'session.started'> = {
    id: `${sessionId}:resumed-${String(ts)}`,
    type: 'session.started',
    ts,
    sessionId,
    agentKey: sessionId,
    source: 'hook',
    origin: 'attached',
    cwd: 'C:/Users/user/project',
    title: null,
    model: null,
    startKind: 'resume',
  };
  return event;
}

/**
 * old-40d and old-10d: ended long ago (not loaded at start). stale-open: no end, last event 40 days ago (loaded,
 * since it never ended, but not live). live-run: a managed run whose process lives (`runIsLive`), quiet for 20 days.
 * recent: ended 2 hours ago (loaded). The overall budget was set 5 days ago, after every old run (it counts recent).
 */
function history(): HuddleEvent[] {
  return [
    ...fixtureSession('single-agent.jsonl', 'old-40d', { lastTs: NOW - 40 * DAY }),
    rename('old-40d', 'old-40d', 'Old nick', NOW - 40 * DAY - 1000),
    ...fixtureSession('single-agent.jsonl', 'old-10d', { lastTs: NOW - 10 * DAY }),
    ...fixtureSession('agent-messages.jsonl', 'stale-open', { lastTs: NOW - 40 * DAY, dropEnd: true }),
    ...fixtureSession('single-agent.jsonl', 'live-run', { lastTs: NOW - 20 * DAY, dropEnd: true }),
    ...fixtureSession('single-agent.jsonl', 'recent', { lastTs: NOW - 2 * HOUR }),
    rename('recent', 'recent', 'Recent nick', NOW - 2 * HOUR - 1000),
    overallBudget(NOW - 5 * DAY),
  ];
}

async function writeReports(env: Env, ids: readonly string[]): Promise<void> {
  const dir = reportsDirOf(env.dataDir);
  await fsp.mkdir(dir, { recursive: true });
  for (const id of ids) await fsp.writeFile(path.join(dir, `${id}.md`), `# ${id}\n`);
}

async function exists(p: string): Promise<boolean> {
  try {
    await fsp.lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function query<T extends QueryResult>(core: HuddleCore, q: Parameters<HuddleCore['query']>[0]): Promise<T> {
  const result = await core.query(q);
  if (!result.ok) throw new Error(`${q.type}: ${result.message}`);
  return result as T;
}

async function storedIds(env: Env): Promise<string[]> {
  const store = new SqliteEventStore({ file: path.join(env.dataDir, 'huddle.sqlite') });
  try {
    return (await store.listSessionRecords()).map((r) => r.sessionId).sort();
  } finally {
    await store.close();
  }
}

async function preview(core: HuddleCore, days: number): Promise<number | null> {
  const r = await query<Extract<QueryResult, { type: 'history.retentionPreview' }>>(core, {
    type: 'history.retentionPreview',
    days,
  });
  return r.preview.runs;
}

describe('retention', () => {
  it('lowering it deletes exactly what the preview counted, and keeps live sessions and the overall budget', async () => {
    const env = await makeEnv();
    await seed(env, history());
    await writeReports(env, ['old-40d', 'old-10d', 'recent']);
    const core = makeCore(env);
    expect((await core.start()).ok).toBe(true);
    expect(core.getState().agents['stale-open']).toBeDefined();

    const counted = await preview(core, 7);
    expect(counted).toBe(3);
    const result = await core.command({ type: 'history.setRetention', days: 7, confirm: counted ?? -1 });
    expect(result).toMatchObject({ ok: true, deleted: { runs: counted, reports: 2, folders: 0 } });

    await core.dispose();
    expect(await storedIds(env)).toEqual([BUDGET_SESSION_ID, HISTORY_SESSION_ID, 'live-run', 'recent'].sort());
    expect(await exists(path.join(reportsDirOf(env.dataDir), 'old-40d.md'))).toBe(false);
    expect(await exists(path.join(reportsDirOf(env.dataDir), 'old-10d.md'))).toBe(false);
    expect(await exists(path.join(reportsDirOf(env.dataDir), 'recent.md'))).toBe(true);
    // The retention is saved, and the nickname of the deleted run is kept.
    const user = userSettingsOf(await readHuddleSettings(env.dataDir));
    expect(user.history.retentionDays).toBe(7);
    expect(user.nicknames).toEqual({ 'old-40d': 'Old nick' });
  });

  it('the state forgets a pruned session it had loaded; the budget and the live run stay', async () => {
    const env = await makeEnv();
    await seed(env, history());
    const core = makeCore(env);
    expect((await core.start()).ok).toBe(true);
    await core.command({ type: 'history.setRetention', days: 7, confirm: 3 });
    const state = core.getState();
    expect(state.agents['stale-open']).toBeUndefined();
    expect(state.rootKeys).not.toContain('stale-open');
    expect(state.agents['live-run']).toBeDefined();
    expect(state.agents['recent']).toBeDefined();
    expect(state.budgets).toEqual([expect.objectContaining({ scope: 'overall' })]);
    const pruned = core.getEvents(HISTORY_SESSION_ID, 10).find((e) => e.type === 'history.pruned');
    // Of the three deleted, only stale-open (no end) was loaded at start; the ended old runs stayed in the database.
    expect(pruned).toMatchObject({ reason: 'retention', count: 3, source: 'huddle', sessionIds: ['stale-open'] });
  });

  it('raising it deletes nothing', async () => {
    const env = await makeEnv();
    await seed(env, history());
    const core = makeCore(env);
    expect((await core.start()).ok).toBe(true);
    expect(await core.command({ type: 'history.setRetention', days: 60 })).toEqual({ ok: true });
    await core.dispose();
    expect(await storedIds(env)).toContain('old-40d');
  });

  it('template budgets: never an overall budget.set, so a run budget is never needed by the replay window', () => {
    for (const scope of ['session', 'overall', 'all'] as const) expect(templateBudgetScope(scope)).toBe('session');
    expect(templateBudgetScope('agent')).toBe('agent');
    const runBudget = { ...overallBudget(NOW - 30 * DAY), sessionId: 'run-1', agentKey: 'run-1' };
    const asSession = { ...runBudget, scope: 'session' as const, targetKey: 'run-1' } as HuddleEvent;
    expect(activeOverallBudgetSince([asSession])).toBeNull();
  });

  it('runs at start and once a day on the injected timer', async () => {
    const env = await makeEnv();
    await seed(env, history());
    const ticks: { run: () => void; everyMs: number }[] = [];
    const core = makeCore(env, {
      history: {
        retentionAtStart: true,
        retentionTimer: (run, everyMs) => {
          ticks.push({ run, everyMs });
          return () => undefined;
        },
      },
    });
    expect((await core.start()).ok).toBe(true);
    expect(ticks).toHaveLength(1);
    expect(ticks[0]?.everyMs).toBe(DAY);
    // At start (30 days): old-40d and stale-open go.
    await vi.waitFor(async () => {
      expect(await preview(core, 30)).toBe(0);
      expect(core.getState().agents['stale-open']).toBeUndefined();
    });
    // 25 days later old-10d is 35 days old: the daily tick deletes it.
    expect(await preview(core, 30)).toBe(0);
    env.clock.now = NOW + 25 * DAY;
    expect(await preview(core, 30)).toBe(1);
    ticks[0]?.run();
    await vi.waitFor(async () => {
      expect(await preview(core, 30)).toBe(0);
    });
    await core.dispose();
    const ids = await storedIds(env);
    expect(ids).not.toContain('old-10d');
    expect(ids).toContain(BUDGET_SESSION_ID);
    expect(ids).toContain('live-run');
  });
});

describe('delete all history', () => {
  async function legacy(env: Env): Promise<{ outside: string }> {
    const outside = path.join(env.root, 'outside');
    await fsp.mkdir(outside, { recursive: true });
    await fsp.writeFile(path.join(outside, 'precious.txt'), 'keep me');
    const migrated = path.join(env.dataDir, 'events.migrated-2026-10-01');
    await fsp.mkdir(path.join(migrated, 'nested'), { recursive: true });
    await fsp.writeFile(path.join(migrated, 'old.jsonl'), '{}\n');
    await fsp.writeFile(path.join(migrated, 'nested', 'older.jsonl'), '{}\n');
    // A junction needs no privilege on Windows; elsewhere a directory symlink.
    await fsp.symlink(outside, path.join(migrated, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    return { outside };
  }

  it('refuses without the exact confirm word, and deletes nothing', async () => {
    const env = await makeEnv();
    await seed(env, history());
    const core = makeCore(env);
    expect((await core.start()).ok).toBe(true);
    for (const confirm of ['Delete', ' delete', 'yes', '']) {
      const cmd = { type: 'history.deleteAll', confirm } as unknown as HuddleCommand;
      expect(await core.command(cmd)).toMatchObject({ ok: false, code: 'invalid' });
    }
    expect(await core.command({ type: 'history.deleteAll' } as unknown as HuddleCommand)).toMatchObject({
      ok: false,
      code: 'invalid',
    });
    await core.dispose();
    expect(await storedIds(env)).toContain('old-40d');
  });

  it('deletes every run but the live one, reports, the older folders (not through a junction), keeps nicknames', async () => {
    const env = await makeEnv();
    await seed(env, history());
    await writeReports(env, ['old-40d', 'recent', 'gone-long-ago', 'live-run']);
    const { outside } = await legacy(env);
    const core = makeCore(env);
    expect((await core.start()).ok).toBe(true);
    // An `events` folder that came back (a JSONL fallback run) goes too.
    await fsp.mkdir(path.join(env.dataDir, 'events'), { recursive: true });
    await fsp.writeFile(path.join(env.dataDir, 'events', 'x.jsonl'), '{}\n');

    const result: CommandResult = await core.command({ type: 'history.deleteAll', confirm: 'delete' });
    // recent ran under the overall budget: delete all lowers its usage and says so.
    expect(result).toMatchObject({
      ok: true,
      deleted: { runs: 4, reports: 3, folders: 2, overallBudgetLowered: true },
    });
    expect(result.ok && result.detail).toBe(
      `Deleted 4 runs, 3 reports and 2 older history folders. ${OVERALL_BUDGET_LOWERED_WORDS}`,
    );

    const state = core.getState();
    expect(state.agents['recent']).toBeUndefined();
    expect(state.agents['stale-open']).toBeUndefined();
    expect(state.agents['live-run']).toBeDefined();
    expect(state.budgets).toEqual([expect.objectContaining({ scope: 'overall' })]);
    expect(core.getEvents(HISTORY_SESSION_ID, 10).at(-1)).toMatchObject({
      type: 'history.pruned',
      reason: 'delete_all',
      source: 'user',
      count: 4,
    });

    await core.dispose();
    expect(await storedIds(env)).toEqual([BUDGET_SESSION_ID, HISTORY_SESSION_ID, 'live-run'].sort());
    const reports = await fsp.readdir(reportsDirOf(env.dataDir));
    expect(reports).toEqual(['live-run.md']);
    const names = await fsp.readdir(env.dataDir);
    expect(names.filter((n) => n.startsWith('events'))).toEqual([]);
    expect(await fsp.readFile(path.join(outside, 'precious.txt'), 'utf8')).toBe('keep me');
    const user = userSettingsOf(await readHuddleSettings(env.dataDir));
    expect(user.nicknames).toEqual({ 'old-40d': 'Old nick', recent: 'Recent nick' });

    // The search index holds nothing of the deleted runs.
    const store = new SqliteEventStore({ file: path.join(env.dataDir, 'huddle.sqlite') });
    try {
      expect((await store.searchSessions('project')).map((s) => s.sessionId)).toEqual(['live-run']);
    } finally {
      await store.close();
    }
  });

  it('a kept nickname still shows when its session comes back, and a rename that clears it clears it for good', async () => {
    const env = await makeEnv();
    await seed(env, history());
    const first = makeCore(env);
    expect((await first.start()).ok).toBe(true);
    expect(first.getState().agents['recent']?.name).toBe('Recent nick');
    expect((await first.command({ type: 'history.deleteAll', confirm: 'delete' })).ok).toBe(true);
    await first.dispose();

    // The session is resumed later: its rename event is gone, the kept nickname names it.
    await seed(env, [resumed('recent', NOW + HOUR)]);
    env.clock.now = NOW + 2 * HOUR;
    const second = makeCore(env);
    expect((await second.start()).ok).toBe(true);
    expect(second.getState().agents['recent']?.name).toBe('Recent nick');

    expect((await second.command({ type: 'agent.rename', agentKey: 'recent', name: '' })).ok).toBe(true);
    expect(second.getState().agents['recent']?.name).not.toBe('Recent nick');
    expect(userSettingsOf(await readHuddleSettings(env.dataDir)).nicknames).toEqual({ 'old-40d': 'Old nick' });
  });
});

describe('lowering the retention needs the count the user saw (L4)', () => {
  it('refuses without confirm or with another count, saves nothing and deletes nothing; raising needs none', async () => {
    const env = await makeEnv();
    await seed(env, history());
    const core = makeCore(env);
    expect((await core.start()).ok).toBe(true);
    expect(await preview(core, 7)).toBe(3);

    expect(await core.command({ type: 'history.setRetention', days: 7 })).toEqual({
      ok: false,
      code: 'invalid',
      message: RETENTION_CONFIRM_MISSING,
    });
    // A stale command: the user saw 2, now 3 would go.
    expect(await core.command({ type: 'history.setRetention', days: 7, confirm: 2 })).toEqual({
      ok: false,
      code: 'invalid',
      message: retentionConfirmChanged(3),
    });
    expect(retentionConfirmChanged(3)).toBe(
      'The runs to delete changed since you checked: now 3 runs. Check again, then confirm.',
    );
    expect(await core.command({ type: 'history.setRetention', days: 7, confirm: 4 })).toMatchObject({ ok: false });
    expect(core.getUserSettings().history.retentionDays).toBe(30);
    expect(await preview(core, 7)).toBe(3);

    // Raising: no confirm needed (one given is ignored).
    expect(await core.command({ type: 'history.setRetention', days: 90 })).toEqual({ ok: true });
    expect(await core.command({ type: 'history.setRetention', days: 120, confirm: 99 })).toEqual({ ok: true });
    expect(core.getUserSettings().history.retentionDays).toBe(120);

    // The count matches: saved, and exactly those go.
    expect(await core.command({ type: 'history.setRetention', days: 7, confirm: 3 })).toMatchObject({
      ok: true,
      deleted: { runs: 3 },
    });
    expect(core.getUserSettings().history.retentionDays).toBe(7);
    await core.dispose();
    expect(await storedIds(env)).toEqual([BUDGET_SESSION_ID, HISTORY_SESSION_ID, 'live-run', 'recent'].sort());
  });

  it('a count that grew since the preview (a run aged past the cutoff) is refused', async () => {
    const env = await makeEnv();
    // No overall budget here: one would keep 'recent' (it counts it).
    await seed(
      env,
      history().filter((e) => e.sessionId !== BUDGET_SESSION_ID),
    );
    const core = makeCore(env);
    expect((await core.start()).ok).toBe(true);
    // The user reads "3 runs" for 1 day ('recent' ended 2 hours ago, so it stays) ...
    expect(await preview(core, 1)).toBe(3);
    // ... and confirms a day later, when 'recent' is older than 1 day too: refused, nothing goes.
    env.clock.now = NOW + DAY;
    expect(await core.command({ type: 'history.setRetention', days: 1, confirm: 3 })).toEqual({
      ok: false,
      code: 'invalid',
      message: retentionConfirmChanged(4),
    });
    expect(await preview(core, 1)).toBe(4);
    expect(core.getUserSettings().history.retentionDays).toBe(30);
  });
});

async function writeMeta(env: Env, entries: Record<string, string>): Promise<void> {
  const store = new SqliteEventStore({ file: path.join(env.dataDir, 'huddle.sqlite') });
  try {
    store.writeMeta(entries);
  } finally {
    await store.close();
  }
}

async function folderWith(dir: string, files: Record<string, number>): Promise<void> {
  for (const [name, ts] of Object.entries(files)) {
    const file = path.join(dir, name);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, '{}\n');
    await fsp.utimes(file, ts / 1000, ts / 1000);
  }
}

describe('retention removes the older JSONL folders once nothing in them is newer (M1)', () => {
  function logs(): { lines: string[]; logger: NonNullable<HuddleCoreDeps['logger']> } {
    const lines: string[] = [];
    const push = (m: string, d?: unknown) => lines.push(`${m} ${JSON.stringify(d ?? {})}`);
    return { lines, logger: { info: push, warn: push, error: push } };
  }

  it('after the import: an old migrated folder goes, one with a newer file stays (logged), links are not followed', async () => {
    const env = await makeEnv();
    await seed(env, history());
    const old = path.join(env.dataDir, 'events.migrated-2026-10-01');
    const fresh = path.join(env.dataDir, 'events.migrated-2026-10-20');
    const linked = path.join(env.dataDir, 'events.migrated-2026-10-05');
    await writeMeta(env, { jsonl_migrated_at: new Date(NOW - 45 * DAY).toISOString(), jsonl_migrated_to: old });
    await folderWith(old, { 'a.jsonl': NOW - 40 * DAY, 'nested/b.jsonl': NOW - 41 * DAY });
    await folderWith(fresh, { 'a.jsonl': NOW - 40 * DAY, 'b.jsonl': NOW - HOUR });
    // A junction (a symlink elsewhere) to a folder of old files: never entered; the link itself is new, so it stays.
    const outside = path.join(env.root, 'outside');
    await folderWith(outside, { 'precious.txt': NOW - 90 * DAY });
    await fsp.mkdir(linked, { recursive: true });
    await fsp.symlink(outside, path.join(linked, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    const { lines, logger } = logs();
    const core = makeCore(env, { logger });
    expect((await core.start()).ok).toBe(true);
    // An `events` folder after a renaming import holds new lines for the next start: never touched here.
    await folderWith(path.join(env.dataDir, 'events'), { 'x.jsonl': NOW - 50 * DAY });

    const result = await core.command({ type: 'history.setRetention', days: 7, confirm: 3 });
    expect(result).toMatchObject({ ok: true, deleted: { runs: 3, folders: 1 } });
    expect(await exists(old)).toBe(false);
    expect(await exists(path.join(fresh, 'b.jsonl'))).toBe(true);
    expect(await exists(path.join(fresh, 'a.jsonl'))).toBe(true);
    expect(await exists(path.join(linked, 'link'))).toBe(true);
    expect(await fsp.readFile(path.join(outside, 'precious.txt'), 'utf8')).toBe('{}\n');
    expect(await exists(path.join(env.dataDir, 'events', 'x.jsonl'))).toBe(true);
    expect(
      lines.some((l) => l.includes('kept an older history folder: it holds a file newer than the retention')),
    ).toBe(true);
    expect(lines.filter((l) => l.includes('events.migrated-2026-10-20')).length).toBeGreaterThan(0);
  });

  it('an `events` folder the import left in place (its rename failed) goes once it is old', async () => {
    const env = await makeEnv();
    await seed(env, history());
    await writeMeta(env, { jsonl_migrated_at: new Date(NOW - 45 * DAY).toISOString(), jsonl_migrated_to: '' });
    const events = path.join(env.dataDir, 'events');
    await folderWith(events, { 'a.jsonl': NOW - 40 * DAY, 'index.json': NOW - 40 * DAY });
    const core = makeCore(env);
    expect((await core.start()).ok).toBe(true);
    expect(await core.command({ type: 'history.setRetention', days: 7, confirm: 3 })).toMatchObject({
      ok: true,
      deleted: { folders: 1 },
    });
    expect(await exists(events)).toBe(false);
  });

  it('before the import is recorded as done, no folder is touched however old', async () => {
    const env = await makeEnv();
    await seed(env, history());
    const migrated = path.join(env.dataDir, 'events.migrated-2026-10-01');
    await folderWith(migrated, { 'a.jsonl': NOW - 40 * DAY });
    const core = makeCore(env);
    expect((await core.start()).ok).toBe(true);
    expect(await core.command({ type: 'history.setRetention', days: 7, confirm: 3 })).toMatchObject({
      ok: true,
      deleted: { folders: 0 },
    });
    expect(await exists(path.join(migrated, 'a.jsonl'))).toBe(true);
  });
});

describe('the JSONL fallback deletes history too (M1)', () => {
  /** The history() sessions as JSONL files, then the database made unopenable. */
  async function fallbackEnv(): Promise<Env> {
    const env = await makeEnv();
    const store = new JsonlEventStore({ baseDir: path.join(env.dataDir, 'events'), flushDelayMs: 1 });
    await store.append(history());
    await store.close();
    await fsp.writeFile(path.join(env.dataDir, 'huddle.sqlite'), 'not a database');
    return env;
  }

  const quiet = { logger: { info: () => undefined, warn: () => undefined, error: () => undefined } };
  const jsonl = (env: Env, id: string) => path.join(env.dataDir, 'events', `${id}.jsonl`);

  /** File times: as old as each session's last event (the start may have touched a file). */
  async function ageFiles(env: Env): Promise<void> {
    const times: Record<string, number> = {
      'old-40d': NOW - 40 * DAY,
      'old-10d': NOW - 10 * DAY,
      'stale-open': NOW - 40 * DAY,
      'live-run': NOW - 20 * DAY,
      recent: NOW - 2 * HOUR,
      [BUDGET_SESSION_ID]: NOW - 40 * DAY,
    };
    for (const [id, ts] of Object.entries(times)) await fsp.utimes(jsonl(env, id), ts / 1000, ts / 1000);
  }

  it('retention deletes the old session files (by file time), keeps live, budget and recent ones; needs confirm', async () => {
    const env = await fallbackEnv();
    await writeReports(env, ['old-40d', 'recent']);
    const core = makeCore(env, quiet);
    expect((await core.start()).ok).toBe(true);
    expect(core.getState().agents['old-40d']).toBeDefined();
    await preview(core, 7); // flushes anything the start wrote
    await ageFiles(env);
    expect(await preview(core, 7)).toBe(3);
    expect(await core.command({ type: 'history.setRetention', days: 7 })).toMatchObject({ ok: false, code: 'invalid' });
    expect(await exists(jsonl(env, 'old-40d'))).toBe(true);

    const result = await core.command({ type: 'history.setRetention', days: 7, confirm: 3 });
    expect(result).toMatchObject({ ok: true, deleted: { runs: 3, reports: 1 } });
    for (const id of ['old-40d', 'old-10d', 'stale-open']) expect(await exists(jsonl(env, id))).toBe(false);
    for (const id of ['live-run', 'recent', BUDGET_SESSION_ID]) expect(await exists(jsonl(env, id))).toBe(true);
    expect(await exists(path.join(reportsDirOf(env.dataDir), 'old-40d.md'))).toBe(false);
    expect(await exists(path.join(reportsDirOf(env.dataDir), 'recent.md'))).toBe(true);
    // The state forgets them through history.pruned; the budget stays.
    const state = core.getState();
    expect(state.agents['old-40d']).toBeUndefined();
    expect(state.agents['stale-open']).toBeUndefined();
    expect(state.agents['recent']).toBeDefined();
    expect(state.budgets).toEqual([expect.objectContaining({ scope: 'overall' })]);
    // Nicknames come from the state (no database to read them from).
    expect(userSettingsOf(await readHuddleSettings(env.dataDir)).nicknames).toEqual({ 'old-40d': 'Old nick' });
    expect(await fsp.readFile(path.join(env.dataDir, 'huddle.sqlite'), 'utf8')).toBe('not a database');
  });

  it('runs at start on the fallback too', async () => {
    const env = await fallbackEnv();
    await ageFiles(env);
    const core = makeCore(env, {
      ...quiet,
      history: { retentionAtStart: true, retentionTimer: () => () => undefined },
    });
    expect((await core.start()).ok).toBe(true);
    await vi.waitFor(async () => {
      expect(await exists(jsonl(env, 'old-40d'))).toBe(false);
    });
    expect(await exists(jsonl(env, 'old-10d'))).toBe(true);
    expect(await exists(jsonl(env, BUDGET_SESSION_ID))).toBe(true);
  });

  it('delete all deletes every file but live and budget sessions, never through a link, and says the database was not', async () => {
    const env = await fallbackEnv();
    const outside = path.join(env.root, 'outside');
    await folderWith(outside, { 'precious.txt': NOW });
    // A session "file" that is a junction to a folder elsewhere: removed as a link.
    await fsp.symlink(outside, jsonl(env, 'ghost'), process.platform === 'win32' ? 'junction' : 'dir');
    await folderWith(path.join(env.dataDir, 'events.migrated-2026-10-01'), { 'a.jsonl': NOW - 40 * DAY });
    const core = makeCore(env, quiet);
    expect((await core.start()).ok).toBe(true);
    const result = await core.command({ type: 'history.deleteAll', confirm: 'delete' });
    expect(result).toMatchObject({ ok: true, deleted: { runs: 5, folders: 1 } });
    expect(result.ok && result.detail).toContain(JSONL_DELETE_ALL_NOTE);
    for (const id of ['old-40d', 'old-10d', 'stale-open', 'recent', 'ghost']) {
      expect(await exists(jsonl(env, id))).toBe(false);
    }
    expect(await exists(jsonl(env, 'live-run'))).toBe(true);
    expect(await exists(jsonl(env, BUDGET_SESSION_ID))).toBe(true);
    expect(await fsp.readFile(path.join(outside, 'precious.txt'), 'utf8')).toBe('{}\n');
    expect(await exists(path.join(env.dataDir, 'events.migrated-2026-10-01'))).toBe(false);
    expect(await fsp.readFile(path.join(env.dataDir, 'huddle.sqlite'), 'utf8')).toBe('not a database');
    expect(core.getState().agents['recent']).toBeUndefined();
    expect(core.getState().agents['live-run']).toBeDefined();
    expect(userSettingsOf(await readHuddleSettings(env.dataDir)).nicknames).toEqual({
      'old-40d': 'Old nick',
      recent: 'Recent nick',
    });
  });
});

describe('retention and an overall budget in force', () => {
  it('never deletes a session the overall budget counts; older ones go; the preview counts what goes', async () => {
    const env = await makeEnv();
    const budget = overallBudget(NOW - 40 * DAY);
    const counted = fixtureSession('interactive-helpers.jsonl', 'ended-35d', { lastTs: NOW - 35 * DAY });
    const before = fixtureSession('single-agent.jsonl', 'ended-45d', { lastTs: NOW - 45 * DAY });
    expect(counted.some((e) => e.type === 'session.ended' && e.agentKey === 'ended-35d')).toBe(true);
    expect(counted.some((e) => e.type === 'usage.recorded')).toBe(true);
    await seed(env, [...before, budget, ...counted]);
    const core = makeCore(env);
    expect((await core.start()).ok).toBe(true);
    const entry = core.getState().budgets?.find((b) => b.scope === 'overall');
    expect(entry?.setAt).toBe(budget.ts);
    if (entry === undefined) return;
    const usedBefore = selectBudgetUsed(core.getState(), entry, NOW);
    expect(usedBefore.tokens).toBeGreaterThan(0);

    // Raise, then lower to 30 days (only a lower value deletes at once).
    expect(await core.command({ type: 'history.setRetention', days: 60 })).toEqual({ ok: true });
    const previewed = await preview(core, 30);
    expect(previewed).toBe(1);
    const result = await core.command({ type: 'history.setRetention', days: 30, confirm: previewed ?? -1 });
    expect(result).toMatchObject({ ok: true, deleted: { runs: previewed } });
    expect(result.ok && result.deleted?.overallBudgetLowered).toBeUndefined();
    expect(await preview(core, 30)).toBe(0);

    // ended-35d still counts toward the budget, exactly as before.
    const state = core.getState();
    expect(state.agents['ended-35d']).toBeDefined();
    expect(selectBudgetUsed(state, entry, NOW)).toEqual(usedBefore);
    const expected = toHuddleState(replay([budget, ...counted].map(stored)));
    expect(selectBudgetUsed(state, entry, NOW)).toEqual(selectBudgetUsed(expected, entry, NOW));

    await core.dispose();
    const ids = await storedIds(env);
    expect(ids).toContain('ended-35d');
    expect(ids).not.toContain('ended-45d');
  });

  it('the preview and the deletion both move back to the budget when it was set inside the window', async () => {
    const env = await makeEnv();
    await seed(env, [
      ...fixtureSession('single-agent.jsonl', 'ended-20d', { lastTs: NOW - 20 * DAY }),
      overallBudget(NOW - 25 * DAY),
    ]);
    const core = makeCore(env);
    expect((await core.start()).ok).toBe(true);
    // A 7-day retention would take ended-20d, but the budget set 25 days ago counts it.
    expect(await preview(core, 7)).toBe(0);
    expect(await core.command({ type: 'history.setRetention', days: 7, confirm: 0 })).toMatchObject({
      ok: true,
      deleted: { runs: 0 },
    });
    await core.dispose();
    expect(await storedIds(env)).toContain('ended-20d');
  });
});
