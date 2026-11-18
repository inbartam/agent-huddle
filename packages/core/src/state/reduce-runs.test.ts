/**
 * Reducer tests for M4 (WP1, ADR-020): managed runs, worktrees, budgets, and the two origin fixes (a managed root stays
 * managed when its own SessionStart hook says attached; managed subagents are messaged through the outbox).
 */
import { describe, expect, it } from 'vitest';
import { agentKey, type AgentNode, type EventOfType, type HuddleEvent } from '@huddle/shared';
import { listFixtureFiles } from '../test/fixtures.js';
import { fixtureEvents } from '../test/replay-fixture.js';
import {
  ATTACHED_CAPABILITIES,
  capabilitiesFor,
  initialState,
  MANAGED_CAPABILITIES,
  MANAGED_SUBAGENT_CAPABILITIES,
  reduce,
  replay,
  toHuddleState,
  type ReducerState,
} from './reduce.js';

const S = 'session-m';
const MAIN = agentKey(S);
const SUB = agentKey(S, 'a1');
const RUN = 'run-0001';

type Fields<T extends HuddleEvent['type']> = Omit<
  EventOfType<T>,
  'id' | 'type' | 'ts' | 'sessionId' | 'agentKey' | 'source'
>;

/** Hand-made events with increasing ts. `at` files an event under another session (the runId placeholder). */
function builder(start = 1000) {
  let n = 0;
  return function ev<T extends HuddleEvent['type']>(
    type: T,
    key: string,
    fields: Fields<T>,
    at: { sessionId?: string; source?: HuddleEvent['source'] } = {},
  ): HuddleEvent {
    n += 1;
    const sessionId = at.sessionId ?? key.split('::')[0] ?? key;
    return {
      id: `e${String(n).padStart(3, '0')}`,
      type,
      ts: start + n * 10,
      sessionId,
      agentKey: key,
      source: at.source ?? 'huddle',
      ...fields,
    } as unknown as HuddleEvent;
  };
}

function launched(overrides: Partial<Fields<'run.launched'>> = {}): Fields<'run.launched'> {
  return {
    runId: RUN,
    claudeSessionId: S,
    templateId: 'tpl-1',
    cwd: 'C:/projects/app',
    model: 'sonnet',
    permissionMode: 'default',
    mainAgent: null,
    agentNames: ['reviewer'],
    worktree: null,
    ...overrides,
  };
}

function node(state: ReducerState, key: string): AgentNode {
  const found = state.agents[key];
  if (found === undefined) throw new Error(`no node ${key}`);
  return found;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

/** A managed run's hooks: SessionStart (says attached), a prompt, a subagent. */
function hookSession(ev: ReturnType<typeof builder>): HuddleEvent[] {
  return [
    ev(
      'session.started',
      MAIN,
      { origin: 'attached', cwd: 'C:/projects/app', title: null, model: null, startKind: 'startup' },
      { source: 'hook' },
    ),
    ev('prompt.submitted', MAIN, { text: 'go', promptId: null }, { source: 'hook' }),
    ev('agent.started', SUB, { agentId: 'a1', role: 'Explore', parentKey: MAIN }, { source: 'hook' }),
  ];
}

describe('run.launched', () => {
  it('creates the root as managed and shows the run on it', () => {
    const ev = builder();
    const state = replay([ev('run.launched', MAIN, launched())]);
    const root = node(state, MAIN);
    expect(root.origin).toBe('managed');
    expect(root.capabilities).toEqual(capabilitiesFor('managed', 'main'));
    expect(root.capabilities.message).toBe('live');
    expect(root.cwd).toBe('C:/projects/app');
    expect(root.model).toBe('sonnet');
    expect(root.status).toBe('starting');
    expect(root.run).toEqual({
      runId: RUN,
      templateId: 'tpl-1',
      permissionMode: 'default',
      mainAgent: null,
      agentNames: ['reviewer'],
      worktree: null,
      exited: null,
      result: null,
    });
    expect(state.rootKeys).toEqual([MAIN]);
  });

  it('keeps a permission mode this build does not know', () => {
    const ev = builder();
    const state = replay([ev('run.launched', MAIN, launched({ permissionMode: 'futureMode' }))]);
    expect(node(state, MAIN).run?.permissionMode).toBe('futureMode');
  });

  it('the session model outranks the requested one', () => {
    const ev = builder();
    const state = replay([
      ev('run.launched', MAIN, launched()),
      ev('model.observed', MAIN, { model: 'claude-sonnet-4-5', via: 'session_start' }, { source: 'hook' }),
    ]);
    expect(node(state, MAIN).model).toBe('claude-sonnet-4-5');
  });

  it('without a session: kept by runId, no node in the tree; a later run.launched with the session links it', () => {
    const ev = builder();
    let state = replay([ev('run.launched', RUN, launched({ claudeSessionId: null }), { sessionId: RUN })]);
    expect(state.agents).toEqual({});
    expect(state.rootKeys).toEqual([]);
    expect(state.book.runs?.[RUN]?.sessionId).toBeNull();

    state = reduce(state, ev('run.launched', MAIN, launched()));
    expect(node(state, MAIN).run?.runId).toBe(RUN);
    expect(node(state, MAIN).origin).toBe('managed');
  });

  it('the first session named wins', () => {
    const ev = builder();
    const state = replay([
      ev('run.launched', MAIN, launched()),
      ev('run.launched', 'other', launched({ claudeSessionId: 'other' })),
    ]);
    expect(state.agents.other).toBeUndefined();
    expect(state.book.runs?.[RUN]?.sessionId).toBe(S);
  });

  it('turns an attached root and its subagents managed (attached -> managed may switch)', () => {
    const ev = builder();
    let state = replay(hookSession(ev));
    expect(node(state, MAIN).origin).toBe('attached');
    expect(node(state, SUB).capabilities).toEqual(capabilitiesFor('attached', 'subagent'));

    state = reduce(state, ev('run.launched', MAIN, launched()));
    expect(node(state, MAIN).origin).toBe('managed');
    expect(node(state, MAIN).capabilities).toEqual(capabilitiesFor('managed', 'main'));
    expect(node(state, SUB).origin).toBe('managed');
    expect(node(state, SUB).capabilities).toEqual(MANAGED_SUBAGENT_CAPABILITIES);
  });
});

describe('origin fixes (ADR-020)', () => {
  it('a managed root stays managed when its SessionStart hook says attached', () => {
    const ev = builder();
    const state = replay([ev('run.launched', MAIN, launched()), ...hookSession(ev)]);
    expect(node(state, MAIN).origin).toBe('managed');
    expect(node(state, MAIN).capabilities).toEqual(capabilitiesFor('managed', 'main'));
    expect(node(state, MAIN).run?.runId).toBe(RUN);
    // A subagent takes its parent's origin.
    expect(node(state, SUB).origin).toBe('managed');
  });

  it('an attached root still turns managed on session.started{managed}', () => {
    const ev = builder();
    const state = replay([
      ...hookSession(ev),
      ev('session.started', MAIN, { origin: 'managed', cwd: null, title: null, model: null, startKind: 'resume' }),
    ]);
    expect(node(state, MAIN).origin).toBe('managed');
  });

  it('managed subagents are messaged through the outbox: stdin reaches the main agent only', () => {
    expect(capabilitiesFor('managed', 'subagent')).toEqual(MANAGED_SUBAGENT_CAPABILITIES);
    expect(MANAGED_SUBAGENT_CAPABILITIES).toEqual({
      approve: true,
      answerQuestions: false,
      message: 'queued',
      pause: true,
      stop: false,
      setModel: false,
      followUp: false,
    });
    expect(capabilitiesFor('managed', 'teammate')).toEqual(MANAGED_SUBAGENT_CAPABILITIES);
    expect(capabilitiesFor('managed', 'main')).toEqual(MANAGED_CAPABILITIES);
    // Attached is unchanged.
    expect(capabilitiesFor('attached', 'main')).toEqual(ATTACHED_CAPABILITIES);
    expect(capabilitiesFor('attached', 'subagent')).toEqual({ ...ATTACHED_CAPABILITIES, followUp: false });
  });
});

describe('run.exited', () => {
  it.each([
    ['completed', 'done'],
    ['failed', 'failed'],
    ['spawn_failed', 'failed'],
    ['stopped', 'stopped'],
  ] as const)('%s ends the root as %s and stops what still runs', (how, status) => {
    const ev = builder();
    let state = replay([ev('run.launched', MAIN, launched()), ...hookSession(ev)]);
    state = reduce(
      state,
      ev('message.queued', SUB, { messageId: 'm1', text: 'hi', delivery: 'next_tool' }, { source: 'user' }),
    );
    const exit = ev('run.exited', MAIN, { runId: RUN, exitCode: how === 'completed' ? 0 : 1, how, error: null });
    state = reduce(state, exit);
    expect(node(state, MAIN).status).toBe(status);
    expect(node(state, MAIN).endedAt).toBe(exit.ts);
    expect(node(state, SUB).status).toBe('stopped');
    expect(node(state, SUB).outbox).toEqual([]);
    expect(node(state, MAIN).run?.exited).toEqual({
      at: exit.ts,
      exitCode: how === 'completed' ? 0 : 1,
      how,
      error: null,
    });
  });

  it('a root that already ended keeps its status', () => {
    const ev = builder();
    let state = replay([ev('run.launched', MAIN, launched()), ...hookSession(ev)]);
    state = reduce(state, ev('session.ended', MAIN, { reason: 'other' }, { source: 'hook' }));
    const endedAt = node(state, MAIN).endedAt;
    state = reduce(state, ev('run.exited', MAIN, { runId: RUN, exitCode: 1, how: 'failed', error: 'x' }));
    expect(node(state, MAIN).status).toBe('done');
    expect(node(state, MAIN).endedAt).toBe(endedAt);
    expect(node(state, MAIN).run?.exited?.how).toBe('failed');
  });

  it('before the session is known it is kept, and ends the root once run.launched names the session', () => {
    const ev = builder();
    let state = replay([
      ev('run.launched', RUN, launched({ claudeSessionId: null }), { sessionId: RUN }),
      ev('run.exited', RUN, { runId: RUN, exitCode: null, how: 'spawn_failed', error: 'ENOENT' }, { sessionId: RUN }),
    ]);
    expect(state.agents).toEqual({});
    expect(state.book.runs?.[RUN]?.run.exited?.how).toBe('spawn_failed');

    state = reduce(state, ev('run.launched', MAIN, launched()));
    expect(node(state, MAIN).status).toBe('failed');
    expect(node(state, MAIN).run?.exited?.error).toBe('ENOENT');
  });
});

describe('run.result', () => {
  it('records the latest turn result without changing status', () => {
    const ev = builder();
    let state = replay([ev('run.launched', MAIN, launched()), ...hookSession(ev)]);
    const before = node(state, MAIN).status;
    const fields = {
      runId: RUN,
      isError: false,
      durationMs: 1200,
      numTurns: 3,
      totalCostUsd: 0.05,
      permissionDenials: 1,
    };
    const result = ev('run.result', MAIN, fields, { source: 'stream' });
    state = reduce(state, result);
    expect(node(state, MAIN).status).toBe(before);
    expect(node(state, MAIN).run?.result).toEqual({
      at: result.ts,
      isError: false,
      durationMs: 1200,
      numTurns: 3,
      totalCostUsd: 0.05,
      permissionDenials: 1,
    });
  });
});

describe('worktrees', () => {
  const created = {
    runId: RUN,
    path: 'C:/wt/run-0001',
    branch: 'huddle/run-0001',
    baseCommit: 'abc123',
    repoRoot: 'C:/projects/app',
  };

  it('worktree.created before the launch (under the runId placeholder) shows on the root once launched', () => {
    const ev = builder();
    let state = replay([ev('worktree.created', RUN, created, { sessionId: RUN })]);
    expect(state.agents).toEqual({});

    state = reduce(
      state,
      ev('run.launched', MAIN, launched({ worktree: { path: created.path, branch: created.branch } })),
    );
    expect(node(state, MAIN).run?.worktree).toEqual({
      path: 'C:/wt/run-0001',
      branch: 'huddle/run-0001',
      state: 'active',
      baseCommit: 'abc123',
      repoRoot: 'C:/projects/app',
    });
    expect(state.agents[RUN]).toBeUndefined();
  });

  it('run.launched alone gives an active worktree with path and branch', () => {
    const ev = builder();
    const state = replay([ev('run.launched', MAIN, launched({ worktree: { path: 'C:/wt/x', branch: 'huddle/x' } }))]);
    expect(node(state, MAIN).run?.worktree).toEqual({ path: 'C:/wt/x', branch: 'huddle/x', state: 'active' });
  });

  it('summarized, then kept or discarded', () => {
    const ev = builder();
    let state = replay([
      ev('worktree.created', RUN, created, { sessionId: RUN }),
      ev('run.launched', MAIN, launched()),
    ]);
    const summary = ev('worktree.summarized', MAIN, {
      runId: RUN,
      filesChanged: 1,
      insertions: 4,
      deletions: 0,
      untracked: 0,
      files: [{ path: 'src/a.ts', status: 'added' }],
    });
    state = reduce(state, summary);
    expect(node(state, MAIN).run?.worktree?.summary).toEqual({
      filesChanged: 1,
      insertions: 4,
      deletions: 0,
      untracked: 0,
      files: [{ path: 'src/a.ts', status: 'added' }],
      summarizedAt: summary.ts,
    });

    const kept = reduce(
      state,
      ev('worktree.closed', MAIN, { runId: RUN, outcome: 'kept', error: null }, { source: 'user' }),
    );
    expect(node(kept, MAIN).run?.worktree?.state).toBe('kept');
    expect(node(kept, MAIN).run?.worktree?.closeError).toBeNull();

    const discarded = reduce(
      state,
      ev('worktree.closed', MAIN, { runId: RUN, outcome: 'discarded', error: 'branch left' }, { source: 'user' }),
    );
    expect(node(discarded, MAIN).run?.worktree).toMatchObject({ state: 'discarded', closeError: 'branch left' });
  });

  it('a summary or close for an unknown run, or a run without a worktree, changes nothing', () => {
    const ev = builder();
    const state = replay([ev('run.launched', MAIN, launched())]);
    const closeUnknown = ev('worktree.closed', MAIN, { runId: 'nope', outcome: 'kept', error: null });
    expect(reduce(state, closeUnknown).agents).toBe(state.agents);
    const closeNoWorktree = ev('worktree.closed', MAIN, { runId: RUN, outcome: 'kept', error: null });
    expect(reduce(state, closeNoWorktree).agents).toBe(state.agents);
  });
});

describe('budget.set', () => {
  const budget = { scope: 'session' as const, maxTokens: 100_000, warnAtFraction: 0.8, onExceed: 'pause' as const };

  it('keeps one budget per scope and target; the latest wins; no limit clears it', () => {
    const ev = builder();
    const first = ev('budget.set', MAIN, { scope: 'session', targetKey: MAIN, budget }, { source: 'user' });
    let state = replay([first]);
    expect(state.budgets).toEqual([{ scope: 'session', targetKey: MAIN, budget, setAt: first.ts }]);
    // A budget never creates a node.
    expect(state.agents).toEqual({});

    const second = ev('budget.set', MAIN, { scope: 'session', targetKey: MAIN, budget: { ...budget, maxTokens: 5 } });
    state = reduce(state, second);
    expect(state.budgets).toHaveLength(1);
    expect(state.budgets?.[0]?.budget.maxTokens).toBe(5);

    const overall = { scope: 'all' as const, maxEstimatedCostUsd: 2, warnAtFraction: 0.5, onExceed: 'notify' as const };
    state = reduce(state, ev('budget.set', MAIN, { scope: 'overall', targetKey: 'ignored', budget: overall }));
    expect(state.budgets?.map((b) => [b.scope, b.targetKey])).toEqual([
      ['session', MAIN],
      ['overall', null],
    ]);

    const clear = { scope: 'session' as const, warnAtFraction: 0.8, onExceed: 'pause' as const };
    state = reduce(state, ev('budget.set', MAIN, { scope: 'session', targetKey: MAIN, budget: clear }));
    expect(state.budgets?.map((b) => b.scope)).toEqual(['overall']);
    expect(toHuddleState(state).budgets).toEqual(state.budgets);
  });

  it('an agent or session budget without a target is ignored', () => {
    const ev = builder();
    const state = replay([ev('budget.set', MAIN, { scope: 'agent', targetKey: null, budget })]);
    expect(state.budgets).toBeUndefined();
  });
});

describe('purity and old logs', () => {
  it('replays run events without mutating any input, and survives JSON', () => {
    const ev = builder();
    const events = [
      ev(
        'worktree.created',
        RUN,
        { runId: RUN, path: 'p', branch: 'b', baseCommit: 'c', repoRoot: 'r' },
        { sessionId: RUN },
      ),
      ev('run.launched', MAIN, launched()),
      ...hookSession(ev),
      ev('run.result', MAIN, {
        runId: RUN,
        isError: false,
        durationMs: null,
        numTurns: null,
        totalCostUsd: null,
        permissionDenials: 0,
      }),
      ev('run.exited', MAIN, { runId: RUN, exitCode: 0, how: 'completed', error: null }),
      ev('budget.set', MAIN, {
        scope: 'agent',
        targetKey: SUB,
        budget: { scope: 'agent', maxMinutes: 5, warnAtFraction: 1, onExceed: 'stop' },
      }),
    ];
    let frozen = deepFreeze(initialState());
    for (const event of events) frozen = deepFreeze(reduce(frozen, deepFreeze(structuredClone(event))));
    const plain = replay(events);
    expect(frozen).toEqual(plain);
    expect(JSON.parse(JSON.stringify(plain))).toEqual(plain);
    // The book's runs never cross IPC.
    expect('book' in toHuddleState(plain)).toBe(false);
  });

  it.each(listFixtureFiles())('%s: a log without M4 events has no runs, no budgets, no run on any node', (name) => {
    const state = replay(fixtureEvents(name));
    expect(state.budgets).toBeUndefined();
    expect(state.book.runs).toBeUndefined();
    expect(Object.values(state.agents).every((n) => n.run === undefined)).toBe(true);
    expect(Object.keys(toHuddleState(state)).sort()).toEqual(['agents', 'inbox', 'rateLimits', 'rootKeys']);
  });
});

describe('fixture: a managed run whose hooks say attached', () => {
  /** Everything but what a managed launch is expected to change. */
  function comparable(state: ReducerState): unknown {
    return Object.fromEntries(
      Object.entries(state.agents).map(([key, n]) => {
        const { origin: _o, capabilities: _c, run: _r, startedAt: _s, ...rest } = n;
        return [key, rest];
      }),
    );
  }

  it('parallel-subagents.jsonl after run.launched: same tree, managed root and subagents, run on the root', () => {
    const recorded = fixtureEvents('parallel-subagents.jsonl');
    const first = recorded[0];
    if (first === undefined) throw new Error('empty fixture');
    expect(first).toMatchObject({ type: 'session.started', origin: 'attached' });
    const sessionId = first.sessionId;
    const root = agentKey(sessionId);
    const launch: HuddleEvent = {
      id: 'evt-0000',
      type: 'run.launched',
      ts: first.ts - 500,
      sessionId,
      agentKey: root,
      source: 'huddle',
      ...launched({ claudeSessionId: sessionId, cwd: 'C:/Users/user/project', model: null }),
    };

    const managed = replay([launch, ...recorded]);
    const attached = replay(recorded);

    expect(comparable(managed)).toEqual(comparable(attached));
    expect(managed.rootKeys).toEqual(attached.rootKeys);
    expect(managed.inbox).toEqual(attached.inbox);
    expect(node(managed, root).origin).toBe('managed');
    expect(node(managed, root).capabilities).toEqual(capabilitiesFor('managed', 'main'));
    expect(node(managed, root).run?.runId).toBe(RUN);
    expect(node(managed, root).startedAt).toBe(launch.ts);
    const subagents = Object.values(managed.agents).filter((n) => n.kind === 'subagent');
    expect(subagents).toHaveLength(2);
    for (const sub of subagents) {
      expect(sub.origin).toBe('managed');
      expect(sub.capabilities.message).toBe('queued');
    }

    // The recording ends with SessionEnd, so the root is already done; the process exit after it changes nothing.
    const last = recorded[recorded.length - 1];
    const exited = reduce(managed, {
      id: 'evt-9999',
      type: 'run.exited',
      ts: (last?.ts ?? 0) + 1000,
      sessionId,
      agentKey: root,
      source: 'huddle',
      runId: RUN,
      exitCode: 0,
      how: 'completed',
      error: null,
    });
    expect(node(managed, root).status).toBe('done');
    expect(node(exited, root).status).toBe('done');
    expect(node(exited, root).endedAt).toBe(node(managed, root).endedAt);
    expect(node(exited, root).run?.exited?.how).toBe('completed');
    for (const sub of Object.values(exited.agents).filter((n) => n.kind === 'subagent'))
      expect(sub.status).toBe('done');
  });
});
