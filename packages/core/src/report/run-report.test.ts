/**
 * End-of-run report (F23): totals and lists must equal tallies made here from the raw events of each recorded fixture;
 * a hand-made session covers files, failures, approvals, the worktree and the no-tool-input rule.
 */
import { describe, expect, it } from 'vitest';
import { CLIP_LIMITS, type HuddleEvent } from '@huddle/shared';
import { listFixtureFiles } from '../test/fixtures.js';
import { fixtureEvents } from '../test/replay-fixture.js';
import { listRunFixtures } from '../test/run-fixtures.js';
import { builder, HOSTILE, INPUT_SENTINEL, MAIN, S, sampleSession, SUB } from '../test/report-events.js';
import { buildRunReport, sessionEvents } from './run-report.js';

const fixtures = [...listFixtureFiles(), ...listRunFixtures().map((r) => r.file)];

function sessionsOf(events: readonly HuddleEvent[]): string[] {
  return [...new Set(events.map((e) => e.sessionId))];
}

describe('buildRunReport over recorded fixtures', () => {
  it.each(fixtures)('%s: totals equal a tally of the raw events', (name) => {
    const all = fixtureEvents(name);
    for (const sessionId of sessionsOf(all)) {
      const events = all.filter((e) => e.sessionId === sessionId);
      const report = buildRunReport(all, sessionId);
      expect(report, sessionId).not.toBeNull();
      if (report === null) continue;
      const keys = new Set(report.agents.map((a) => a.row.agentKey));
      const mine = events.filter((e) => keys.has(e.agentKey));

      const toolStarts = mine.filter((e) => e.type === 'tool.started');
      const toolFails = mine.filter((e) => e.type === 'tool.failed');
      const turnFails = mine.filter((e) => e.type === 'turn.failed');
      const approvals = new Set(
        mine.flatMap((e) =>
          e.type === 'approval.requested' && e.request.toolName !== 'AskUserQuestion' ? [e.request.requestId] : [],
        ),
      );
      expect(report.summary.toolCalls).toBe(toolStarts.length);
      expect(report.summary.toolFailures).toBe(toolFails.length);
      expect(report.failures).toHaveLength(toolFails.length + turnFails.length);
      expect(report.approvals.map((a) => a.requestId)).toEqual([...approvals]);
      expect(report.summary.approvalsRequested).toBe(approvals.size);

      // Tool calls by name per agent add up to the agent's row.
      for (const agent of report.agents) {
        const byName = new Map<string, number>();
        for (const e of toolStarts) {
          if (e.agentKey === agent.row.agentKey) byName.set(e.toolName, (byName.get(e.toolName) ?? 0) + 1);
        }
        expect(Object.fromEntries(agent.tools.map((t) => [t.toolName, t.calls]))).toEqual(Object.fromEntries(byName));
      }

      // Session tokens = every agent's own requests + helper requests, each request id once.
      const seen = new Set<string>();
      let input = 0;
      let output = 0;
      let requests = 0;
      for (const e of events) {
        if (e.type !== 'usage.recorded') continue;
        if (e.requestId !== null) {
          if (seen.has(e.requestId)) continue;
          seen.add(e.requestId);
        }
        input += e.inputTokens;
        output += e.outputTokens;
        requests += 1;
      }
      const s = report.summary;
      if (requests === 0) {
        expect(s.tokens).toBeNull();
        expect(s.helperTokens).toBeNull();
        expect(s.estimatedCostUsd).toBeNull();
      } else {
        expect((s.tokens?.input ?? 0) + (s.helperTokens?.input ?? 0)).toBe(input);
        expect((s.tokens?.output ?? 0) + (s.helperTokens?.output ?? 0)).toBe(output);
        expect((s.tokens?.requests ?? 0) + (s.helperTokens?.requests ?? 0)).toBe(requests);
      }

      // Files written: successful Write/Edit/MultiEdit/NotebookEdit calls, by path.
      const finished = new Set(
        mine.flatMap((e) => (e.type === 'tool.finished' && e.toolUseId !== null ? [e.toolUseId] : [])),
      );
      const written = new Set(
        mine.flatMap((e) =>
          e.type === 'tool.started' &&
          ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(e.toolName) &&
          e.filePath !== null &&
          e.toolUseId !== null &&
          finished.has(e.toolUseId)
            ? [e.filePath]
            : [],
        ),
      );
      expect(
        report.filesChanged
          .filter((f) => f.source === 'tool')
          .map((f) => f.path)
          .sort(),
      ).toEqual([...written].sort());
      expect(JSON.parse(JSON.stringify(report))).toEqual(report);
    }
  });
});

describe('report rows carry their log index (M5 WP7)', () => {
  const FAILURE_TYPE = { tool: 'tool.failed', turn: 'turn.failed', run: 'run.exited' } as const;

  it.each(fixtures)('%s: each failure and approval row points at its event in the session log', (name) => {
    const all = fixtureEvents(name);
    for (const sessionId of sessionsOf(all)) {
      // The session's stored log: its rows are its events, in order (what the replay index counts).
      const log = all.filter((e) => e.sessionId === sessionId);
      const report = buildRunReport(all, sessionId);
      if (report === null) continue;
      for (const f of report.failures) {
        if (f.kind === 'run' && f.index === null) continue;
        expect(f.index, `${sessionId} ${f.kind} failure`).not.toBeNull();
        const e = log[f.index ?? -1];
        expect(e?.type).toBe(FAILURE_TYPE[f.kind]);
        expect(e?.ts).toBe(f.ts);
        if (f.kind !== 'run') expect(e?.agentKey).toBe(f.agentKey);
      }
      for (const a of report.approvals) {
        const e = log[a.index ?? -1];
        expect(e?.type, `${sessionId} approval ${a.requestId}`).toBe('approval.requested');
        expect(e?.agentKey).toBe(a.agentKey);
        expect(e?.type === 'approval.requested' ? e.request.requestId : null).toBe(a.requestId);
      }
    }
  });

  it('the fixtures hold rows of both kinds, so the check above is not empty', () => {
    let failures = 0;
    let approvals = 0;
    for (const name of fixtures) {
      const all = fixtureEvents(name);
      for (const sessionId of sessionsOf(all)) {
        const report = buildRunReport(all, sessionId);
        failures += report?.failures.filter((f) => f.index !== null).length ?? 0;
        approvals += report?.approvals.length ?? 0;
      }
    }
    expect(failures).toBeGreaterThan(0);
    expect(approvals).toBeGreaterThan(0);
  });

  it('the hand-made session: indexes in its own log, a run event filed under another session has none', () => {
    const events = sampleSession();
    const report = buildRunReport(events, S);
    const log = events.filter((e) => e.sessionId === S);
    expect(report?.failures.length).toBeGreaterThan(0);
    expect(report?.approvals.length).toBeGreaterThan(0);
    for (const row of [...(report?.failures ?? []), ...(report?.approvals ?? [])]) {
      expect(log[row.index ?? -1]?.ts).toBe(row.ts);
    }
  });
});

describe('buildRunReport on a hand-made session', () => {
  const report = buildRunReport(sampleSession(), S);

  it('summarizes the session', () => {
    expect(report?.summary).toMatchObject({
      title: HOSTILE.title,
      cwd: 'C:/p',
      model: 'claude-opus-5-5',
      origin: 'attached',
      outcome: 'completed',
      endReason: 'prompt_input_exit',
      agents: 2,
      toolCalls: 4,
      toolFailures: 2,
      approvalsRequested: 1,
      stuckIncidents: 2,
      tokens: { input: 2100, output: 350, cacheRead: 6000, cacheCreation: 10, requests: 2 },
      tokensPartial: false,
      helperTokens: { input: 40, output: 8, cacheRead: 0, cacheCreation: 0, requests: 1 },
    });
    expect(report?.summary.estimatedCostUsd).toBeCloseTo(0.211, 6);
    expect(report?.summary.durationMs).toBe((report?.summary.endedAt ?? 0) - (report?.summary.startedAt ?? 0));
  });

  it('lists what each agent did', () => {
    const sub = report?.agents.find((a) => a.row.agentKey === SUB);
    expect(sub?.title).toBe(HOSTILE.handoffTitle);
    expect(sub?.result).toBe(HOSTILE.result);
    expect(sub?.fileWrites).toBe(1);
    expect(sub?.tools).toEqual([
      { toolName: 'Bash', calls: 1, failures: 1 },
      { toolName: 'Edit', calls: 1, failures: 0 },
      { toolName: 'Write', calls: 1, failures: 1 },
    ]);
    expect(report?.agents.map((a) => a.row.agentKey)).toEqual([MAIN, SUB]);
  });

  it('lists only files whose write finished, with paths and no contents', () => {
    expect(report?.filesChanged).toEqual([
      { path: HOSTILE.path, source: 'tool', agentKeys: [SUB], tools: ['Edit'], writes: 1, worktreeStatus: null },
    ]);
  });

  it('lists failures and approvals with who answered', () => {
    expect(report?.failures.map((f) => [f.kind, f.toolName, f.error])).toEqual([
      ['tool', 'Bash', HOSTILE.error],
      ['tool', 'Write', 'denied'],
    ]);
    expect(report?.approvals).toEqual([
      expect.objectContaining({ requestId: 'r1', agentKey: SUB, toolName: 'Bash', outcome: 'allowed', by: 'user' }),
    ]);
  });

  it('never carries a tool input', () => {
    expect(JSON.stringify(report)).not.toContain(INPUT_SENTINEL);
  });

  it('is null for a session the events do not hold', () => {
    expect(buildRunReport(sampleSession(), 'other-session')).toBeNull();
  });

  it('clips free text again, whatever the log holds', () => {
    const ev = builder();
    const long = 'x'.repeat(10_000);
    const r = buildRunReport(
      [
        ev('session.started', 's', { origin: 'attached', cwd: long, title: long, model: null, startKind: 'startup' }),
        ev('tool.started', 's', { toolUseId: 't', toolName: 'Bash', summary: 'x', filePath: null, inputDigest: 'd' }),
        ev('tool.failed', 's', { toolUseId: 't', toolName: 'Bash', error: long, interrupted: false }),
      ],
      's',
    );
    expect(r?.summary.title?.length).toBe(CLIP_LIMITS.summary);
    expect(r?.summary.cwd?.length).toBe(CLIP_LIMITS.path);
    expect(r?.failures[0]?.error?.length).toBe(CLIP_LIMITS.error);
  });
});

describe('managed runs', () => {
  const ev = builder();
  const RUN = 'run-7';
  const events: HuddleEvent[] = [
    // The worktree is made before the session id is known: filed under the runId placeholder.
    ev(
      'worktree.created',
      RUN,
      { runId: RUN, path: 'C:/wt/run-7', branch: 'huddle/run-7', baseCommit: 'abc', repoRoot: 'C:/p' },
      { source: 'huddle' },
    ),
    ev(
      'run.launched',
      RUN,
      {
        runId: RUN,
        claudeSessionId: 'sm',
        templateId: null,
        cwd: 'C:/wt/run-7',
        model: 'sonnet',
        permissionMode: 'default',
        mainAgent: null,
        agentNames: [],
        worktree: { path: 'C:/wt/run-7', branch: 'huddle/run-7' },
      },
      { source: 'huddle' },
    ),
    ev('session.started', 'sm', {
      origin: 'attached',
      cwd: 'C:/wt/run-7',
      title: null,
      model: null,
      startKind: 'startup',
    }),
    ev('run.exited', RUN, { runId: RUN, exitCode: 1, how: 'failed', error: 'exit 1' }, { source: 'huddle' }),
    ev(
      'worktree.summarized',
      RUN,
      {
        runId: RUN,
        filesChanged: 2,
        insertions: 5,
        deletions: 1,
        untracked: 1,
        files: [
          { path: 'src/b.ts', status: 'modified' },
          { path: 'src/a.ts', status: 'untracked' },
        ],
      },
      { source: 'huddle' },
    ),
    ev('worktree.closed', RUN, { runId: RUN, outcome: 'kept', error: null }, { source: 'huddle' }),
    // Another run's events must stay out.
    ev('worktree.created', 'run-8', {
      runId: 'run-8',
      path: 'C:/wt/8',
      branch: 'b8',
      baseCommit: 'x',
      repoRoot: 'C:/p',
    }),
  ];

  it('takes the run and worktree events filed under the runId', () => {
    expect(sessionEvents(events, 'sm').map((e) => e.type)).toEqual([
      'worktree.created',
      'run.launched',
      'session.started',
      'run.exited',
      'worktree.summarized',
      'worktree.closed',
    ]);
  });

  it('reports the run outcome, its failure and the worktree files', () => {
    const r = buildRunReport(events, 'sm');
    expect(r?.summary.origin).toBe('managed');
    expect(r?.summary.outcome).toBe('failed');
    // The run.exited is filed under the runId, not in session sm's own log: no replay index.
    expect(r?.failures).toEqual([expect.objectContaining({ kind: 'run', error: 'exit 1', index: null })]);
    expect(r?.worktree).toEqual({
      path: 'C:/wt/run-7',
      branch: 'huddle/run-7',
      filesChanged: 2,
      insertions: 5,
      deletions: 1,
      untracked: 1,
      listed: 2,
      closed: 'kept',
    });
    expect(r?.filesChanged.map((f) => [f.source, f.path, f.worktreeStatus])).toEqual([
      ['worktree', 'src/a.ts', 'untracked'],
      ['worktree', 'src/b.ts', 'modified'],
    ]);
  });
});
