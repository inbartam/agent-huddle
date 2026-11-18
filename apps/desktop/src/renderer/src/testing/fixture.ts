/**
 * Fixture-like HuddleState for renderer tests, built with the shared model only. Shaped like what the
 * reducer produces for the nested-subagents fixture: a session, two subagents, one nested grandchild.
 */
import {
  EMPTY_USAGE,
  agentKey,
  type AgentKey,
  type AgentNode,
  type HuddleEvent,
  type HuddleState,
} from '@huddle/shared';

export const XSS = '<img src=x onerror=alert(1)>';
export const T0 = Date.UTC(2026, 10, 13, 9, 0, 0);
export const SESSION = 'fixture-session';

export const KEYS = {
  main: agentKey(SESSION),
  core: agentKey(SESSION, 'core-1'),
  explore: agentKey(SESSION, 'explore-1'),
  tester: agentKey(SESSION, 'test-1'),
  doneExplore: agentKey(SESSION, 'explore-0'),
};

export function agent(partial: Partial<AgentNode> & Pick<AgentNode, 'key' | 'name'>): AgentNode {
  return {
    sessionId: SESSION,
    agentId: null,
    parentKey: null,
    childKeys: [],
    kind: 'subagent',
    origin: 'attached',
    role: 'Explore',
    roleDescription: null,
    model: null,
    cwd: 'C:\\projects\\fixture',
    status: 'working',
    currentActivity: null,
    tasks: [],
    progress: {
      fraction: null,
      completedTasks: 0,
      totalTasks: 0,
      etaMs: null,
      etaLowMs: null,
      etaHighMs: null,
      basis: 'none',
      confidence: 'low',
    },
    usage: EMPTY_USAGE,
    context: {
      usedTokens: null,
      windowTokens: null,
      usedPct: null,
      compactions: 0,
      lastCompactedAt: null,
      loadedInstructions: [],
      measuredBy: null,
    },
    handoff: null,
    capabilities: {
      approve: true,
      answerQuestions: true,
      message: 'queued',
      pause: false,
      stop: false,
      setModel: false,
    },
    toolCalls: 0,
    toolFailures: 0,
    startedAt: T0,
    endedAt: null,
    lastEventAt: T0,
    ...partial,
  };
}

/**
 * main
 *  ├─ core-engineer (exact link, working)
 *  │   └─ Explore (heuristic link, waiting for approval)
 *  ├─ test-engineer (heuristic link, failed)   -> Finished group
 *  └─ Explore #0 (exact link, done)            -> Finished group
 */
export function fixtureState(overrides: Partial<Record<keyof typeof KEYS, Partial<AgentNode>>> = {}): HuddleState {
  const agents: Record<AgentKey, AgentNode> = {
    [KEYS.main]: agent({
      key: KEYS.main,
      name: 'Fixture session',
      kind: 'main',
      role: 'main',
      model: 'claude-opus-5-5',
      childKeys: [KEYS.core, KEYS.tester, KEYS.doneExplore],
      ...overrides.main,
    }),
    [KEYS.core]: agent({
      key: KEYS.core,
      agentId: 'core-1',
      name: 'Build ingest',
      role: 'core-engineer',
      roleDescription: 'Implements packages/core',
      model: 'claude-sonnet-5',
      parentKey: KEYS.main,
      childKeys: [KEYS.explore],
      handoff: { toolUseId: 't1', title: 'Build ingest', brief: null, result: null, link: 'exact' },
      ...overrides.core,
    }),
    [KEYS.explore]: agent({
      key: KEYS.explore,
      agentId: 'explore-1',
      name: 'Find call sites',
      parentKey: KEYS.core,
      status: 'waiting_approval',
      currentActivity: 'Bash: npm install zod',
      handoff: { toolUseId: 't2', title: 'Find call sites', brief: null, result: null, link: 'heuristic' },
      ...overrides.explore,
    }),
    [KEYS.tester]: agent({
      key: KEYS.tester,
      agentId: 'test-1',
      name: 'Write tests',
      role: 'test-engineer',
      parentKey: KEYS.main,
      status: 'failed',
      endedAt: T0 + 5000,
      handoff: { toolUseId: 't3', title: 'Write tests', brief: null, result: null, link: 'heuristic' },
      ...overrides.tester,
    }),
    [KEYS.doneExplore]: agent({
      key: KEYS.doneExplore,
      agentId: 'explore-0',
      name: 'Read the spec',
      parentKey: KEYS.main,
      status: 'done',
      endedAt: T0 + 3000,
      handoff: { toolUseId: 't4', title: 'Read the spec', brief: null, result: null, link: 'exact' },
      ...overrides.doneExplore,
    }),
  };
  return { agents, rootKeys: [KEYS.main], inbox: [], rateLimits: null };
}

export const MIN = 60_000;

/** Usage of one agent with `requests` recorded (the M2 meters). */
export function usageOf(requests: number, usd: number): AgentNode['usage'] {
  return {
    inputTokens: 1200 * requests,
    outputTokens: 300 * requests,
    cacheReadTokens: 9000 * requests,
    cacheCreationTokens: 800 * requests,
    requests,
    estimatedCostUsd: usd,
  };
}

/**
 * The fixture with M2 meters filled in: the main agent's two finished subagents ended 2 and 4 minutes in, so at
 * `METERED_NOW` the main agent has a pace of 2 minutes per subagent. The Explore agent has no usage (unknown) and
 * no tasks or subagents (no progress basis). Build ingest's brief carries markup that must show as text.
 */
export const METERED_NOW = T0 + 4 * MIN + 30_000;
export const MARKUP_BRIEF = 'Rewrite the <b>tokenizer</b> & keep tokenize()';

export function meteredState(): HuddleState {
  return fixtureState({
    main: {
      usage: usageOf(10, 1.5),
      helperUsage: usageOf(2, 0.004),
      context: {
        usedTokens: 172_000,
        windowTokens: 200_000,
        usedPct: 86,
        compactions: 1,
        lastCompactedAt: T0 + MIN,
        loadedInstructions: ['C:\\projects\\fixture\\CLAUDE.md'],
        measuredBy: 'statusline',
      },
    },
    core: {
      usage: usageOf(4, 0.3),
      handoff: { toolUseId: 't1', title: 'Build ingest', brief: MARKUP_BRIEF, result: null, link: 'exact' },
    },
    tester: { usage: usageOf(1, 0.02), endedAt: T0 + 4 * MIN },
    doneExplore: { usage: usageOf(1, 0.01), endedAt: T0 + 2 * MIN },
  });
}

let n = 0;
export function toolEvents(count: number, key: AgentKey = KEYS.core, summary = 'src/index.ts'): HuddleEvent[] {
  const out: HuddleEvent[] = [];
  for (let i = 0; i < count; i += 1) {
    n += 1;
    const id = `e${String(n).padStart(6, '0')}`;
    const common = { sessionId: SESSION, agentKey: key, source: 'hook' as const, toolUseId: id, toolName: 'Read' };
    out.push(
      { ...common, id, ts: T0 + i * 1000, type: 'tool.started', summary, filePath: null, inputDigest: 'd' },
      { ...common, id: `${id}f`, ts: T0 + i * 1000 + 12, type: 'tool.finished', durationMs: 12 },
    );
  }
  return out;
}
