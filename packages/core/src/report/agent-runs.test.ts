/**
 * Agent run rows (F23 F24) over every recorded fixture: each row's counts must equal a tally made here, straight from
 * the raw events, without the reducer or the code under test.
 */
import { describe, expect, it } from 'vitest';
import type { AgentRunRow, HuddleEvent, TokenCounts } from '@huddle/shared';
import { listFixtureFiles } from '../test/fixtures.js';
import { fixtureEvents } from '../test/replay-fixture.js';
import { listRunFixtures } from '../test/run-fixtures.js';
import { builder, MAIN, sampleSession, SUB } from '../test/report-events.js';
import { agentRunRows, scorecardRows } from './agent-runs.js';
import { computeScorecards } from './scorecards.js';
import { fragmentSession, idleSession } from '../test/history-sessions.js';

const fixtures = [...listFixtureFiles(), ...listRunFixtures().map((r) => r.file)];

interface Tally {
  toolCalls: number;
  toolFailures: number;
  approvals: Set<string>;
  tasksCompleted: Set<string>;
  tokens: TokenCounts | null;
}

/** Counts per agent key, from the raw events only. Usage: once per request id per session; helper requests and
 * subagent-sourced requests without an agent id go to no agent (they are the root's helper usage). */
function tally(events: readonly HuddleEvent[]): Map<string, Tally> {
  const out = new Map<string, Tally>();
  const get = (key: string): Tally => {
    let t = out.get(key);
    if (t === undefined) {
      t = { toolCalls: 0, toolFailures: 0, approvals: new Set(), tasksCompleted: new Set(), tokens: null };
      out.set(key, t);
    }
    return t;
  };
  const seenRequests = new Set<string>();
  const created = new Set<string>();
  for (const e of events) {
    if (e.type === 'tool.started') get(e.agentKey).toolCalls += 1;
    else if (e.type === 'tool.failed') get(e.agentKey).toolFailures += 1;
    else if (e.type === 'approval.requested' && e.request.toolName !== 'AskUserQuestion')
      get(e.agentKey).approvals.add(e.request.requestId);
    else if (e.type === 'task.created') created.add(`${e.agentKey}|${e.taskId}`);
    else if (e.type === 'task.completed' && created.has(`${e.agentKey}|${e.taskId}`))
      get(e.agentKey).tasksCompleted.add(e.taskId);
    else if (e.type === 'usage.recorded') {
      if (e.requestId !== null) {
        const id = `${e.sessionId}|${e.requestId}`;
        if (seenRequests.has(id)) continue;
        seenRequests.add(id);
      }
      const kind = e.querySourceKind;
      const own = kind === undefined || kind === 'main' || (kind === 'subagent' && e.agentKey !== e.sessionId);
      if (!own) continue;
      const t = get(e.agentKey);
      const prev = t.tokens ?? { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, requests: 0 };
      t.tokens = {
        input: prev.input + e.inputTokens,
        output: prev.output + e.outputTokens,
        cacheRead: prev.cacheRead + e.cacheReadTokens,
        cacheCreation: prev.cacheCreation + e.cacheCreationTokens,
        requests: prev.requests + 1,
      };
    }
  }
  return out;
}

describe('agentRunRows over recorded fixtures', () => {
  it('finds fixtures', () => {
    expect(fixtures.length).toBeGreaterThan(10);
  });

  it.each(fixtures)('%s: counts equal a tally of the raw events', (name) => {
    const events = fixtureEvents(name);
    const rows = agentRunRows(events);
    const counts = tally(events);
    const sessions = new Set(events.map((e) => e.sessionId));
    const roles = new Map<string, string>();
    for (const e of events)
      if (e.type === 'agent.started' && e.role !== '' && !roles.has(e.agentKey)) roles.set(e.agentKey, e.role);
    const subagents = new Set(roles.keys());

    // One row per session root plus one per started subagent.
    expect(rows.map((r) => r.agentKey).sort()).toEqual([...sessions, ...subagents].sort());
    for (const row of rows) {
      const t = counts.get(row.agentKey);
      expect(row.toolCalls, row.agentKey).toBe(t?.toolCalls ?? 0);
      expect(row.toolFailures, row.agentKey).toBe(t?.toolFailures ?? 0);
      expect(row.approvals.requested, row.agentKey).toBe(t?.approvals.size ?? 0);
      expect(row.approvals.byUser + row.approvals.byPolicy + row.approvals.other + row.approvals.unresolved).toBe(
        row.approvals.requested,
      );
      expect(row.tasksCompleted, row.agentKey).toBe(t?.tasksCompleted.size ?? 0);
      expect(row.tokens, row.agentKey).toEqual(t?.tokens ?? null);
      expect(row.estimatedCostUsd === null).toBe(row.tokens === null);
      expect(row.role, row.agentKey).toBe(row.kind === 'main' ? 'main' : roles.get(row.agentKey));
      if (row.durationMs !== null && row.endedAt !== null) expect(row.durationMs).toBe(row.endedAt - row.startedAt);
    }
    expect(JSON.parse(JSON.stringify(rows))).toEqual(rows);
  });

  it('the fixtures exercise every count (so equal tallies are not all zeros)', () => {
    const rows = fixtures.flatMap((name) => agentRunRows(fixtureEvents(name)));
    const total = (pick: (r: (typeof rows)[number]) => number): number => rows.reduce((s, r) => s + pick(r), 0);
    expect(total((r) => r.toolCalls)).toBeGreaterThan(100);
    expect(total((r) => r.toolFailures)).toBeGreaterThan(0);
    expect(total((r) => r.approvals.requested)).toBeGreaterThan(0);
    // Recorded fixtures hold Claude Code's PermissionRequests but no approval.resolved (that is the Huddle broker's
    // event), so every recorded approval is unresolved; who answered is covered by the hand-made session below.
    expect(total((r) => r.approvals.unresolved)).toBe(total((r) => r.approvals.requested));
    expect(total((r) => r.tasksCompleted)).toBeGreaterThan(0);
    expect(rows.filter((r) => r.tokens !== null).length).toBeGreaterThan(50);
    expect(rows.filter((r) => r.kind === 'subagent').length).toBeGreaterThan(50);
  });

  it.each(listRunFixtures().map((r) => r.file))(
    '%s: every agent has a model; a subagent has its Agent call resolved model',
    (name) => {
      const events = fixtureEvents(name);
      for (const row of agentRunRows(events)) {
        expect(row.model, row.agentKey).not.toBeNull();
        if (row.kind === 'main') {
          const telemetry = events.filter(
            (e) => e.type === 'model.observed' && e.agentKey === row.agentKey && e.via === 'telemetry',
          );
          expect(telemetry.length).toBeGreaterThan(0);
          continue;
        }
        const resolved = events.flatMap((e) =>
          e.type === 'model.observed' && e.agentKey === row.agentKey && e.via === 'agent_call' ? [e.model] : [],
        );
        if (resolved.length > 0) expect(row.model).toBe(resolved[resolved.length - 1]);
      }
    },
  );

  it.each(listRunFixtures().map((r) => r.file))('%s: headless runs end, so every agent has an outcome', (name) => {
    for (const row of agentRunRows(fixtureEvents(name))) {
      expect(row.outcome, row.agentKey).not.toBe('unknown');
      expect(row.durationMs, row.agentKey).not.toBeNull();
    }
  });
});

describe('agentRunRows on hand-made events', () => {
  it('reads approvals, stuck episodes, deduplicated tokens and the outcome', () => {
    const rows = agentRunRows(sampleSession());
    const sub = rows.find((r) => r.agentKey === SUB);
    const main = rows.find((r) => r.agentKey === MAIN);
    expect(sub).toMatchObject({
      role: 'core-engineer',
      model: 'claude-sonnet-5-5',
      parentKey: MAIN,
      outcome: 'completed',
      toolCalls: 3,
      toolFailures: 2,
      approvals: { requested: 1, byUser: 1, byPolicy: 0, other: 0, unresolved: 0 },
      stuckIncidents: 2,
      tokens: { input: 100, output: 50, cacheRead: 1000, cacheCreation: 10, requests: 1 },
      estimatedCostUsd: 0.01,
    });
    // The helper request is not the main agent's own usage.
    expect(main?.tokens).toEqual({ input: 2000, output: 300, cacheRead: 5000, cacheCreation: 0, requests: 1 });
    expect(main?.outcome).toBe('completed');
  });

  it('keeps unknown tokens and cost as null, and a still-running agent as unknown', () => {
    const ev = builder();
    const rows = agentRunRows([
      ev('session.started', 's', { origin: 'attached', cwd: null, title: null, model: null, startKind: 'startup' }),
      ev('agent.started', 's::a', { agentId: 'a', role: 'Explore', parentKey: 's' }),
    ]);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.tokens).toBeNull();
      expect(row.estimatedCostUsd).toBeNull();
      expect(row.outcome).toBe('unknown');
      expect(row.endedAt).toBeNull();
      expect(row.durationMs).toBeNull();
      expect(row.model).toBeNull();
    }
  });

  it('marks a failed last turn failed even after SubagentStop, and a new turn clears it', () => {
    const ev = builder();
    const base = [
      ev('session.started', 's', { origin: 'attached', cwd: null, title: null, model: null, startKind: 'startup' }),
      ev('agent.started', 's::a', { agentId: 'a', role: 'Explore', parentKey: 's' }),
      ev('turn.failed', 's::a', { error: 'rate limited' }),
      ev('agent.stopped', 's::a', { agentId: 'a', result: null }),
    ];
    expect(agentRunRows(base).find((r) => r.agentKey === 's::a')?.outcome).toBe('failed');
    const again = [
      ...base,
      ev('agent.started', 's::a', { agentId: 'a', role: 'Explore', parentKey: 's' }),
      ev('agent.stopped', 's::a', { agentId: 'a', result: null }),
    ];
    expect(agentRunRows(again).find((r) => r.agentKey === 's::a')?.outcome).toBe('completed');
  });

  it('uses run.exited for a managed root, even when SessionEnd came first', () => {
    const ev = builder();
    const rows = agentRunRows([
      ev(
        'run.launched',
        'run-1',
        {
          runId: 'run-1',
          claudeSessionId: 's',
          templateId: null,
          cwd: 'C:/p',
          model: 'sonnet',
          permissionMode: 'default',
          mainAgent: null,
          agentNames: [],
          worktree: null,
        },
        { source: 'huddle' },
      ),
      ev('session.started', 's', { origin: 'attached', cwd: 'C:/p', title: null, model: null, startKind: 'startup' }),
      ev('session.ended', 's', { reason: 'other' }),
      ev('run.exited', 'run-1', { runId: 'run-1', exitCode: null, how: 'stopped', error: null }, { source: 'huddle' }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe('stopped');
  });

  it('files rows under their own session when given several', () => {
    const ev = builder();
    const events = [
      ev('session.started', 'x', { origin: 'attached', cwd: null, title: null, model: null, startKind: 'startup' }),
      ev('session.started', 'y', { origin: 'attached', cwd: null, title: null, model: null, startKind: 'startup' }),
    ];
    expect(agentRunRows(events).map((r) => r.sessionId)).toEqual(['x', 'y']);
    expect(agentRunRows(events, 'y').map((r) => r.sessionId)).toEqual(['y']);
  });
});

describe('scorecardRows (M5 runbook: empty sessions out of the scorecards)', () => {
  it('leaves out every row of a session with no main agent (a telemetry-only fragment)', () => {
    const fragment = fragmentSession('frag', 1_800_000_100_000);
    // The reducer makes no main agent from telemetry alone; whatever rows there are, none is a run.
    expect(agentRunRows(fragment).some((r) => r.kind === 'main')).toBe(false);
    expect(scorecardRows(agentRunRows(fragment), fragment)).toEqual([]);
    // A hand-made row in that session (as an older derivation could have stored) is left out too.
    const stray = { ...(agentRunRows(sampleSession())[1] as AgentRunRow), sessionId: 'frag' };
    expect(scorecardRows([stray], fragment)).toEqual([]);
  });

  it('leaves out a root that did nothing: no tool call, no task, no prompt, no turn', () => {
    const idle = idleSession('idle', 1_800_000_100_000, 0);
    const rows = agentRunRows(idle);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'main', role: 'main', model: null, durationMs: 0, outcome: 'completed' });
    expect(scorecardRows(rows, idle)).toEqual([]);
    // Three of them would have made a "main / model unknown, 0 ms, n=3" card.
    const three = ['i1', 'i2', 'i3'].flatMap((id) => idleSession(id, 1_800_000_100_000));
    expect(computeScorecards(agentRunRows(three))[0]).toMatchObject({
      role: 'main',
      model: null,
      sampleSize: 3,
      medianTaskMs: 0,
    });
    expect(computeScorecards(scorecardRows(agentRunRows(three), three))).toEqual([]);
  });

  it('keeps a root that only had a prompt and a turn, and keeps subagents when the root did nothing', () => {
    const ev = builder();
    const asked = [
      ev('session.started', 'q', { origin: 'attached', cwd: null, title: null, model: null, startKind: 'startup' }),
      ev('prompt.submitted', 'q', { text: 'hi', promptId: 'p', kind: 'user' }),
      ev('turn.ended', 'q', { lastMessage: 'hello', backgroundAgentIds: [] }),
      ev('session.ended', 'q', { reason: 'other' }),
    ];
    expect(scorecardRows(agentRunRows(asked), asked).map((r) => r.agentKey)).toEqual(['q']);

    // A subagent only: the root has no prompt or turn of its own, its subagent works.
    const quietRoot = [
      ev('session.started', 'r', { origin: 'attached', cwd: null, title: null, model: null, startKind: 'startup' }),
      ev('agent.started', 'r::a', { agentId: 'a', role: 'Explore', parentKey: 'r' }),
      ev('tool.started', 'r::a', { toolUseId: 't', toolName: 'Read', summary: 'x', filePath: null, inputDigest: 'd' }),
      ev('tool.finished', 'r::a', { toolUseId: 't', toolName: 'Read', durationMs: 1 }),
      ev('agent.stopped', 'r::a', { agentId: 'a', result: null }),
    ];
    expect(scorecardRows(agentRunRows(quietRoot), quietRoot).map((r) => r.agentKey)).toEqual(['r::a']);
  });

  it('keeps every row of the sample session and of every recorded run', () => {
    const sample = sampleSession();
    expect(scorecardRows(agentRunRows(sample), sample)).toEqual(agentRunRows(sample));
    for (const run of listRunFixtures()) {
      const events = fixtureEvents(run.file);
      const rows = agentRunRows(events);
      expect(scorecardRows(rows, events), run.id).toEqual(rows);
    }
  });
});
