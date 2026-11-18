/**
 * HistoryService (M5 WP4b, F22 F23 F24): every M5 question answered from recorded fixtures imported into a temp SQLite
 * store, the reports written when a run ends (`session.ended`, and `run.exited` for a managed run that never sent
 * one), report paths confined to `<dataDir>/reports`, and an idempotent scorecard backfill.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  agentKey,
  DEFAULT_USER_SETTINGS,
  etaPriorsFrom,
  workTokens,
  type HuddleEvent,
  type M5Query,
  type QueryResult,
  type QueryResultOf,
} from '@huddle/shared';
import { parseM5Command, parseM5Query } from '../contracts/m5-schemas.js';
import { agentRunRows, scorecardRows } from '../report/agent-runs.js';
import { renderReportMarkdown } from '../report/markdown.js';
import { buildRunReport } from '../report/run-report.js';
import { computeScorecards } from '../report/scorecards.js';
import { initialState, replay, toHuddleState, type ReducerState } from '../state/reduce.js';
import { META_MIGRATED_TO } from '../store/migrate-jsonl.js';
import {
  appendAll,
  fixtureSession,
  fragmentSession,
  idleSession,
  longSession,
  readBack,
  stored,
  tempStore,
  type TempStore,
} from '../test/history-sessions.js';
import { DERIVATION_VERSION, HistoryService, META_BACKFILL, type HistoryServiceDeps } from './history.js';
import { isInsideReportsDir, reportPathFor, reportsDirOf } from './report-files.js';

const NOW = Date.parse('2026-11-14T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const BUDGETS = 'huddle-budgets';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

interface Env {
  tmp: TempStore;
  service: HistoryService;
  live: { state: ReducerState; startedAt: number | null };
  logs: string[];
}

async function setup(over: Partial<HistoryServiceDeps> = {}): Promise<Env> {
  const tmp = await tempStore();
  const live = { state: initialState(), startedAt: null as number | null };
  const logs: string[] = [];
  const service = new HistoryService({
    store: tmp.store,
    dataDir: tmp.dir,
    now: () => NOW,
    logger: {
      info: (m) => logs.push(`info ${m}`),
      warn: (m) => logs.push(`warn ${m}`),
      error: (m) => logs.push(`error ${m}`),
    },
    liveState: () => live.state,
    startedAt: () => live.startedAt,
    settings: () => DEFAULT_USER_SETTINGS,
    migrating: () => false,
    track: (work) => work,
    exclude: [BUDGETS],
    reportDelayMs: 0,
    ...over,
  });
  cleanups.push(async () => {
    service.dispose();
    await tmp.cleanup();
  });
  return { tmp, service, live, logs };
}

/** Asks through the IPC schema first, as main does. */
async function ask<T extends M5Query['type']>(env: Env, q: Extract<M5Query, { type: T }> | Record<string, unknown>) {
  const parsed = parseM5Query(q);
  if (parsed === null) throw new Error(`query refused: ${JSON.stringify(q)}`);
  const result: QueryResult = await env.service.query(parsed);
  if (!result.ok) throw new Error(`query failed: ${result.code} ${result.message}`);
  return result as QueryResultOf<T>;
}

/** Four ended runs, one an hour apart (newest first: parallel, nested, failure, single), two folders. */
const RUNS = [
  { fixture: 'parallel-subagents.jsonl', id: 'run-parallel', hoursAgo: 1, cwd: 'C:/code/alpha' },
  { fixture: 'nested-subagents.jsonl', id: 'run-nested', hoursAgo: 2, cwd: 'C:/code/beta' },
  { fixture: 'failure.jsonl', id: 'run-failure', hoursAgo: 3, cwd: 'C:/code/alpha' },
  { fixture: 'single-agent.jsonl', id: 'run-single', hoursAgo: 4, cwd: 'C:/code/beta' },
] as const;

async function seedRuns(env: Env): Promise<Map<string, HuddleEvent[]>> {
  const bySession = new Map<string, HuddleEvent[]>();
  for (const r of RUNS) {
    const events = fixtureSession(r.fixture, r.id, { lastTs: NOW - r.hoursAgo * HOUR, cwd: r.cwd });
    await appendAll(env.tmp.store, events);
    bySession.set(r.id, events.map(stored));
  }
  return bySession;
}

describe('history.list', () => {
  it('lists stored runs newest start first, each row read from its report', async () => {
    const env = await setup();
    const logs = await seedRuns(env);
    const { page } = await ask(env, { type: 'history.list', limit: 50 });
    expect(page.rows.map((r) => r.sessionId)).toEqual(RUNS.map((r) => r.id));
    expect(page.next).toBeNull();
    expect(page.migrating).toBe(false);
    for (const row of page.rows) {
      const events = logs.get(row.sessionId) ?? [];
      const report = buildRunReport(events, row.sessionId);
      const s = report?.summary;
      if (s === undefined) throw new Error('no report');
      expect(row).toMatchObject({
        startTs: Math.min(...events.map((e) => e.ts)),
        durationMs: s.durationMs,
        outcome: s.outcome === 'unknown' ? 'no_end' : s.outcome,
        origin: s.origin,
        model: s.model,
        agentCount: s.agents,
        tokens: s.tokens === null ? null : { value: workTokens(s.tokens), partial: s.tokensPartial },
        folder: RUNS.find((r) => r.id === row.sessionId)?.cwd,
      });
    }
  });

  it('topics are prompts with Claude Code tag blocks stripped; the first prompt when the last is only tags', async () => {
    const env = await setup();
    const prompt = (sessionId: string, n: number, text: string): HuddleEvent => ({
      id: `${sessionId}:extra-${String(n)}`,
      type: 'prompt.submitted',
      ts: NOW - HOUR + n,
      sessionId,
      agentKey: agentKey(sessionId),
      source: 'hook',
      text,
      promptId: null,
      kind: 'user',
    });
    for (const [id, text] of [
      ['run-pasted', '<pasted_content id="1">line\nline</pasted_content> fix the parser'],
      ['run-clear', '<command-name>/clear</command-name><command-message>clear</command-message>'],
    ] as const) {
      const events = fixtureSession('single-agent.jsonl', id, { lastTs: NOW - 2 * HOUR });
      await appendAll(env.tmp.store, [...events, prompt(id, 1, text)]);
    }
    const { page } = await ask(env, { type: 'history.list', limit: 50 });
    const topic = (id: string) => page.rows.find((r) => r.sessionId === id)?.topic;
    expect(topic('run-pasted')).toBe('fix the parser');
    expect(topic('run-clear')).toBe('(scrubbed text)');
  });

  it('pages with a cursor and filters by folder and outcome', async () => {
    const env = await setup();
    await seedRuns(env);
    const first = await ask(env, { type: 'history.list', limit: 2 });
    expect(first.page.rows.map((r) => r.sessionId)).toEqual(['run-parallel', 'run-nested']);
    expect(first.page.next).toEqual({ startTs: first.page.rows[1]?.startTs, sessionId: 'run-nested' });
    const second = await ask(env, { type: 'history.list', limit: 2, before: first.page.next ?? undefined });
    expect(second.page.rows.map((r) => r.sessionId)).toEqual(['run-failure', 'run-single']);
    expect(second.page.next).toBeNull();

    const alpha = await ask(env, { type: 'history.list', limit: 50, folder: 'C:/code/alpha' });
    expect(alpha.page.rows.map((r) => r.sessionId)).toEqual(['run-parallel', 'run-failure']);

    const all = await ask(env, { type: 'history.list', limit: 50 });
    const outcome = all.page.rows[0]?.outcome ?? 'completed';
    const filtered = await ask(env, { type: 'history.list', limit: 50, outcome });
    expect(filtered.page.rows.map((r) => r.sessionId)).toEqual(
      all.page.rows.filter((r) => r.outcome === outcome).map((r) => r.sessionId),
    );
    const none = await ask(env, { type: 'history.list', limit: 50, outcome: 'stopped' });
    expect(none.page.rows).toEqual([]);
  });

  it('shows a live session as running from the live state, and never the budgets pseudo session', async () => {
    const env = await setup();
    await seedRuns(env);
    const events = fixtureSession('single-agent.jsonl', 'run-live', { lastTs: NOW, dropEnd: true });
    await appendAll(env.tmp.store, events);
    await appendAll(env.tmp.store, [
      {
        id: 'b1',
        type: 'budget.set',
        ts: NOW,
        sessionId: BUDGETS,
        agentKey: BUDGETS,
        source: 'user',
        scope: 'overall',
        targetKey: null,
        budget: { scope: 'overall', maxTokens: 10, maxEstimatedCostUsd: null, maxMinutes: null, onExceed: 'warn' },
      } as unknown as HuddleEvent,
    ]);
    env.live.state = replay(events.map(stored));
    env.live.startedAt = NOW - HOUR;
    const { page } = await ask(env, { type: 'history.list', limit: 50 });
    const ids = page.rows.map((r) => r.sessionId);
    expect(ids).not.toContain(BUDGETS);
    const row = page.rows.find((r) => r.sessionId === 'run-live');
    expect(row).toMatchObject({ outcome: 'running', durationMs: null, agentCount: 1 });

    // Not live any more (this Huddle started after its last event): no end recorded.
    env.live.startedAt = NOW + HOUR;
    const later = await ask(env, { type: 'history.list', limit: 50, outcome: 'no_end' });
    expect(later.page.rows.map((r) => r.sessionId)).toEqual(['run-live']);
  });

  it('derives a session again when it got more events', async () => {
    const env = await setup();
    const events = fixtureSession('single-agent.jsonl', 'run-grow', { lastTs: NOW - DAY, dropEnd: true });
    await appendAll(env.tmp.store, events);
    const before = await ask(env, { type: 'history.list', limit: 5 });
    expect(before.page.rows[0]?.outcome).toBe('no_end');
    const end = fixtureSession('single-agent.jsonl', 'run-grow', { lastTs: NOW - DAY + 1000 }).filter(
      (e) => e.type === 'session.ended',
    );
    await appendAll(
      env.tmp.store,
      end.map((e) => ({ ...e, id: `${e.id}-late` })),
    );
    const after = await ask(env, { type: 'history.list', limit: 5 });
    expect(after.page.rows[0]?.outcome).toBe('completed');
    expect(env.tmp.store.history.session('run-grow')?.derivation?.eventCount).toBe(events.length + 1);
  });
});

describe('history.search', () => {
  it('matches the indexed text and returns plain-text match offsets, never markup', async () => {
    const env = await setup();
    await seedRuns(env);
    const { page } = await ask(env, { type: 'history.search', text: 'SCRUB', limit: 50 });
    expect(page.hits.length).toBeGreaterThan(0);
    expect(page.total).toBe(page.hits.length);
    for (const hit of page.hits) {
      const match = hit.match;
      if (match === null) continue;
      expect(['title', 'topic', 'folder', 'prompt']).toContain(match.field);
      expect(match.text).not.toMatch(/<mark>|<\/mark>/);
      for (const r of match.ranges) expect(match.text.slice(r.start, r.end).toLowerCase()).toBe('scrub');
    }
  });

  it('answers a folder match with the whole folder and offsets into it, and filters and counts', async () => {
    const env = await setup();
    await seedRuns(env);
    const alpha = await ask(env, { type: 'history.search', text: 'alpha', limit: 50 });
    expect(alpha.page.hits.map((h) => h.row.sessionId)).toEqual(['run-parallel', 'run-failure']);
    for (const hit of alpha.page.hits) {
      expect(hit.match).toEqual({
        field: 'folder',
        text: 'C:/code/alpha',
        cutStart: false,
        cutEnd: false,
        ranges: [{ start: 8, end: 13 }],
      });
      expect(hit.match?.text).toBe(hit.row.folder);
    }
    expect(alpha.page.total).toBe(2);
    const paged = await ask(env, { type: 'history.search', text: 'code', limit: 1 });
    expect(paged.page.hits).toHaveLength(1);
    expect(paged.page.total).toBe(4);
    expect(paged.page.next).toEqual({ startTs: paged.page.hits[0]?.row.startTs, sessionId: 'run-parallel' });
    const withOutcome = await ask(env, { type: 'history.search', text: 'code', limit: 50, outcome: 'no_end' });
    expect(withOutcome.page.total).toBeNull();
  });

  it('answers a title match with the whole title and offsets into it, hostile text kept plain', async () => {
    const env = await setup();
    const title = '<img src=x onerror=alert(1)> Zebra <mark>migration</mark> plan';
    const events = fixtureSession('single-agent.jsonl', 'run-titled', { lastTs: NOW - HOUR, cwd: 'C:/code/gamma' }).map(
      (e) => (e.type === 'session.started' && e.agentKey === 'run-titled' ? { ...e, title } : e),
    );
    await appendAll(env.tmp.store, events);
    const { page } = await ask(env, { type: 'history.search', text: 'zebra migration', limit: 50 });
    expect(page.hits.map((h) => h.row.sessionId)).toEqual(['run-titled']);
    const hit = page.hits[0];
    if (hit === undefined || hit.match === null) throw new Error('no title match');
    expect(hit.row.title).toBe(title);
    expect(hit.match).toMatchObject({ field: 'title', text: title, cutStart: false, cutEnd: false });
    expect(hit.match.ranges.map((r) => title.slice(r.start, r.end))).toEqual(['Zebra', 'migration']);
  });

  it('treats quotes, stars and FTS words as plain text', async () => {
    const env = await setup();
    await seedRuns(env);
    for (const text of ['"alpha', 'alpha*', 'alpha OR beta', 'NEAR(alpha)', '-alpha']) {
      const { page } = await ask(env, { type: 'history.search', text, limit: 50 });
      expect(page.hits.length, text).toBeLessThanOrEqual(4);
    }
    const nothing = await ask(env, { type: 'history.search', text: '"*"', limit: 50 });
    expect(nothing.page).toMatchObject({ hits: [], total: 0 });
  });
});

describe('history.folders, stats and retention preview', () => {
  it('lists folders by most recent run and counts what is stored', async () => {
    const env = await setup();
    await seedRuns(env);
    const { folders } = await ask(env, { type: 'history.folders' });
    expect(folders).toEqual(['C:/code/alpha', 'C:/code/beta']);

    const { stats } = await ask(env, { type: 'history.stats' });
    expect(stats.runs).toBe(4);
    expect(stats.bytes).toBeGreaterThan(0);
    expect(stats.oldestTs).toBe(Math.min(...[...(await seedTimes(env))]));
    expect(stats.retentionDays).toBe(DEFAULT_USER_SETTINGS.history.retentionDays);
    expect(stats.legacyFolder).toBeNull();

    const migrated = path.join(env.tmp.dir, 'events.migrated-2026-11-14');
    await fsp.mkdir(migrated);
    env.tmp.store.writeMeta({ [META_MIGRATED_TO]: migrated });
    expect((await ask(env, { type: 'history.stats' })).stats.legacyFolder).toBe(migrated);
  });

  it('counts the runs a shorter retention would delete, leaving live ones out', async () => {
    const env = await setup();
    await appendAll(env.tmp.store, fixtureSession('single-agent.jsonl', 'old-1', { lastTs: NOW - 10 * DAY }));
    await appendAll(env.tmp.store, fixtureSession('single-agent.jsonl', 'old-2', { lastTs: NOW - 8 * DAY }));
    await appendAll(env.tmp.store, fixtureSession('single-agent.jsonl', 'new-1', { lastTs: NOW - DAY }));
    expect((await ask(env, { type: 'history.retentionPreview', days: 7 })).preview).toEqual({ days: 7, runs: 2 });
    expect((await ask(env, { type: 'history.retentionPreview', days: 9 })).preview).toEqual({ days: 9, runs: 1 });
    expect((await ask(env, { type: 'history.retentionPreview', days: 30 })).preview).toEqual({ days: 30, runs: 0 });
  });

  it('stats count exactly the runs the list shows, with telemetry-only fragments stored', async () => {
    const env = await setup();
    await seedRuns(env);
    // Real data: 30 sessions, 7 of them fragments with no session start; stats said 30, the list 23.
    await appendAll(env.tmp.store, fragmentSession('frag-new', NOW - 30 * 60 * 1000));
    await appendAll(env.tmp.store, fragmentSession('frag-oldest', NOW - 20 * DAY));
    const { page } = await ask(env, { type: 'history.list', limit: 50 });
    expect(page.rows.map((r) => r.sessionId)).toEqual(RUNS.map((r) => r.id));
    const { stats } = await ask(env, { type: 'history.stats' });
    expect(stats.runs).toBe(page.rows.length);
    // The oldest run is the oldest listed one, not the older fragment.
    expect(stats.oldestTs).toBe(Math.min(...page.rows.map((r) => r.startTs)));
    // Asked again (now every derivation is current), still the same.
    expect((await ask(env, { type: 'history.stats' })).stats.runs).toBe(4);
  });

  it('the retention preview counts the runs the list shows; the deletion also removes older fragments', async () => {
    const env = await setup();
    await appendAll(env.tmp.store, fixtureSession('single-agent.jsonl', 'old-run', { lastTs: NOW - 10 * DAY }));
    await appendAll(env.tmp.store, fragmentSession('old-frag-1', NOW - 12 * DAY));
    await appendAll(env.tmp.store, fragmentSession('old-frag-2', NOW - 9 * DAY));
    await appendAll(env.tmp.store, fragmentSession('new-frag', NOW - DAY));
    await appendAll(env.tmp.store, fixtureSession('single-agent.jsonl', 'new-run', { lastTs: NOW - DAY }));

    expect((await ask(env, { type: 'history.retentionPreview', days: 7 })).preview).toEqual({ days: 7, runs: 1 });
    expect(await env.service.retentionRunCount(7)).toBe(1);
    // The list agrees: one of the two listed runs is older than 7 days.
    const { page } = await ask(env, { type: 'history.list', limit: 50 });
    expect(page.rows.map((r) => r.sessionId)).toEqual(['new-run', 'old-run']);

    const ids = await env.service.retentionCandidates(7);
    expect([...ids].sort()).toEqual(['old-frag-1', 'old-frag-2', 'old-run']);
    const outcome = await env.service.deleteSessions(ids);
    expect([...outcome.deleted].sort()).toEqual(['old-frag-1', 'old-frag-2', 'old-run']);
    expect((await env.tmp.store.listSessionRecords()).map((r) => r.sessionId).sort()).toEqual(['new-frag', 'new-run']);
    expect((await ask(env, { type: 'history.retentionPreview', days: 7 })).preview.runs).toBe(0);
    expect((await ask(env, { type: 'history.stats' })).stats.runs).toBe(1);
  });
});

async function seedTimes(env: Env): Promise<number[]> {
  const out: number[] = [];
  for (const r of RUNS) out.push(Math.min(...(await readBack(env.tmp.store, r.id)).map((e) => e.ts)));
  return out;
}

describe('history.open, stateAt and events', () => {
  it('gives the head with markers and quiet gaps', async () => {
    const env = await setup();
    const events = fixtureSession('failure.jsonl', 'run-f', { lastTs: NOW - DAY });
    // A 20-minute silence before the end (the stuck threshold is 5 min).
    const gapAt = events.length - 2;
    const shifted = events.map((e, i) => (i > gapAt ? { ...e, ts: e.ts + 20 * 60_000 } : e));
    await appendAll(env.tmp.store, shifted);
    const { head } = await ask(env, { type: 'history.open', sessionId: 'run-f' });
    const back = await readBack(env.tmp.store, 'run-f');
    expect(head.eventCount).toBe(back.length);
    expect(head.startsWithSession).toBe(true);
    expect(head.hasReport).toBe(true);
    expect(head.lastTs).toBe(back.at(-1)?.ts);
    expect(head.row.sessionId).toBe('run-f');
    // Brute force: approvals asked and tool failures.
    const expected = back.flatMap((e, index) => {
      if (e.type === 'approval.requested' && e.request.toolName !== 'AskUserQuestion') return [[index, 'approval']];
      if (e.type === 'tool.failed' || e.type === 'turn.failed') return [[index, 'failure']];
      return [];
    });
    expect(head.markers.map((m) => [m.index, m.kind])).toEqual(expected);
    expect(head.quietGaps.some((g) => g.afterIndex === gapAt && g.ms >= 20 * 60_000)).toBe(true);
  });

  it.each(['single-agent.jsonl', 'parallel-subagents.jsonl', 'permission-allow.jsonl', 'tasks-enabled.jsonl'])(
    'stateAt(i) is reduce(events[0..i]) through SQLite, %s, across the checkpoints',
    async (fixture) => {
      const env = await setup();
      const id = `long-${fixture.replace(/\W/g, '-')}`;
      await appendAll(env.tmp.store, longSession(fixture, id, 1100, NOW - DAY));
      const back = await readBack(env.tmp.store, id);
      const last = back.length - 1;
      for (const i of [0, 7, 499, 500, 501, 999, 1000, 1001, last]) {
        const { moment } = await ask(env, { type: 'history.stateAt', sessionId: id, index: i });
        expect(moment.index).toBe(i);
        expect(moment.eventCount).toBe(back.length);
        expect(moment.event).toEqual({
          index: i,
          ts: back[i]?.ts,
          type: back[i]?.type,
          agentKey: back[i]?.agentKey,
        });
        expect(moment.gapBeforeMs).toBe(i === 0 ? null : (back[i]?.ts ?? 0) - (back[i - 1]?.ts ?? 0));
        expect(moment.state, `index ${String(i)}`).toEqual(toHuddleState(replay(back.slice(0, i + 1))));
      }
      // Past the end is clamped to the last event.
      const clamped = await ask(env, { type: 'history.stateAt', sessionId: id, index: 10_000_000 });
      expect(clamped.moment.index).toBe(last);
    },
  );

  it('a session above the replay limit answers failed with words that say why (L2); others still replay', async () => {
    const env = await setup({ replayLimits: { maxEvents: 40 } });
    await appendAll(env.tmp.store, longSession('single-agent.jsonl', 'too-big', 100, NOW - DAY));
    await appendAll(env.tmp.store, fixtureSession('single-agent.jsonl', 'small', { lastTs: NOW - DAY }));
    for (const q of [
      { type: 'history.open', sessionId: 'too-big' },
      { type: 'history.stateAt', sessionId: 'too-big', index: 5 },
    ]) {
      const parsed = parseM5Query(q);
      if (parsed === null) throw new Error('refused');
      const result = await env.service.query(parsed);
      expect(result).toEqual({
        ok: false,
        code: 'failed',
        message: 'This run has more than 40 events, too many to replay here.',
      });
    }
    expect(env.logs).toContain('warn session too large to replay');
    const { moment } = await ask(env, { type: 'history.stateAt', sessionId: 'small', index: 0 });
    expect(moment.index).toBe(0);
  });

  it('pages events forward, backward, by agent, and whole when asked', async () => {
    const env = await setup();
    await appendAll(env.tmp.store, fixtureSession('nested-subagents.jsonl', 'run-n', { lastTs: NOW - DAY }));
    const back = await readBack(env.tmp.store, 'run-n');
    const fwd = await ask(env, { type: 'history.events', sessionId: 'run-n', fromIndex: 2, limit: 3 });
    expect(fwd.page.entries.map((e) => e.index)).toEqual([2, 3, 4]);
    expect(fwd.page.entries[0]).toEqual({
      index: 2,
      ts: back[2]?.ts,
      type: back[2]?.type,
      agentKey: back[2]?.agentKey,
    });
    expect(fwd.page.more).toBe(true);
    expect(fwd.page.eventCount).toBe(back.length);
    const bwd = await ask(env, { type: 'history.events', sessionId: 'run-n', fromIndex: 2, limit: 5, backward: true });
    expect(bwd.page.entries.map((e) => e.index)).toEqual([2, 1, 0]);
    expect(bwd.page.more).toBe(false);
    const sub = back.find((e) => e.agentKey !== agentKey('run-n'))?.agentKey ?? '';
    const mine = await ask(env, {
      type: 'history.events',
      sessionId: 'run-n',
      fromIndex: 0,
      limit: 2000,
      agentKey: sub,
      full: true,
    });
    const expected = back.flatMap((e, index) => (e.agentKey === sub ? [{ index, event: e }] : []));
    expect(mine.page.entries.map((e) => [e.index, e.event])).toEqual(expected.map((x) => [x.index, x.event]));
    expect(fwd.page.entries.every((e) => e.event === undefined)).toBe(true);
  });

  it('answers not_found for a session it does not have', async () => {
    const env = await setup();
    for (const q of [
      { type: 'history.open', sessionId: 'nope' },
      { type: 'history.stateAt', sessionId: 'nope', index: 0 },
      { type: 'history.events', sessionId: 'nope', fromIndex: 0, limit: 5 },
      { type: 'report.get', sessionId: 'nope' },
    ]) {
      const parsed = parseM5Query(q);
      if (parsed === null) throw new Error('refused');
      await expect(env.service.query(parsed)).resolves.toMatchObject({ ok: false, code: 'not_found' });
    }
  });
});

describe('reports', () => {
  it('report.get builds the report of an ended run and writes its Markdown file', async () => {
    const env = await setup();
    const logs = await seedRuns(env);
    const { answer } = await ask(env, { type: 'report.get', sessionId: 'run-parallel' });
    if (answer.status !== 'ready') throw new Error(answer.status);
    const events = logs.get('run-parallel') ?? [];
    const expected = buildRunReport(events, 'run-parallel');
    expect(answer.report).toEqual(expected);
    const file = reportPathFor(env.tmp.dir, 'run-parallel');
    expect(answer.file).toEqual({ path: file, exists: true, writtenAt: NOW });
    if (file === null || expected === null) throw new Error('no file');
    expect(await fsp.readFile(file, 'utf8')).toBe(renderReportMarkdown(expected));
    if (process.platform !== 'win32') {
      expect((await fsp.stat(file)).mode & 0o777).toBe(0o600);
      expect((await fsp.stat(path.dirname(file))).mode & 0o777).toBe(0o700);
    }
    // Asked again: the file is current, nothing is written.
    const before = await fsp.stat(file);
    await ask(env, { type: 'report.get', sessionId: 'run-parallel' });
    expect((await fsp.stat(file)).mtimeMs).toBe(before.mtimeMs);
  });

  it('report rows carry the same index as the history.open markers (M5 WP7)', async () => {
    const env = await setup();
    const sessions = [
      { fixture: 'failure.jsonl', id: 'ix-failure' },
      { fixture: 'permission-allow.jsonl', id: 'ix-allow' },
      { fixture: 'permission-deny.jsonl', id: 'ix-deny' },
    ];
    let failures = 0;
    let approvals = 0;
    for (const [n, x] of sessions.entries()) {
      await appendAll(env.tmp.store, fixtureSession(x.fixture, x.id, { lastTs: NOW - (n + 1) * HOUR }));
      const { answer } = await ask(env, { type: 'report.get', sessionId: x.id });
      if (answer.status !== 'ready') throw new Error(answer.status);
      const { head } = await ask(env, { type: 'history.open', sessionId: x.id });
      const marked = (kind: string): number[] => head.markers.filter((m) => m.kind === kind).map((m) => m.index);
      // The replay index counts tool, turn and run failures in the session's log alike.
      expect(answer.report.failures.map((f) => f.index)).toEqual(marked('failure'));
      expect(answer.report.approvals.map((a) => a.index)).toEqual(marked('approval'));
      failures += answer.report.failures.length;
      approvals += answer.report.approvals.length;
    }
    expect(failures).toBeGreaterThan(0);
    expect(approvals).toBeGreaterThan(0);
  });

  it('report.get is not_ready while live, and none for a log without a main agent', async () => {
    const env = await setup();
    const events = fixtureSession('single-agent.jsonl', 'run-live', { lastTs: NOW, dropEnd: true });
    await appendAll(env.tmp.store, events);
    env.live.state = replay(events.map(stored));
    env.live.startedAt = NOW - HOUR;
    expect((await ask(env, { type: 'report.get', sessionId: 'run-live' })).answer).toEqual({ status: 'not_ready' });
    await appendAll(env.tmp.store, [
      // A worktree filed under a run id placeholder before its run was launched: no main agent, not a run.
      {
        id: 'orphan-1',
        type: 'worktree.created',
        ts: NOW - DAY,
        sessionId: 'orphan',
        agentKey: 'orphan',
        source: 'huddle',
        runId: 'orphan',
        path: 'C:/w/orphan',
        branch: 'huddle/orphan',
        baseCommit: 'abc',
        repoRoot: 'C:/repo',
      } as unknown as HuddleEvent,
    ]);
    expect((await ask(env, { type: 'report.get', sessionId: 'orphan' })).answer).toEqual({ status: 'none' });
    const { page } = await ask(env, { type: 'history.list', limit: 50 });
    expect(page.rows.map((r) => r.sessionId)).not.toContain('orphan');
  });

  it('writes the report after the session ends (session.ended), once the batch is stored', async () => {
    const env = await setup();
    const events = fixtureSession('single-agent.jsonl', 'run-end', { lastTs: NOW - HOUR });
    await appendAll(env.tmp.store, events);
    env.service.noteStored(events);
    await env.service.flushReports();
    const file = reportPathFor(env.tmp.dir, 'run-end') ?? '';
    const expected = buildRunReport(events.map(stored), 'run-end');
    if (expected === null) throw new Error('no report');
    expect(await fsp.readFile(file, 'utf8')).toBe(renderReportMarkdown(expected));
    expect(env.tmp.store.history.agentRuns([])).toEqual(agentRunRows(events.map(stored), 'run-end'));
  });

  it('writes the report of a managed run that ended by run.exited with no SessionEnd (S16: taskkill)', async () => {
    const env = await setup();
    const id = 'run-managed';
    const body = fixtureSession('single-agent.jsonl', id, { lastTs: NOW - HOUR, dropEnd: true });
    const first = body[0]?.ts ?? NOW;
    const launched = {
      id: `${id}:launched`,
      type: 'run.launched',
      ts: first - 10,
      sessionId: id,
      agentKey: id,
      source: 'huddle',
      runId: id,
      claudeSessionId: id,
      templateId: null,
      cwd: 'C:/Users/user/project',
      model: 'sonnet',
      permissionMode: 'default',
      mainAgent: null,
      agentNames: [],
      worktree: null,
    } as unknown as HuddleEvent;
    const exited = {
      id: `${id}:exited`,
      type: 'run.exited',
      ts: NOW - HOUR + 5,
      sessionId: id,
      agentKey: id,
      source: 'huddle',
      runId: id,
      exitCode: 1,
      how: 'stopped',
      error: null,
    } as unknown as HuddleEvent;
    const events = [launched, ...body, exited];
    await appendAll(env.tmp.store, events);
    // Live until the exit: the root's run has exited in the live state.
    env.live.state = replay(events.map(stored));
    env.live.startedAt = first - 1000;
    env.service.noteStored([exited]);
    await env.service.flushReports();
    const file = reportPathFor(env.tmp.dir, id) ?? '';
    const expected = buildRunReport(events.map(stored), id);
    if (expected === null) throw new Error('no report');
    expect(expected.summary.outcome).toBe('stopped');
    expect(await fsp.readFile(file, 'utf8')).toBe(renderReportMarkdown(expected));
  });

  it('does not write a report for a run that is still live when its delay ends', async () => {
    const env = await setup();
    const events = fixtureSession('single-agent.jsonl', 'run-resumed', { lastTs: NOW, dropEnd: true });
    await appendAll(env.tmp.store, events);
    env.live.state = replay(events.map(stored));
    env.live.startedAt = NOW - HOUR;
    env.service.noteStored([{ ...(events[0] as HuddleEvent), type: 'worktree.closed' } as unknown as HuddleEvent]);
    await env.service.flushReports();
    expect(
      await fsp.access(reportPathFor(env.tmp.dir, 'run-resumed') ?? '').then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  });

  it('report.make writes on demand; open and copy name only an existing file inside reports/', async () => {
    const env = await setup();
    await seedRuns(env);
    const file = reportPathFor(env.tmp.dir, 'run-single');
    await expect(env.service.reportFileCommand('run-single')).resolves.toMatchObject({ ok: false, code: 'not_found' });
    await expect(env.service.makeReportCommand('run-single')).resolves.toEqual({ ok: true, detail: file });
    await expect(env.service.reportFileCommand('run-single')).resolves.toEqual({ ok: true, detail: file });
    await expect(env.service.makeReportCommand('nope')).resolves.toMatchObject({ ok: false, code: 'not_found' });
    await expect(env.service.reportFileCommand('../x')).resolves.toMatchObject({ ok: false, code: 'invalid' });
  });

  it('report.make while the end-of-run report is being written: both succeed, one file, no temp files', async () => {
    // Before the per-session writer, the second rename over <id>.md failed on Windows with EPERM in about 1 in 10 of
    // such pairs ("report file could not be written"). Several rounds so a regression shows up in one run.
    const env = await setup();
    for (let round = 0; round < 20; round++) {
      const id = `run-race-${String(round)}`;
      const events = fixtureSession('single-agent.jsonl', id, { lastTs: NOW - HOUR });
      await appendAll(env.tmp.store, events);
      env.service.noteStored(events);
      const file = reportPathFor(env.tmp.dir, id);
      const [a, b] = await Promise.all([
        env.service.makeReportCommand(id),
        env.service.makeReportCommand(id),
        env.service.flushReports(),
      ]);
      expect(a, id).toEqual({ ok: true, detail: file });
      expect(b, id).toEqual({ ok: true, detail: file });
      const expected = buildRunReport(events.map(stored), id);
      if (expected === null) throw new Error('no report');
      expect(await fsp.readFile(file ?? '', 'utf8')).toBe(renderReportMarkdown(expected));
    }
    expect(env.logs.filter((l) => l.startsWith('warn'))).toEqual([]);
    expect((await fsp.readdir(reportsDirOf(env.tmp.dir))).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('refuses a session id like ../x at the schema, and any resolved path outside reports/', () => {
    for (const sessionId of ['../x', '..\\x', 'a/b', 'a\\b', '..', 'x..y', 'C:', 'CON', '']) {
      expect(parseM5Command({ type: 'report.openFile', sessionId }), sessionId).toBeNull();
      expect(parseM5Command({ type: 'report.make', sessionId }), sessionId).toBeNull();
      expect(reportPathFor('C:/data', sessionId), sessionId).toBeNull();
    }
    const dir = reportsDirOf('/data');
    expect(isInsideReportsDir(dir, path.join(dir, 'ok.md'))).toBe(true);
    expect(isInsideReportsDir(dir, path.join(dir, '..', 'huddle-settings.json'))).toBe(false);
    expect(isInsideReportsDir(dir, path.join(dir, 'sub', 'x.md'))).toBe(false);
    expect(isInsideReportsDir(dir, dir)).toBe(false);
    expect(isInsideReportsDir(dir, path.resolve('/elsewhere/x.md'))).toBe(false);
    expect(isInsideReportsDir('C:\\d\\reports', 'C:\\D\\REPORTS\\x.md', 'win32')).toBe(true);
    expect(isInsideReportsDir('C:\\d\\reports', 'C:\\d\\reports\\..\\x.md', 'win32')).toBe(false);
  });
});

describe('scorecards and the backfill', () => {
  it('derives every stored run once (idempotent), records progress, and answers the scorecards', async () => {
    const env = await setup();
    const logs = await seedRuns(env);
    await env.service.backfill();
    const meta = JSON.parse(env.tmp.store.readMeta(META_BACKFILL) ?? '{}') as Record<string, unknown>;
    expect(meta).toMatchObject({ version: DERIVATION_VERSION, derived: RUNS.length, failed: 0, remaining: 0 });
    expect(meta.finishedAt).toBe(NOW);
    const rows = env.tmp.store.history.agentRuns([]);

    await env.service.backfill();
    const again = JSON.parse(env.tmp.store.readMeta(META_BACKFILL) ?? '{}') as Record<string, unknown>;
    expect(again).toMatchObject({ derived: 0, remaining: 0 });
    expect(env.tmp.store.history.agentRuns([])).toEqual(rows);
    expect(env.tmp.store.history.pendingDerivations(DERIVATION_VERSION, [], 10)).toEqual([]);

    const expectedRows = [...logs.entries()].flatMap(([id, events]) => scorecardRows(agentRunRows(events, id), events));
    const sortRows = <T extends { sessionId: string; agentKey: string }>(list: T[]): T[] =>
      [...list].sort((a, b) => (a.sessionId + a.agentKey < b.sessionId + b.agentKey ? -1 : 1));
    expect(sortRows(rows)).toEqual(sortRows(expectedRows));
    const { answer } = await ask(env, { type: 'scorecards.get' });
    expect(answer.retentionDays).toBe(DEFAULT_USER_SETTINGS.history.retentionDays);
    expect(answer.scorecards).toEqual(computeScorecards(rows));
  });

  it('stops at its bound and goes on with the rest in the next pass', async () => {
    const env = await setup({ backfillMaxSessions: 3 });
    await seedRuns(env);
    await env.service.backfill();
    expect(JSON.parse(env.tmp.store.readMeta(META_BACKFILL) ?? '{}')).toMatchObject({ derived: 3, remaining: null });
    expect(env.tmp.store.history.pendingDerivations(DERIVATION_VERSION, [], 10)).toHaveLength(1);
    await env.service.backfill();
    expect(JSON.parse(env.tmp.store.readMeta(META_BACKFILL) ?? '{}')).toMatchObject({ derived: 1, remaining: 0 });
  });

  it('derives again when the derivation version changes', async () => {
    const env = await setup();
    await seedRuns(env);
    await env.service.backfill();
    const d = env.tmp.store.history.session('run-single')?.derivation;
    if (d === undefined || d === null) throw new Error('not derived');
    env.tmp.store.history.writeDerivation({ ...d, version: DERIVATION_VERSION - 1 }, []);
    expect(env.tmp.store.history.pendingDerivations(DERIVATION_VERSION, [], 10).map((p) => p.sessionId)).toEqual([
      'run-single',
    ]);
    await ask(env, { type: 'scorecards.get' });
    expect(env.tmp.store.history.session('run-single')?.derivation?.version).toBe(DERIVATION_VERSION);
  });

  it('scorecards leave out fragments and sessions that did nothing, and give no prior for them', async () => {
    const env = await setup({ priorsDelayMs: 0 });
    await seedRuns(env);
    for (const id of ['frag-1', 'frag-2', 'frag-3'])
      await appendAll(env.tmp.store, fragmentSession(id, NOW - 5 * HOUR));
    // Three opened-and-closed sessions: before the fix a "main / model unknown, 0 ms, n=3" card, used for estimates.
    for (const id of ['idle-1', 'idle-2', 'idle-3']) await appendAll(env.tmp.store, idleSession(id, NOW - 6 * HOUR));
    const { answer } = await ask(env, { type: 'scorecards.get' });
    const stored = env.tmp.store.history.agentRuns([]);
    expect(stored.some((r) => r.sessionId.startsWith('frag-') || r.sessionId.startsWith('idle-'))).toBe(false);
    expect(answer.scorecards.some((c) => c.role === 'main' && c.model === null)).toBe(false);
    expect(answer.scorecards).toEqual(computeScorecards(stored));
    // The idle sessions are still runs in the list (they have a root); the fragments are not.
    const { page } = await ask(env, { type: 'history.list', limit: 50 });
    expect(page.rows.filter((r) => r.sessionId.startsWith('idle-'))).toHaveLength(3);
    expect(page.rows.filter((r) => r.sessionId.startsWith('frag-'))).toHaveLength(0);
    expect(Object.keys(etaPriorsFrom(answer.scorecards, NOW).byRoleModel).some((k) => k.includes('null'))).toBe(false);
  });
});

describe('ETA priors (M5 WP7)', () => {
  /** Lets the debounce timer (priorsDelayMs 0) fire. */
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

  it('are computed after the backfill from the stored scorecards, cached, and announced only when they change', async () => {
    let changed = 0;
    const env = await setup({ priorsDelayMs: 0, onPriorsChanged: () => (changed += 1) });
    expect(env.service.priors()).toBeNull();
    await seedRuns(env);
    await env.service.backfill();
    await settle();
    const rows = env.tmp.store.history.agentRuns([BUDGETS]);
    expect(env.service.priors()).toEqual(etaPriorsFrom(computeScorecards(rows), NOW));
    expect(Object.keys(env.service.priors()?.byRoleModel ?? {}).length).toBeGreaterThan(0);
    expect(changed).toBe(1);
    // A second pass derives nothing and changes nothing: no second announcement.
    await env.service.backfill();
    await settle();
    expect(changed).toBe(1);
  });

  it('are computed again after a run is deleted, and not after dispose', async () => {
    let changed = 0;
    const env = await setup({ priorsDelayMs: 0, onPriorsChanged: () => (changed += 1) });
    await seedRuns(env);
    await env.service.backfill();
    await settle();
    const before = env.service.priors();
    await env.service.deleteSessions(RUNS.map((r) => r.id));
    await settle();
    expect(env.service.priors()).toEqual({ byRoleModel: {}, asOf: NOW });
    expect(Object.keys(before?.byRoleModel ?? {}).length).toBeGreaterThan(0);
    expect(changed).toBe(2);
    env.service.dispose();
    env.service.recomputePriors();
    expect(env.service.priors()).toEqual({ byRoleModel: {}, asOf: NOW });
  });

  it('leave out the live sessions and the excluded ones, as scorecards.get does', async () => {
    const env = await setup({ priorsDelayMs: 0, exclude: [BUDGETS, ...RUNS.map((r) => r.id)] });
    await seedRuns(env);
    await env.service.backfill();
    await settle();
    expect(env.service.priors()).toEqual({ byRoleModel: {}, asOf: NOW });
  });
});
