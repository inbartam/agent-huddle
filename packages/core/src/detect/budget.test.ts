/**
 * Budget detector (F19): counting, one warning and one exceed item per setting, resolving when the condition clears,
 * the actions (notify, pause, stop; attached fallback; lapse -> stop on managed runs only), and a replay of a recorded
 * run. The state comes from the real reducer; actions are carried out by the real runner with fakes for the broker
 * and `stopRun`, so the events they write are folded back in as they would be live.
 */
import { describe, expect, it } from 'vitest';
import {
  agentKey,
  selectBudgetUsed,
  selectBudgetView,
  type AgentKey,
  type AttentionItem,
  type Budget,
  type BudgetEntry,
  type CommandResult,
  type HuddleEvent,
} from '@huddle/shared';
import { carryOutBudgetAction, type StopRun } from '../runtime/budget-runner.js';
import { initialState, reduce, type ReducerState } from '../state/reduce.js';
import { fixtureEvents } from '../test/replay-fixture.js';
import { listRunFixtures } from '../test/run-fixtures.js';
import { builder, MAIN, MIN, SESSION, SUB, SUB2, T0 } from '../test/detect-events.js';
import {
  budgetOverItemId,
  budgetWarningItemId,
  emptyBudgetState,
  seedBudgetState,
  stepBudget,
  tickBudget,
  tokensText,
  type BudgetAction,
  type BudgetState,
  type BudgetStep,
} from './budget.js';
import type { DetectorEmit } from './common.js';

/** Test doubles: a stop that is never available, and its message. */
const STOP_NOT_AVAILABLE = 'stopping a run is not available in this build yet';
const unsupportedStopRun: StopRun = () =>
  Promise.resolve({ ok: false, code: 'unsupported', message: STOP_NOT_AVAILABLE });

const OTHER = 'sess-b';
const OTHER_MAIN = agentKey(OTHER);
const RUN = 'run-0001';

/** The reducer, the detector and a fake runtime, folded together the way HuddleCore does it. */
class Sim {
  state: ReducerState = initialState();
  budget: BudgetState = emptyBudgetState();
  readonly emitted: DetectorEmit[] = [];
  readonly actions: BudgetAction[] = [];
  readonly pending: BudgetAction[] = [];
  readonly stops: string[] = [];
  readonly paused: { agentKey: AgentKey; detail: string }[] = [];
  readonly written: HuddleEvent[] = [];
  private n = 0;
  stopRun: StopRun = (runId) => {
    this.stops.push(runId);
    return Promise.resolve({ ok: true });
  };
  pauseResult: (key: AgentKey) => CommandResult = () => ({ ok: true });

  constructor(readonly liveSince: number | null = null) {}

  feed(...events: HuddleEvent[]): this {
    for (const e of events) {
      this.state = reduce(this.state, e);
      this.written.push(e);
      this.take(stepBudget(this.budget, this.state, e, this.liveSince));
    }
    return this;
  }

  tick(now: number): this {
    this.take(tickBudget(this.budget, this.state, now, this.liveSince));
    return this;
  }

  /** Carry out every pending action (and any the events it writes cause). */
  async settle(): Promise<this> {
    while (this.pending.length > 0) {
      const action = this.pending.shift() as BudgetAction;
      await carryOutBudgetAction(action, {
        pause: (key, detail) => {
          const result = this.pauseResult(key);
          if (result.ok) {
            this.paused.push({ agentKey: key, detail });
            this.feed(this.control(key, 'pause', detail));
          }
          return result;
        },
        stopRun: this.stopRun,
        accept: (events) => {
          this.feed(...events);
        },
        now: () => this.lastTs(),
        nextId: () => this.id(),
      });
    }
    return this;
  }

  open(): AttentionItem[] {
    return this.state.inbox.filter((i) => i.kind === 'budget' && i.resolvedAt === null);
  }

  /** Every attention event: the detector's own and those the runner wrote (the finished exceed items). */
  private attention(): HuddleEvent[] {
    return this.written.filter((e) => e.type === 'attention.raised' || e.type === 'attention.resolved');
  }

  raised(): string[] {
    return this.attention().flatMap((e) => (e.type === 'attention.raised' ? [e.item.id] : []));
  }

  resolved(): string[] {
    return this.attention().flatMap((e) => (e.type === 'attention.resolved' ? [e.itemId] : []));
  }

  controls(): { action: string; source: string; agentKey: string; detail: string | null }[] {
    return this.written.flatMap((e) =>
      e.type === 'control.applied'
        ? [{ action: e.action, source: e.source, agentKey: e.agentKey, detail: e.detail }]
        : [],
    );
  }

  private take(out: BudgetStep): void {
    this.budget = out.state;
    for (const e of out.emit) {
      this.emitted.push(e);
      this.written.push(e);
      this.state = reduce(this.state, e);
    }
    this.actions.push(...out.actions);
    this.pending.push(...out.actions);
  }

  private control(key: AgentKey, action: 'pause' | 'resume', detail: string | null): HuddleEvent {
    return {
      id: this.id(),
      type: 'control.applied',
      ts: this.lastTs(),
      sessionId: key.split('::')[0] ?? key,
      agentKey: key,
      source: 'huddle',
      action,
      detail,
    };
  }

  private lastTs(): number {
    return this.written.at(-1)?.ts ?? T0;
  }

  private id(): string {
    this.n += 1;
    return `rt${String(this.n)}`;
  }
}

const ev = builder();
let req = 0;

function started(ts = T0, session = SESSION): HuddleEvent {
  return ev(
    'session.started',
    { ts, session },
    { origin: 'attached', cwd: 'C:/p', title: null, model: null, startKind: 'startup' },
  );
}

function sub(ts: number, key = SUB, id = 'sub1'): HuddleEvent {
  return ev('agent.started', { ts, agent: key }, { agentId: id, role: 'Explore', parentKey: MAIN });
}

function usage(
  ts: number,
  agent: AgentKey,
  t: { input?: number; output?: number; cacheRead?: number; cacheCreation?: number },
  opts: { cost?: number | null; kind?: 'main' | 'subagent' | 'helper' } = {},
): HuddleEvent {
  req += 1;
  const cost = opts.cost === undefined ? 0.01 : opts.cost;
  return ev(
    'usage.recorded',
    { ts, agent, session: agent.split('::')[0], source: 'telemetry' },
    {
      model: 'sonnet',
      inputTokens: t.input ?? 0,
      outputTokens: t.output ?? 0,
      cacheReadTokens: t.cacheRead ?? 0,
      cacheCreationTokens: t.cacheCreation ?? 0,
      estimatedCostUsd: cost ?? 0,
      requestId: `req-${String(req)}`,
      querySourceKind: opts.kind ?? (agent.includes('::') ? 'subagent' : 'main'),
      ...(cost === null ? { costMissing: true } : {}),
    },
  );
}

function setBudget(
  ts: number,
  scope: BudgetEntry['scope'],
  targetKey: AgentKey | null,
  budget: Partial<Budget>,
): HuddleEvent {
  return ev(
    'budget.set',
    {
      ts,
      agent: targetKey ?? 'huddle-budgets',
      session: targetKey?.split('::')[0] ?? 'huddle-budgets',
      source: 'user',
    },
    {
      scope,
      targetKey,
      budget: { scope: scope === 'overall' ? 'overall' : scope, warnAtFraction: 0.8, onExceed: 'pause', ...budget },
    },
  );
}

function holdStarted(ts: number, agent: AgentKey, toolUseId: string): HuddleEvent {
  return ev('hold.started', { ts, agent, source: 'huddle' }, { toolUseId, limitAt: ts + 595_000 });
}

function holdEnded(ts: number, agent: AgentKey, toolUseId: string, why: 'hold_limit' | 'resumed'): HuddleEvent {
  return ev('hold.ended', { ts, agent, source: 'huddle' }, { toolUseId, why });
}

function launched(ts: number): HuddleEvent {
  return ev(
    'run.launched',
    { ts, agent: RUN, session: RUN, source: 'huddle' },
    {
      runId: RUN,
      claudeSessionId: SESSION,
      templateId: null,
      cwd: 'C:/p',
      model: null,
      permissionMode: 'default',
      mainAgent: null,
      agentNames: [],
      worktree: null,
    },
  );
}

const AGENT_WARN = budgetWarningItemId(`agent:${MAIN}`);
const AGENT_OVER = budgetOverItemId(`agent:${MAIN}`);
const SESSION_OVER = budgetOverItemId(`session:${MAIN}`);

describe('budget detector: tokens, one warning and one exceed item', () => {
  it('counts input + output + cache creation (not cache reads), warns once, exceeds once, pauses once', async () => {
    const sim = new Sim().feed(started(), setBudget(T0 + 1, 'agent', MAIN, { maxTokens: 1000 }));
    sim.feed(usage(T0 + 10, MAIN, { input: 300, output: 200, cacheRead: 50_000 }));
    expect(sim.raised()).toEqual([]);
    sim.feed(usage(T0 + 20, MAIN, { input: 100, cacheCreation: 200 })); // 800 = 80%
    expect(sim.raised()).toEqual([AGENT_WARN]);
    sim.feed(usage(T0 + 30, MAIN, { output: 50 }), usage(T0 + 31, MAIN, { output: 10 }));
    expect(sim.raised()).toEqual([AGENT_WARN]);
    sim.feed(usage(T0 + 40, MAIN, { output: 200 })); // 1060
    await sim.settle();
    expect(sim.raised()).toEqual([AGENT_WARN, AGENT_OVER]);
    expect(sim.resolved()).toEqual([AGENT_WARN]);
    sim.feed(usage(T0 + 50, MAIN, { output: 5000 }), usage(T0 + 60, MAIN, { output: 5000 }));
    sim.tick(T0 + 10 * MIN);
    await sim.settle();
    expect(sim.raised()).toEqual([AGENT_WARN, AGENT_OVER]);
    expect(sim.actions).toHaveLength(1);
    expect(sim.controls()).toEqual([{ action: 'pause', source: 'huddle', agentKey: MAIN, detail: AGENT_OVER }]);

    const [over] = sim.open();
    expect(over).toMatchObject({ id: AGENT_OVER, kind: 'budget', severity: 'action_required', agentKey: MAIN });
    expect(over?.detail).toContain('1.1k of 1k tokens');
    expect(over?.detail).toContain('Paused 1 agent.');
    expect(over?.detail).toContain('A terminal session goes on by itself after about 10 min.');
    expect(over?.detail).toContain('about one call');
  });

  it('uses the same numbers as selectBudgetView (what the meter shows)', () => {
    const sim = new Sim().feed(started(), setBudget(T0 + 1, 'agent', MAIN, { maxTokens: 1000 }));
    sim.feed(usage(T0 + 10, MAIN, { input: 400, output: 400, cacheCreation: 10, cacheRead: 999 }));
    const entry = sim.state.budgets?.[0] as BudgetEntry;
    const view = selectBudgetView(sim.state, entry, T0 + 10);
    expect(view.level).toBe('warning');
    expect(view.limits[0]?.used).toBe(810);
    expect(sim.open().map((i) => i.id)).toEqual([AGENT_WARN]);
    expect(sim.open()[0]?.detail).toBe('810 of 1k tokens. At the cap it pauses.');
  });

  it('a jump straight past the cap raises only the exceed item', async () => {
    const sim = new Sim().feed(started(), setBudget(T0 + 1, 'agent', MAIN, { maxTokens: 1000 }));
    sim.feed(usage(T0 + 10, MAIN, { input: 5000 }));
    await sim.settle();
    expect(sim.raised()).toEqual([AGENT_OVER]);
  });
});

describe('budget detector: what each scope counts', () => {
  it("agent: the agent's own requests only, not its subagents'", () => {
    const sim = new Sim().feed(started(), sub(T0 + 1), setBudget(T0 + 2, 'agent', MAIN, { maxTokens: 1000 }));
    sim.feed(usage(T0 + 10, SUB, { input: 50_000 }));
    expect(sim.raised()).toEqual([]);
    sim.feed(usage(T0 + 20, MAIN, { input: 900 }));
    expect(sim.raised()).toEqual([AGENT_WARN]);
  });

  it('session: every agent of the session plus helper requests', async () => {
    const sim = new Sim().feed(started(), sub(T0 + 1), setBudget(T0 + 2, 'session', MAIN, { maxTokens: 1000 }));
    sim.feed(usage(T0 + 10, SUB, { input: 500 }), usage(T0 + 11, MAIN, { input: 200 }));
    expect(sim.raised()).toEqual([]);
    sim.feed(usage(T0 + 12, MAIN, { input: 400 }, { kind: 'helper' })); // 1100 with the helper request
    await sim.settle();
    expect(sim.raised()).toEqual([SESSION_OVER]);
    const used = selectBudgetUsed(sim.state, sim.state.budgets?.[0] as BudgetEntry, T0 + 12);
    expect(used.tokens).toBe(1100);
    // Pause reaches every live agent of the session, the subagent included.
    expect(sim.actions[0]?.pause.map((p) => p.agentKey)).toEqual([MAIN, SUB]);
    expect(sim.open()[0]?.title).toContain('The session budget of');
  });

  it('overall: every session, filed under the most recently active one, pausing every live agent', async () => {
    const sim = new Sim().feed(started(T0, SESSION), started(T0 + 1, OTHER));
    sim.feed(setBudget(T0 + 2, 'overall', null, { maxTokens: 1000 }));
    sim.feed(usage(T0 + 10, MAIN, { input: 850 }), usage(T0 + 11, OTHER_MAIN, { input: 300 }));
    await sim.settle();
    const overId = budgetOverItemId('overall:*');
    expect(sim.raised()).toEqual([budgetWarningItemId('overall:*'), overId]);
    expect(sim.actions[0]?.pause.map((p) => p.agentKey).sort()).toEqual([MAIN, OTHER_MAIN].sort());
    expect(sim.open()[0]).toMatchObject({ id: overId, agentKey: sim.state.rootKeys[0] });
    expect(sim.open()[0]?.title).toBe('The overall budget is used up');
  });
});

describe('budget detector: estimated cost', () => {
  it('an unknown cost never triggers and is not counted as 0', () => {
    const sim = new Sim().feed(started(), setBudget(T0 + 1, 'agent', MAIN, { maxEstimatedCostUsd: 0 }));
    sim.feed(
      usage(T0 + 10, MAIN, { input: 100 }, { cost: null }),
      usage(T0 + 11, MAIN, { input: 100 }, { cost: null }),
    );
    const entry = sim.state.budgets?.[0] as BudgetEntry;
    expect(selectBudgetUsed(sim.state, entry, T0 + 11).costUsd).toBeNull();
    expect(selectBudgetView(sim.state, entry, T0 + 11).level).toBe('unknown');
    expect(sim.raised()).toEqual([]);
  });

  it('a known cost warns and exceeds; notify raises the item and does nothing else', async () => {
    const sim = new Sim().feed(
      started(),
      setBudget(T0 + 1, 'agent', MAIN, { maxEstimatedCostUsd: 1, onExceed: 'notify' }),
    );
    sim.feed(usage(T0 + 10, MAIN, { input: 1 }, { cost: 0.85 }));
    expect(sim.raised()).toEqual([AGENT_WARN]);
    expect(sim.open()[0]?.detail).toBe('$0.85 of $1.00 estimated cost. At the cap you are told; nothing is paused.');
    sim.feed(usage(T0 + 11, MAIN, { input: 1 }, { cost: 0.3 }));
    await sim.settle();
    expect(sim.raised()).toEqual([AGENT_WARN, AGENT_OVER]);
    expect(sim.actions).toEqual([]);
    expect(sim.controls()).toEqual([]);
    expect(sim.open()[0]?.detail).toContain('Notify only: nothing was paused.');
  });
});

describe('budget detector: a session cost cap (the exceed path)', () => {
  const SESSION_WARN = budgetWarningItemId(`session:${MAIN}`);

  it('recorded cost_usd crossing warn then cap: one warning, one exceed, the action once', async () => {
    const sim = new Sim().feed(
      started(),
      sub(T0 + 1),
      setBudget(T0 + 2, 'session', MAIN, { maxEstimatedCostUsd: 0.5, onExceed: 'pause' }),
    );
    // 0.35 of 0.50 = 70%: nothing yet. The subagent's cost counts for the session.
    sim.feed(usage(T0 + 10, MAIN, { input: 100 }, { cost: 0.2 }), usage(T0 + 11, SUB, { input: 100 }, { cost: 0.15 }));
    expect(sim.raised()).toEqual([]);
    // 0.41 = 82%: the warning, once.
    sim.feed(usage(T0 + 12, SUB, { input: 1 }, { cost: 0.06 }));
    expect(sim.raised()).toEqual([SESSION_WARN]);
    expect(sim.open()[0]?.detail).toBe('$0.41 of $0.50 estimated cost. At the cap it pauses.');
    sim.feed(usage(T0 + 13, MAIN, { input: 1 }, { cost: 0.01 }));
    expect(sim.raised()).toEqual([SESSION_WARN]);
    // 0.52: over. The warning is superseded, the exceed item raised, the pause asked for once.
    sim.feed(usage(T0 + 14, MAIN, { input: 1 }, { cost: 0.1 }));
    await sim.settle();
    expect(sim.raised()).toEqual([SESSION_WARN, SESSION_OVER]);
    expect(sim.resolved()).toEqual([SESSION_WARN]);
    expect(sim.actions).toHaveLength(1);
    expect(sim.actions[0]).toMatchObject({ reason: 'exceeded', onExceed: 'pause' });
    expect(sim.paused.map((p) => p.agentKey)).toEqual([MAIN, SUB]);

    // More spending and time while it holds: nothing new.
    sim.feed(usage(T0 + 20, MAIN, { input: 1 }, { cost: 1 }), usage(T0 + 21, SUB, { input: 1 }, { cost: 1 }));
    sim.tick(T0 + 5 * MIN);
    await sim.settle();
    expect(sim.raised()).toEqual([SESSION_WARN, SESSION_OVER]);
    expect(sim.actions).toHaveLength(1);
    expect(sim.controls().filter((c) => c.action === 'pause')).toHaveLength(2);

    const [over] = sim.open();
    expect(over).toMatchObject({ id: SESSION_OVER, severity: 'action_required', agentKey: MAIN });
    expect(over?.detail).toContain('$0.52 of $0.50 estimated cost');
    expect(over?.detail).toContain('Paused 2 agents.');
  });

  it('mixed known and unknown costs: only the known ones count, and the words say estimated', async () => {
    const sim = new Sim().feed(
      started(),
      setBudget(T0 + 1, 'session', MAIN, { maxEstimatedCostUsd: 1, onExceed: 'stop' }),
      launched(T0 + 2),
    );
    // Requests without cost_usd add nothing (and are not read as 0 for "unknown": the total is known).
    sim.feed(
      usage(T0 + 10, MAIN, { input: 50_000 }, { cost: null }),
      usage(T0 + 11, MAIN, { input: 50_000 }, { cost: 0.5 }),
      usage(T0 + 12, MAIN, { input: 50_000 }, { cost: null }),
    );
    const entry = sim.state.budgets?.[0] as BudgetEntry;
    expect(selectBudgetUsed(sim.state, entry, T0 + 12).costUsd).toBe(0.5);
    expect(sim.raised()).toEqual([]);
    sim.feed(usage(T0 + 13, MAIN, { input: 1 }, { cost: 0.35 }), usage(T0 + 14, MAIN, { input: 1 }, { cost: null }));
    expect(selectBudgetUsed(sim.state, entry, T0 + 14).costUsd).toBeCloseTo(0.85, 10);
    expect(sim.raised()).toEqual([SESSION_WARN]);
    expect(sim.open()[0]?.detail).toContain('$0.85 of $1.00 estimated cost');
    sim.feed(usage(T0 + 15, MAIN, { input: 1 }, { cost: null }), usage(T0 + 16, MAIN, { input: 1 }, { cost: 0.2 }));
    await sim.settle();
    expect(sim.raised()).toEqual([SESSION_WARN, SESSION_OVER]);
    expect(sim.actions).toHaveLength(1);
    expect(sim.stops).toEqual([RUN]);
    sim.feed(usage(T0 + 17, MAIN, { input: 1 }, { cost: 0.2 }));
    await sim.settle();
    expect(sim.stops).toEqual([RUN]);
    expect(sim.open()[0]?.detail).toContain('$1.05 of $1.00 estimated cost');
    expect(sim.open()[0]?.detail).toContain('Stopped 1 run.');
  });
});

describe('budget detector: minutes (on the tick)', () => {
  it("agent and session minutes run from the agent's start; overall from when it was set", async () => {
    const sim = new Sim().feed(
      started(T0),
      setBudget(T0 + 1, 'session', MAIN, { maxMinutes: 10, warnAtFraction: 0.5 }),
    );
    sim.tick(T0 + 4 * MIN);
    expect(sim.raised()).toEqual([]);
    sim.tick(T0 + 5 * MIN);
    expect(sim.raised()).toEqual([budgetWarningItemId(`session:${MAIN}`)]);
    sim.tick(T0 + 6 * MIN);
    expect(sim.raised()).toHaveLength(1);
    sim.tick(T0 + 10 * MIN);
    await sim.settle();
    expect(sim.raised()).toEqual([budgetWarningItemId(`session:${MAIN}`), SESSION_OVER]);
    expect(sim.open()[0]?.detail).toContain('10 of 10 min');

    const overall = new Sim().feed(started(T0), setBudget(T0 + 20 * MIN, 'overall', null, { maxMinutes: 10 }));
    overall.tick(T0 + 25 * MIN);
    expect(overall.raised()).toEqual([]);
    overall.tick(T0 + 28 * MIN);
    expect(overall.raised()).toEqual([budgetWarningItemId('overall:*')]);
  });
});

describe('budget detector: resolving', () => {
  it('raising the budget resolves the exceed item; the new setting is checked afresh', async () => {
    const sim = new Sim().feed(started(), setBudget(T0 + 1, 'agent', MAIN, { maxTokens: 1000 }));
    sim.feed(usage(T0 + 10, MAIN, { input: 1200 }));
    await sim.settle();
    expect(sim.open().map((i) => i.id)).toEqual([AGENT_OVER]);
    sim.feed(setBudget(T0 + 20, 'agent', MAIN, { maxTokens: 1400 })); // 1200 of 1400: warning
    await sim.settle();
    expect(sim.open().map((i) => i.id)).toEqual([AGENT_WARN]);
    sim.feed(setBudget(T0 + 30, 'agent', MAIN, { maxTokens: 100_000 }));
    expect(sim.open()).toEqual([]);
    expect(sim.actions).toHaveLength(1);
  });

  it('removing the budget resolves its items; nothing comes back while it is gone', async () => {
    const sim = new Sim().feed(started(), setBudget(T0 + 1, 'agent', MAIN, { maxTokens: 1000 }));
    sim.feed(usage(T0 + 10, MAIN, { input: 1200 }));
    await sim.settle();
    sim.feed(setBudget(T0 + 20, 'agent', MAIN, {})); // no limit: cleared
    expect(sim.state.budgets).toEqual([]);
    expect(sim.open()).toEqual([]);
    sim.feed(usage(T0 + 30, MAIN, { input: 5000 }));
    sim.tick(T0 + 60 * MIN);
    expect(sim.open()).toEqual([]);
    expect(sim.resolved()).toContain(AGENT_OVER);
  });

  it('setting a budget that is already exceeded raises and acts at once', async () => {
    const sim = new Sim().feed(started(), usage(T0 + 10, MAIN, { input: 1200 }));
    sim.feed(setBudget(T0 + 20, 'agent', MAIN, { maxTokens: 1000 }));
    await sim.settle();
    expect(sim.raised()).toEqual([AGENT_OVER]);
    expect(sim.paused.map((p) => p.agentKey)).toEqual([MAIN]);
  });
});

describe('budget detector: who is acted on', () => {
  it('stop on an attached session pauses instead, and says it cannot be stopped', async () => {
    const sim = new Sim().feed(started(), setBudget(T0 + 1, 'session', MAIN, { maxTokens: 100, onExceed: 'stop' }));
    sim.feed(usage(T0 + 10, MAIN, { input: 500 }));
    await sim.settle();
    expect(sim.stops).toEqual([]);
    expect(sim.actions[0]).toMatchObject({ stop: [], notStoppable: [MAIN] });
    expect(sim.paused.map((p) => p.agentKey)).toEqual([MAIN]);
    expect(sim.open()[0]?.detail).toContain('cannot be stopped from here, so it is paused instead.');
  });

  it('stop on a managed run asks stopRun once and writes control.applied stop (source huddle)', async () => {
    const sim = new Sim().feed(started(), launched(T0 + 1), sub(T0 + 2));
    sim.feed(setBudget(T0 + 3, 'agent', SUB, { maxTokens: 100, onExceed: 'stop' }));
    sim.feed(usage(T0 + 10, SUB, { input: 500 }), usage(T0 + 11, SUB, { input: 500 }));
    await sim.settle();
    // A subagent cannot be stopped on its own: its run is.
    expect(sim.stops).toEqual([RUN]);
    expect(sim.controls()).toEqual([
      { action: 'stop', source: 'huddle', agentKey: MAIN, detail: budgetOverItemId(`agent:${SUB}`) },
    ]);
    expect(sim.open()[0]?.detail).toContain('Stopped 1 run.');
  });

  it('while stopping is not available (no StreamDriver yet): the run is paused instead and the item says so', async () => {
    const sim = new Sim().feed(started(), launched(T0 + 1));
    sim.stopRun = unsupportedStopRun;
    sim.feed(setBudget(T0 + 2, 'session', MAIN, { maxTokens: 100, onExceed: 'stop' }));
    sim.feed(usage(T0 + 10, MAIN, { input: 500 }));
    await sim.settle();
    expect(await unsupportedStopRun(RUN)).toEqual({ ok: false, code: 'unsupported', message: STOP_NOT_AVAILABLE });
    expect(sim.paused.map((p) => p.agentKey)).toEqual([MAIN]);
    expect(sim.open()[0]?.detail).toContain(
      'Could not stop 1 run: stopping a run is not available in this build yet. Paused instead.',
    );
  });

  it('agents not seen since this Huddle started, and ended agents, are not acted on', async () => {
    const sim = new Sim(T0 + 5).feed(started(T0), sub(T0 + 1), sub(T0 + 2, SUB2, 'sub2'));
    sim.feed(ev('agent.stopped', { ts: T0 + 6, agent: SUB2 }, { agentId: 'sub2', result: null }));
    sim.feed(setBudget(T0 + 7, 'session', MAIN, { maxTokens: 100 }));
    sim.feed(ev('prompt.submitted', { ts: T0 + 8, agent: MAIN }, { text: 'go on', promptId: null }));
    sim.feed(usage(T0 + 10, SUB, { input: 500 }));
    await sim.settle();
    // MAIN reported since liveSince (the prompt); SUB was last seen before it (telemetry is no sign of life); SUB2 ended.
    expect(sim.actions[0]?.pause.map((p) => p.agentKey)).toEqual([MAIN]);
  });

  it('says so when an agent could not be paused', async () => {
    const sim = new Sim().feed(started(), setBudget(T0 + 1, 'agent', MAIN, { maxTokens: 100 }));
    sim.pauseResult = () => ({ ok: false, code: 'unsupported', message: 'no' });
    sim.feed(usage(T0 + 10, MAIN, { input: 500 }));
    await sim.settle();
    expect(sim.open()[0]?.detail).toContain('1 agent could not be paused.');
  });
});

describe('budget detector: a budget pause that runs out', () => {
  async function pausedManaged(): Promise<Sim> {
    const sim = new Sim().feed(started(), launched(T0 + 1), sub(T0 + 2));
    sim.feed(setBudget(T0 + 3, 'session', MAIN, { maxTokens: 100 }));
    sim.feed(usage(T0 + 10, MAIN, { input: 500 }));
    await sim.settle();
    sim.feed(holdStarted(T0 + 20, MAIN, 'tu1'), holdStarted(T0 + 21, SUB, 'tu2'));
    return sim;
  }

  it('on a managed run: stopRun once, and the item says the run was stopped', async () => {
    const sim = await pausedManaged();
    expect(sim.open()[0]?.detail).toContain('A run Huddle launched is stopped if still paused after about 10 min.');
    sim.feed(holdEnded(T0 + 595_020, MAIN, 'tu1', 'hold_limit'));
    await sim.settle();
    sim.feed(holdEnded(T0 + 595_021, SUB, 'tu2', 'hold_limit'));
    await sim.settle();
    expect(sim.stops).toEqual([RUN]);
    expect(sim.controls().filter((c) => c.action === 'stop')).toHaveLength(1);
    const items = sim.open();
    expect(items.map((i) => i.id)).toEqual([SESSION_OVER]);
    expect(items[0]?.detail).toContain('The pause ran out, so the run was stopped.');
  });

  it('on a managed run whose stop is not available: the item says it continues', async () => {
    const sim = await pausedManaged();
    sim.stopRun = unsupportedStopRun;
    sim.feed(holdEnded(T0 + 595_020, MAIN, 'tu1', 'hold_limit'));
    await sim.settle();
    expect(sim.open()[0]?.detail).toContain(
      'The pause ran out and the run could not be stopped (stopping a run is not available in this build yet), so it continues.',
    );
  });

  it('on an attached session: no stop, the agent continues and the item stays', async () => {
    const sim = new Sim().feed(started(), setBudget(T0 + 1, 'agent', MAIN, { maxTokens: 100 }));
    sim.feed(usage(T0 + 10, MAIN, { input: 500 }));
    await sim.settle();
    sim.feed(holdStarted(T0 + 20, MAIN, 'tu1'), holdEnded(T0 + 595_020, MAIN, 'tu1', 'hold_limit'));
    await sim.settle();
    expect(sim.stops).toEqual([]);
    expect(sim.actions).toHaveLength(1);
    expect(sim.open().map((i) => i.id)).toEqual([AGENT_OVER]);
  });

  it('a resume (or the user pausing it again) hands the pause back: no stop when it later runs out', async () => {
    const sim = await pausedManaged();
    sim.feed(
      ev('control.applied', { ts: T0 + 30, agent: MAIN, source: 'user' }, { action: 'resume', detail: null }),
      ev('control.applied', { ts: T0 + 31, agent: SUB, source: 'user' }, { action: 'pause', detail: null }),
      holdEnded(T0 + 595_020, MAIN, 'tu1', 'hold_limit'),
      holdEnded(T0 + 595_021, SUB, 'tu2', 'hold_limit'),
    );
    await sim.settle();
    expect(sim.stops).toEqual([]);
  });

  it('raising the budget hands the pause back too', async () => {
    const sim = await pausedManaged();
    sim.feed(setBudget(T0 + 40, 'session', MAIN, { maxTokens: 1_000_000 }));
    sim.feed(holdEnded(T0 + 595_020, MAIN, 'tu1', 'hold_limit'));
    await sim.settle();
    expect(sim.stops).toEqual([]);
    expect(sim.open()).toEqual([]);
  });
});

describe('budget detector: after a restart', () => {
  it('a budget already flagged and acted on is not flagged or acted on again', async () => {
    const before = new Sim().feed(started(), setBudget(T0 + 1, 'agent', MAIN, { maxTokens: 100 }));
    before.feed(usage(T0 + 10, MAIN, { input: 500 }));
    await before.settle();
    expect(before.actions).toHaveLength(1);

    const after = new Sim(T0 + 100);
    after.state = before.state;
    after.budget = seedBudgetState(after.state);
    after.feed(usage(T0 + 200, MAIN, { input: 500 }));
    after.tick(T0 + 300);
    await after.settle();
    expect(after.raised()).toEqual([]);
    expect(after.actions).toEqual([]);
    // It still resolves when the budget is raised.
    after.feed(setBudget(T0 + 400, 'agent', MAIN, { maxTokens: 1_000_000 }));
    expect(after.open()).toEqual([]);
  });
});

describe('budget detector: words', () => {
  it('formats token counts compactly', () => {
    expect([950, 1000, 8600, 86_000, 1_250_000].map(tokensText)).toEqual(['950', '1k', '8.6k', '86k', '1.3M']);
  });
});

describe('budget detector over a recorded run', () => {
  const runs = listRunFixtures();
  const file = runs.find((r) => r.id === 'par-explore-5')?.file ?? runs[0]?.file;

  it('a token cap below the run total: exactly one warning, one exceed item, one pause', async () => {
    if (file === undefined) throw new Error('no recorded runs in fixtures/runs');
    const events = fixtureEvents(file);
    const first = events[0] as HuddleEvent;
    const root = agentKey(first.sessionId);
    // The run's total, counted the way the budget counts it.
    let full = initialState();
    for (const e of events) full = reduce(full, e);
    const probe: BudgetEntry = {
      scope: 'session',
      targetKey: root,
      budget: { scope: 'session', warnAtFraction: 1, onExceed: 'notify' },
      setAt: first.ts,
    };
    const total = selectBudgetUsed(full, probe, first.ts).tokens ?? 0;
    expect(total).toBeGreaterThan(0);
    const cap = Math.floor(total * 0.7);

    const sim = new Sim();
    sim.feed(first);
    sim.feed(setBudget(first.ts, 'session', root, { maxTokens: cap, warnAtFraction: 0.5 }));
    for (const e of events.slice(1)) {
      sim.feed(e);
      await sim.settle();
    }
    const warn = budgetWarningItemId(`session:${root}`);
    const over = budgetOverItemId(`session:${root}`);
    expect(sim.raised()).toEqual([warn, over]);
    expect(sim.actions).toHaveLength(1);
    expect(
      sim.controls().filter((c) => c.action === 'pause' && c.source === 'huddle' && c.agentKey === root),
    ).toHaveLength(1);
    expect(sim.open().map((i) => i.id)).toEqual([over]);
    expect(JSON.parse(JSON.stringify(sim.budget))).toEqual(sim.budget);
  });
});
