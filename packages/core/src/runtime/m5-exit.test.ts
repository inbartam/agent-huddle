/**
 * M5 exit criteria, offline half (WP8): the three sentences of docs/ROADMAP.md M5 "Exit", checked through a real
 * HuddleCore (JSONL import into SQLite, the M5 queries) over recorded fixtures.
 *
 *  1. "Open yesterday's run, scrub to the moment an agent got stuck and see why."
 *  2. "The report for a run matches its events."
 *  3. "The scorecard shows a difference between two models on the same role."
 *
 * `npm run m5:exit` runs this file and collects the evidence it writes to HUDDLE_M5_EVIDENCE_DIR (when set). The real
 * `claude` half (a managed run that goes quiet) is not run here; it needs a real run in the app.
 *
 * Exit 1 note: no recorded fixture holds a stuck incident (the detector is time-based, a recording only has the
 * attention events the recorder never produced). So the stuck run is derived, deterministically: a recorded fixture
 * with a quiet gap inserted after one tool call, folded through the real detectors (`step`/`tick`), and the raised and
 * cleared events stored in the log where a live Huddle would have written them.
 */
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_USER_SETTINGS,
  MIN_PRIOR_SAMPLES,
  priorUnitMsFor,
  type AgentRunRow,
  type HuddleEvent,
  type QueryResult,
  type RunReport,
  type Scorecard,
} from '@huddle/shared';
import { emptyDetectorState, SPAWN_TOOLS, step, tick, type DetectorEmit } from '../detect/index.js';
import { renderReportMarkdown } from '../report/markdown.js';
import { JsonlEventStore } from '../store/jsonl-store.js';
import { FIXTURES_DIR } from '../test/fixtures.js';
import { renameSession } from '../test/history-sessions.js';
import { fixtureEvents } from '../test/replay-fixture.js';
import { readStoredLog } from '../test/stored-log.js';
import { listRunFixtures } from '../test/run-fixtures.js';
import { HuddleCore } from './huddle-core.js';
import { reportPathFor } from './report-files.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const MIN = 60_000;
const EVIDENCE = process.env.HUDDLE_M5_EVIDENCE_DIR;

function evidence(name: string, content: unknown): void {
  if (EVIDENCE === undefined || EVIDENCE === '') return;
  mkdirSync(EVIDENCE, { recursive: true });
  writeFileSync(path.join(EVIDENCE, name), typeof content === 'string' ? content : JSON.stringify(content, null, 2));
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

interface Env {
  dataDir: string;
  core: HuddleCore;
  now: number;
}

/** Seeds a JSONL events folder, starts a real HuddleCore on it (which imports it into SQLite), waits for the import. */
async function startOn(events: readonly HuddleEvent[], now: number): Promise<Env> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'huddle-m5-exit-'));
  const dataDir = path.join(root, 'data');
  const claudeDir = path.join(root, 'claude');
  await fsp.mkdir(claudeDir, { recursive: true });
  await fsp.writeFile(path.join(root, 'forwarder.mjs'), '// test forwarder\n');
  const seed = new JsonlEventStore({ baseDir: path.join(dataDir, 'events') });
  await seed.append([...events]);
  await seed.close();
  const core = new HuddleCore({
    dataDir,
    claudeConfigDir: claudeDir,
    cwd: null,
    userAgentsDir: null,
    port: 0,
    now: () => now,
    forwarderSource: path.join(root, 'forwarder.mjs'),
    newToken: () => 'm5-exit-token-0123456789',
    history: { reportDelayMs: 0, retentionAtStart: false, priorsDelayMs: 0 },
  });
  let disposed = false;
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    await core.dispose();
  };
  cleanups.push(async () => {
    await dispose();
    await fsp.rm(root, { recursive: true, force: true, maxRetries: 5 });
  });
  const started = await core.start();
  if (!started.ok) throw new Error(started.message);
  for (let i = 0; i < 200; i++) {
    const r = await core.query({ type: 'history.stats' });
    if (r.ok && r.type === 'history.stats' && !r.stats.migrating) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return { dataDir, core, now };
}

async function dispose(env: Env): Promise<void> {
  await env.core.dispose();
}

function okq(result: QueryResult): Extract<QueryResult, { ok: true }> {
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result;
}

/** A fixture's events as sessions of their own: every session id renamed to `<tag>-<n>`, unique event ids. */
function importable(fixture: string, tag: string): HuddleEvent[] {
  const events = fixtureEvents(fixture);
  const ids = [...new Set(events.map((e) => e.sessionId))];
  return events.map((e) => {
    let out: unknown = e;
    ids.forEach((id, n) => {
      out = renameSession(out, id, `${tag}-${String(n)}`);
    });
    return { ...(out as HuddleEvent), id: `${tag}:${e.id}` };
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Exit 1
// ---------------------------------------------------------------------------------------------------------------------

interface StuckBuild {
  events: HuddleEvent[];
  sessionId: string;
  fixture: string;
  agent: string;
  toolName: string;
  quietAtRaise: number;
  gapMs: number;
  raisedIds: string[];
}

/**
 * `fixture` with a quiet gap after its first non-spawn tool call that is later finished, then the detectors folded
 * over it with one `tick` inside the gap (what the live timer does) so the stuck item is in the log. All times are
 * moved so the run starts at `startTs` and the session is renamed `sessionId`.
 */
function deriveStuck(fixture: string, sessionId: string, startTs: number): StuckBuild | null {
  const base = fixtureEvents(fixture).map((e) => renameSession(e, 'session-1', sessionId) as HuddleEvent);
  const thresholds = DEFAULT_USER_SETTINGS.detectors;
  const openToolMs = thresholds.stuckOpenToolMinutes * MIN;
  const gapMs = openToolMs + 3 * MIN;
  const tickAfter = openToolMs + MIN;
  const finished = new Set(base.flatMap((e) => (e.type === 'tool.finished' ? [e.toolUseId] : [])));
  const at = base.findIndex(
    (e, i) =>
      e.type === 'tool.started' &&
      !SPAWN_TOOLS.has(e.toolName) &&
      finished.has(e.toolUseId) &&
      i + 2 < base.length &&
      base[i + 1]?.agentKey === e.agentKey,
  );
  if (at < 0) return null;
  const started = base[at];
  if (started?.type !== 'tool.started') return null;
  const shift = startTs - (base[0]?.ts ?? 0);
  const out: HuddleEvent[] = [];
  let state = emptyDetectorState();
  const emitted: DetectorEmit[] = [];
  const push = (e: HuddleEvent): void => {
    out.push(e);
    const s = step(state, e, thresholds);
    state = s.state;
    for (const m of s.emit) {
      out.push(m);
      emitted.push(m);
    }
  };
  base.forEach((e, i) => {
    const moved: HuddleEvent = { ...e, id: `${sessionId}:${e.id}`, ts: e.ts + shift + (i > at ? gapMs : 0) };
    if (i === at + 1) {
      const t = tick(state, started.ts + shift + tickAfter, thresholds);
      state = t.state;
      for (const m of t.emit) {
        out.push(m);
        emitted.push(m);
      }
    }
    push(moved);
  });
  return {
    events: out,
    sessionId,
    fixture,
    agent: started.agentKey,
    toolName: started.toolName,
    quietAtRaise: tickAfter,
    gapMs,
    raisedIds: emitted.flatMap((m) => (m.type === 'attention.raised' ? [m.item.id] : [])),
  };
}

describe("exit 1: open yesterday's run, scrub to the moment an agent got stuck, see why", () => {
  it('lists it under yesterday, marks the stuck moment, and the moment says why', async () => {
    // Local "now" 10:00 on 15 Nov 2026; the run began 14:00 the day before and (with the gap) ended before midnight.
    const now = new Date(2026, 10, 15, 10, 0, 0).getTime();
    const yesterdayStart = new Date(2026, 10, 14, 14, 0, 0).getTime();
    let build: StuckBuild | null = null;
    for (const f of [
      'permission-allow.jsonl',
      'failure.jsonl',
      'single-agent.jsonl',
      'tasks-enabled.jsonl',
      'parallel-subagents.jsonl',
    ]) {
      build = deriveStuck(f, 'yesterday-run', yesterdayStart);
      if (build !== null && build.raisedIds.some((id) => id.startsWith('stuck:'))) break;
      build = null;
    }
    if (build === null) throw new Error('no fixture gave a stuck incident');
    const env = await startOn(build.events, now);

    // 1. History lists it under yesterday (the same local-day rule as the History view's day headers).
    const list = okq(await env.core.query({ type: 'history.list', limit: 50 }));
    if (list.type !== 'history.list') throw new Error(list.type);
    const row = list.page.rows.find((r) => r.sessionId === build.sessionId);
    expect(row, 'the run is in the list').toBeDefined();
    const yesterday = new Date(now - DAY).toDateString();
    expect(new Date(row?.startTs ?? 0).toDateString()).toBe(yesterday);
    expect(new Date(now).toDateString()).not.toBe(yesterday);

    // 2. history.open has a stuck marker for the agent we silenced.
    const open = okq(await env.core.query({ type: 'history.open', sessionId: build.sessionId }));
    if (open.type !== 'history.open') throw new Error(open.type);
    const marker = open.head.markers.find((m) => m.kind === 'stuck' && m.agentKey === build.agent);
    expect(marker, 'a stuck marker for the silenced agent').toBeDefined();
    if (marker === undefined) return;
    const stored = await (async () => {
      await dispose(env);
      return readStoredLog(env.dataDir, build.sessionId);
    })();
    expect(stored[marker.index]?.type).toBe('attention.raised');

    // 3. stateAt at that marker: why[] has the stuck entry with the last tool call, its fate, quietMs and later.
    const env2 = await startOn(build.events, now);
    const moment = okq(
      await env2.core.query({ type: 'history.stateAt', sessionId: build.sessionId, index: marker.index }),
    );
    if (moment.type !== 'history.stateAt') throw new Error(moment.type);
    const why = moment.moment.why.find((w) => w.kind === 'stuck' && w.agentKey === build.agent);
    expect(why, 'a why entry of kind stuck for that agent').toBeDefined();
    if (why === undefined) return;
    const thresholdMs = DEFAULT_USER_SETTINGS.detectors.stuckOpenToolMinutes * MIN;
    expect(why.lastToolCall?.toolName).toBe(build.toolName);
    expect(why.lastToolCall?.fate.state).toBe('open');
    expect(why.quietMs).not.toBeNull();
    expect(why.quietMs ?? 0).toBeGreaterThan(thresholdMs);
    expect(why.later.kind).toBe('cleared');
    expect(why.raisedIndex).toBe(marker.index);

    // 4. The tree at that index shows the agent's status.
    const node = Object.values(moment.moment.state.agents).find((a) => a.key === build.agent);
    expect(node, 'the agent is in the tree at that index').toBeDefined();
    expect(node?.status).not.toBe('done');
    expect(['working', 'idle', 'paused', 'waiting_for_user', 'needs_approval', 'blocked']).toContain(node?.status);

    const dump = [
      `run: ${build.sessionId} (derived from fixtures/${build.fixture}, gap ${String(build.gapMs / MIN)} min after one ${build.toolName} call)`,
      `listed under: Yesterday (${yesterday})`,
      `marker: index ${String(marker.index)} of ${String(open.head.eventCount)}, kind ${marker.kind}, agent ${marker.agentKey}`,
      `why: ${why.title}`,
      `  detail: ${why.detail}`,
      `  last tool call: ${why.lastToolCall?.toolName ?? '-'} "${why.lastToolCall?.summary ?? ''}" fate ${JSON.stringify(why.lastToolCall?.fate)}`,
      `  quiet for: ${String(Math.round((why.quietMs ?? 0) / MIN))} min (threshold ${String(thresholdMs / MIN)} min, open tool)`,
      `  later: ${JSON.stringify(why.later)}`,
      `tree at index ${String(marker.index)}: ${node?.key ?? '-'} status ${node?.status ?? '-'}`,
    ].join('\n');
    evidence('exit1-why.txt', dump + '\n');
    evidence('exit1.json', {
      derivedFrom: build.fixture,
      note: 'no recorded fixture holds a stuck incident; derived with a quiet gap through the real detectors',
      sessionId: build.sessionId,
      markers: open.head.markers,
      quietGaps: open.head.quietGaps,
      moment: { index: moment.moment.index, event: moment.moment.event, why: moment.moment.why },
      agentStatus: node?.status,
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Exit 2
// ---------------------------------------------------------------------------------------------------------------------

interface Tally {
  toolCalls: number;
  toolFailures: number;
  tasksCreated: number;
  tasksCompleted: number;
  approvals: { requested: number; byUser: number; byPolicy: number; other: number; unresolved: number };
  tokens: { input: number; output: number; cacheRead: number; cacheCreation: number; requests: number } | null;
  durationMs: number | null;
}

/** Counts straight from stored events. Deliberately does not import the report or reducer code. */
function tallyEvents(events: readonly HuddleEvent[], sessionId: string): Map<string, Tally> {
  const own = events.filter((e) => e.sessionId === sessionId);
  const keys = new Set(own.map((e) => e.agentKey));
  const out = new Map<string, Tally>();
  for (const key of keys) {
    const mine = own.filter((e) => e.agentKey === key);
    const created = new Set<string>();
    const completed = new Set<string>();
    for (const e of mine) {
      if (e.type === 'task.created') created.add(e.taskId);
      if (e.type === 'task.completed') completed.add(e.taskId);
    }
    const seenReq = new Set<string>();
    const resolution = new Map<string, string>();
    for (const e of own) {
      if (e.type === 'approval.resolved' && !resolution.has(e.requestId)) resolution.set(e.requestId, e.by);
    }
    const approvals = { requested: 0, byUser: 0, byPolicy: 0, other: 0, unresolved: 0 };
    for (const e of mine) {
      if (e.type !== 'approval.requested' || e.request.toolName === 'AskUserQuestion') continue;
      if (seenReq.has(e.request.requestId)) continue;
      seenReq.add(e.request.requestId);
      approvals.requested += 1;
      const by = resolution.get(e.request.requestId);
      if (by === undefined) approvals.unresolved += 1;
      else if (by === 'user') approvals.byUser += 1;
      else if (by === 'policy') approvals.byPolicy += 1;
      else approvals.other += 1;
    }
    // Usage: one request id once per session; a request counts on the agent unless it is a helper/compact/other
    // request, or a subagent-sourced request recorded on the root.
    const tokens = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, requests: 0 };
    const seenUsage = new Set<string>();
    for (const e of own) {
      if (e.type !== 'usage.recorded') continue;
      if (e.requestId !== null) {
        if (seenUsage.has(e.requestId)) continue;
        seenUsage.add(e.requestId);
      }
      const kind = e.querySourceKind;
      const helper =
        kind === undefined || kind === 'main' ? false : kind === 'subagent' ? e.agentKey === sessionId : true;
      if (helper || e.agentKey !== key) continue;
      tokens.input += e.inputTokens;
      tokens.output += e.outputTokens;
      tokens.cacheRead += e.cacheReadTokens;
      tokens.cacheCreation += e.cacheCreationTokens;
      tokens.requests += 1;
    }
    const isRoot = key === sessionId;
    // An agent exists from its first non-telemetry event (usage and context readings never create one).
    const telemetry = new Set<string>(['usage.recorded', 'context.measured', 'model.observed']);
    const start = mine.find((e) => !telemetry.has(e.type));
    const stops = mine.filter((e) => (isRoot ? e.type === 'session.ended' : e.type === 'agent.stopped'));
    // A teammate that went idle after its last stop is still alive, waiting for messages (M6, S20): no end yet.
    const lastStop = stops.at(-1);
    const idleAfter = lastStop !== undefined && mine.some((e) => e.type === 'teammate.idle' && e.ts >= lastStop.ts);
    // ... unless the lead then reported it finished (M6 P5b, teammate.reported on the lead's key, naming it).
    let reported: HuddleEvent | undefined;
    if (idleAfter) {
      const started = mine.find((e) => e.type === 'agent.started' && e.teammateName !== undefined);
      const name = started?.type === 'agent.started' ? started.teammateName : undefined;
      const lastIdle = mine.filter((e) => e.type === 'teammate.idle').at(-1);
      reported = own.find(
        (e) =>
          e.type === 'teammate.reported' &&
          e.status === 'finished' &&
          e.teammateName === name &&
          lastIdle !== undefined &&
          e.ts >= lastIdle.ts,
      );
    }
    const end = idleAfter ? reported : stops[0];
    out.set(key, {
      toolCalls: mine.filter((e) => e.type === 'tool.started').length,
      toolFailures: mine.filter((e) => e.type === 'tool.failed').length,
      tasksCreated: created.size,
      tasksCompleted: [...completed].filter((id) => created.has(id)).length,
      approvals,
      tokens: tokens.requests === 0 ? null : tokens,
      durationMs: start !== undefined && end !== undefined ? Math.max(0, end.ts - start.ts) : null,
    });
  }
  return out;
}

function rowTally(row: AgentRunRow): Tally {
  return {
    toolCalls: row.toolCalls,
    toolFailures: row.toolFailures,
    tasksCreated: row.tasksCreated,
    tasksCompleted: row.tasksCompleted,
    approvals: { ...row.approvals },
    tokens: row.tokens === null ? null : { ...row.tokens },
    durationMs: row.durationMs,
  };
}

function allFixtureNames(): string[] {
  return readdirSync(FIXTURES_DIR)
    .filter((n) => n.endsWith('.jsonl'))
    .sort()
    .concat(listRunFixtures().map((r) => r.file));
}

describe('exit 2: the report for a run matches its events', () => {
  it('every fixture session: report.get counts equal tallies taken directly from the stored events, and the file is the rendered Markdown', async () => {
    const sources: { name: string; events: HuddleEvent[] }[] = [];
    for (const name of allFixtureNames()) {
      const events = importable(name, name.replace(/\.jsonl$/, '').replace(/[^a-z0-9]+/gi, '-'));
      if (events.length > 0) sources.push({ name, events });
    }
    const all = sources.flatMap((s) => s.events);
    const maxTs = Math.max(...all.map((e) => e.ts));
    const env = await startOn(all, maxTs + HOUR);

    const answers = new Map<string, { report: RunReport; file: string | null }>();
    const skipped: { fixture: string; sessionId: string; status: string }[] = [];
    const sessionsOf = (events: readonly HuddleEvent[]): string[] => [...new Set(events.map((e) => e.sessionId))];
    for (const s of sources) {
      for (const id of sessionsOf(s.events)) {
        const r = okq(await env.core.query({ type: 'report.get', sessionId: id }));
        if (r.type !== 'report.get') throw new Error(r.type);
        if (r.answer.status !== 'ready') {
          skipped.push({ fixture: s.name, sessionId: id, status: r.answer.status });
          continue;
        }
        answers.set(id, { report: r.answer.report, file: r.answer.file?.path ?? null });
      }
    }
    await env.core.flushReports();
    await dispose(env);

    const table: {
      fixture: string;
      sessionId: string;
      agents: number;
      result: 'match' | 'mismatch';
      differences: string[];
    }[] = [];
    for (const s of sources) {
      for (const id of sessionsOf(s.events)) {
        const got = answers.get(id);
        if (got === undefined) continue;
        const stored = await readStoredLog(env.dataDir, id);
        const tallies = tallyEvents(stored, id);
        const diffs: string[] = [];
        let toolCalls = 0;
        let toolFailures = 0;
        let approvalsRequested = 0;
        for (const agent of got.report.agents) {
          const t = tallies.get(agent.row.agentKey);
          if (t === undefined) {
            diffs.push(`${agent.row.agentKey}: in the report but has no events`);
            continue;
          }
          const r = rowTally(agent.row);
          toolCalls += r.toolCalls;
          toolFailures += r.toolFailures;
          approvalsRequested += r.approvals.requested;
          for (const field of [
            'toolCalls',
            'toolFailures',
            'tasksCreated',
            'tasksCompleted',
            'approvals',
            'tokens',
            'durationMs',
          ] as const) {
            if (JSON.stringify(r[field]) !== JSON.stringify(t[field])) {
              diffs.push(
                `${agent.row.agentKey}.${field}: report ${JSON.stringify(r[field])} vs events ${JSON.stringify(t[field])}`,
              );
            }
          }
          // Per-tool breakdown must add up to the agent's own call count.
          const byTool = agent.tools.reduce((n, u) => n + u.calls, 0);
          if (byTool !== r.toolCalls)
            diffs.push(`${agent.row.agentKey}.tools sum ${String(byTool)} vs toolCalls ${String(r.toolCalls)}`);
        }
        if (got.report.summary.toolCalls !== toolCalls)
          diffs.push(`summary.toolCalls ${String(got.report.summary.toolCalls)} vs ${String(toolCalls)}`);
        if (got.report.summary.toolFailures !== toolFailures)
          diffs.push(`summary.toolFailures ${String(got.report.summary.toolFailures)} vs ${String(toolFailures)}`);
        if (got.report.summary.approvalsRequested !== approvalsRequested)
          diffs.push(
            `summary.approvalsRequested ${String(got.report.summary.approvalsRequested)} vs ${String(approvalsRequested)}`,
          );
        // The Markdown on disk is the rendering of this report.
        const file = reportPathFor(env.dataDir, id);
        if (file === null) diffs.push('no report path');
        else {
          const text = await fsp.readFile(file, 'utf8').catch(() => null);
          if (text === null) diffs.push('report file missing on disk');
          else if (text !== renderReportMarkdown(got.report))
            diffs.push('report file differs from renderReportMarkdown(report)');
        }
        table.push({
          fixture: s.name,
          sessionId: id,
          agents: got.report.agents.length,
          result: diffs.length === 0 ? 'match' : 'mismatch',
          differences: diffs,
        });
      }
    }
    const lines = [
      'fixture | session | agents | result',
      ...table.map(
        (r) =>
          `${r.fixture} | ${r.sessionId} | ${String(r.agents)} | ${r.result}${r.differences.length ? '\n    ' + r.differences.join('\n    ') : ''}`,
      ),
      '',
      `skipped (no report): ${skipped.map((s) => `${s.fixture}[${s.status}]`).join(', ') || 'none'}`,
    ];
    evidence('exit2-table.txt', lines.join('\n') + '\n');
    evidence('exit2.json', { table, skipped });
    expect(table.length).toBeGreaterThanOrEqual(25);
    expect(table.filter((r) => r.result === 'mismatch')).toEqual([]);
  }, 180_000);
});

// ---------------------------------------------------------------------------------------------------------------------
// Exit 3
// ---------------------------------------------------------------------------------------------------------------------

function fmtMs(ms: number | null): string {
  return ms === null ? 'unknown' : `${(ms / 1000).toFixed(1)} s`;
}

describe('exit 3: the scorecard shows a difference between two models on the same role', () => {
  it('imports every recorded run and finds a role with two models, each with enough runs, that differ', async () => {
    const runs = listRunFixtures();
    expect(runs.length).toBeGreaterThanOrEqual(30);
    const events = runs.flatMap((r) => importable(r.file, r.id.replace(/[^a-z0-9]+/gi, '-')));
    const env = await startOn(events, Math.max(...events.map((e) => e.ts)) + HOUR);
    const r = okq(await env.core.query({ type: 'scorecards.get' }));
    if (r.type !== 'scorecards.get') throw new Error(r.type);
    const cards: Scorecard[] = r.answer.scorecards;
    await dispose(env);

    const roles = [...new Set(cards.map((c) => c.role))].sort();
    const header =
      'role | model | runs | n (completed) | median time per task | tokens per task | failure rate | prior';
    const rows = cards.map((c) =>
      [
        c.role,
        c.model ?? 'unknown',
        String(c.runs),
        String(c.sampleSize),
        fmtMs(c.medianTaskMs),
        c.tokensPerTask === null ? 'unknown' : Math.round(c.tokensPerTask).toLocaleString('en-US'),
        c.failureRate === null ? 'unknown' : `${String(Math.round(c.failureRate * 100))}%`,
        (() => {
          const p = priorUnitMsFor(cards, c.role, c.model);
          return p === null ? 'none' : fmtMs(p);
        })(),
      ].join(' | '),
    );
    const differing: {
      role: string;
      models: string[];
      medianTaskMs: (number | null)[];
      tokensPerTask: (number | null)[];
    }[] = [];
    for (const role of roles) {
      const enough = cards.filter((c) => c.role === role && c.model !== null && c.sampleSize >= MIN_PRIOR_SAMPLES);
      if (enough.length < 2) continue;
      const times = new Set(enough.map((c) => c.medianTaskMs));
      const tokens = new Set(enough.map((c) => c.tokensPerTask));
      if (times.size > 1 || tokens.size > 1) {
        differing.push({
          role,
          models: enough.map((c) => c.model ?? ''),
          medianTaskMs: enough.map((c) => c.medianTaskMs),
          tokensPerTask: enough.map((c) => c.tokensPerTask),
        });
      }
    }
    evidence(
      'exit3-table.txt',
      [
        `runs imported: ${String(runs.length)} (fixtures/runs); MIN_PRIOR_SAMPLES = ${String(MIN_PRIOR_SAMPLES)}`,
        header,
        ...rows,
        '',
        'roles with two or more models at or above MIN_PRIOR_SAMPLES that differ:',
        ...differing.map(
          (d) =>
            `  ${d.role}: ${d.models.map((m, i) => `${m} ${fmtMs(d.medianTaskMs[i] ?? null)}, ${String(Math.round(d.tokensPerTask[i] ?? 0))} tok`).join(' vs ')}`,
        ),
      ].join('\n') + '\n',
    );
    evidence('exit3.json', { scorecards: cards, differing });
    expect(differing.length).toBeGreaterThanOrEqual(1);
  }, 180_000);
});
