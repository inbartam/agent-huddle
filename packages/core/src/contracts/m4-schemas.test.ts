import { describe, expect, it } from 'vitest';
import {
  CLIP_LIMITS,
  MAX_WORKTREE_FILES,
  PERMISSION_MODES,
  type HuddleCommand,
  type HuddleEvent,
  type HuddleQuery,
  type PolicyRule,
  type TeamTemplate,
} from '@huddle/shared';
import { M4_COMMAND_TYPES, parseHuddleQuery, parseM4Command, parseRunEvent, teamTemplateSchema } from './m4-schemas.js';

const RUN = 'run-0f3c9a7e';
const base = {
  id: '1763100000000-0001',
  ts: 1_763_100_000_000,
  sessionId: 's1',
  agentKey: 's1',
  source: 'huddle',
} as const;

const template: TeamTemplate = {
  id: 'tpl-review',
  name: 'Review team',
  description: 'Reads the diff and reports',
  prompt: 'Review the last commit.',
  cwd: 'C:/projects/app',
  mainAgent: 'lead',
  model: 'sonnet',
  permissionMode: 'default',
  agents: {
    lead: { description: 'Leads', prompt: '' },
    reviewer: {
      description: 'Reviews code',
      prompt: 'You are a code reviewer',
      tools: ['Read', 'Grep'],
      model: 'haiku',
    },
  },
  budgets: [{ scope: 'session', maxTokens: 500_000, warnAtFraction: 0.8, onExceed: 'pause' }],
  ruleIds: ['rule-git-status'],
  worktree: true,
};

const rule: PolicyRule = {
  id: 'rule-git-status',
  name: 'git status',
  enabled: true,
  action: 'allow',
  match: { tool: 'Bash', commandPrefix: 'git status', role: 'main', folder: 'C:/projects/app' },
  note: 'read-only',
};

const events: HuddleEvent[] = [
  {
    ...base,
    type: 'run.launched',
    runId: RUN,
    claudeSessionId: 's1',
    templateId: 'tpl-review',
    cwd: 'C:/projects/app',
    model: 'sonnet',
    permissionMode: 'acceptEdits',
    mainAgent: 'lead',
    agentNames: ['lead', 'reviewer'],
    worktree: { path: 'C:/Users/x/AppData/Local/agent-huddle/worktrees/run-0f3c9a7e', branch: 'huddle/run-0f3c9a7e' },
  },
  {
    ...base,
    sessionId: RUN,
    agentKey: RUN,
    type: 'run.launched',
    runId: RUN,
    claudeSessionId: null,
    templateId: null,
    cwd: 'C:/projects/app',
    model: null,
    permissionMode: 'default',
    mainAgent: null,
    agentNames: [],
    worktree: null,
  },
  { ...base, type: 'run.exited', runId: RUN, exitCode: 0, how: 'completed', error: null },
  { ...base, type: 'run.exited', runId: RUN, exitCode: null, how: 'spawn_failed', error: 'spawn claude ENOENT' },
  { ...base, type: 'run.exited', runId: RUN, exitCode: 1, how: 'failed', error: 'exit 1' },
  { ...base, type: 'run.exited', runId: RUN, exitCode: null, how: 'stopped', error: null },
  {
    ...base,
    source: 'stream',
    type: 'run.result',
    runId: RUN,
    isError: false,
    durationMs: 41_200,
    numTurns: 7,
    totalCostUsd: 0.21,
    permissionDenials: 0,
  },
  {
    ...base,
    source: 'stream',
    type: 'run.result',
    runId: RUN,
    isError: true,
    durationMs: null,
    numTurns: null,
    totalCostUsd: null,
    permissionDenials: 2,
  },
  {
    ...base,
    type: 'worktree.created',
    runId: RUN,
    path: 'C:/wt/run-0f3c9a7e',
    branch: 'huddle/run-0f3c9a7e',
    baseCommit: 'f61ef92a0c1d',
    repoRoot: 'C:/projects/app',
  },
  {
    ...base,
    type: 'worktree.summarized',
    runId: RUN,
    filesChanged: 2,
    insertions: 10,
    deletions: 3,
    untracked: 1,
    files: [
      { path: 'src/a.ts', status: 'modified' },
      { path: 'notes.md', status: 'untracked' },
    ],
  },
  { ...base, source: 'user', type: 'worktree.closed', runId: RUN, outcome: 'kept', error: null },
  {
    ...base,
    source: 'user',
    type: 'worktree.closed',
    runId: RUN,
    outcome: 'discarded',
    error: 'branch huddle/run-0f3c9a7e was not deleted',
  },
  {
    ...base,
    source: 'user',
    type: 'budget.set',
    scope: 'session',
    targetKey: 's1',
    budget: { scope: 'session', maxTokens: 1_000_000, warnAtFraction: 0.8, onExceed: 'pause' },
  },
  {
    ...base,
    source: 'user',
    type: 'budget.set',
    scope: 'overall',
    targetKey: null,
    budget: { scope: 'all', maxEstimatedCostUsd: 5, maxMinutes: 60, warnAtFraction: 0.5, onExceed: 'notify' },
  },
];

describe('M4 event schemas', () => {
  it.each(events.map((e, i) => [`${String(i)} ${e.type}`, e] as const))('round-trips %s through JSON', (_l, event) => {
    const json: unknown = JSON.parse(JSON.stringify(event));
    expect(parseRunEvent(json)).toEqual(event);
  });

  it('keeps unknown extra fields', () => {
    const parsed = parseRunEvent({ ...events[2], later: { x: 1 } });
    expect(parsed).toMatchObject({ type: 'run.exited', later: { x: 1 } });
  });

  it('accepts every documented permission mode and a mode this build does not know', () => {
    for (const mode of [...PERMISSION_MODES, 'someFutureMode']) {
      expect(parseRunEvent({ ...events[0], permissionMode: mode })).toMatchObject({ permissionMode: mode });
    }
    expect(parseRunEvent({ ...events[0], permissionMode: 'x'.repeat(1000) })).toMatchObject({
      permissionMode: expect.stringMatching(/…$/) as unknown,
    });
  });

  it('clips free text and paths instead of rejecting them', () => {
    const exited = parseRunEvent({ ...events[3], error: 'e'.repeat(5000) });
    expect(exited?.type === 'run.exited' ? exited.error?.length : -1).toBe(CLIP_LIMITS.error);
    const launched = parseRunEvent({ ...events[0], cwd: 'C:/' + 'd'.repeat(3000) });
    expect(launched?.type === 'run.launched' ? launched.cwd.length : -1).toBe(CLIP_LIMITS.path);
  });

  it('keeps the first MAX_WORKTREE_FILES files, clips their paths, and reads an unknown status as unknown', () => {
    const files = Array.from({ length: 80 }, (_, i) => ({ path: `f${String(i)}.ts`, status: 'modified' }));
    files[0] = { path: 'p'.repeat(2000), status: 'weird' };
    const parsed = parseRunEvent({ ...events[9], filesChanged: 80, files });
    if (parsed?.type !== 'worktree.summarized') throw new Error('did not parse');
    expect(parsed.files).toHaveLength(MAX_WORKTREE_FILES);
    expect(parsed.filesChanged).toBe(80);
    expect(parsed.files[0]?.status).toBe('unknown');
    expect(parsed.files[0]?.path.length).toBe(CLIP_LIMITS.path);
  });

  it.each([
    ['a runId with a path separator', { ...events[2], runId: '../x' }],
    ['an empty runId', { ...events[2], runId: '' }],
    ['an unknown exit kind', { ...events[2], how: 'crashed' }],
    ['a negative token count', { ...events[9], insertions: -1 }],
    ['a fractional permission denial count', { ...events[6], permissionDenials: 1.5 }],
    ['an unknown budget scope', { ...events[12], scope: 'team' }],
    ['a worktree outcome that is not kept or discarded', { ...events[10], outcome: 'merged' }],
    ['an event type M4 does not add', { ...base, type: 'session.ended', reason: 'x' }],
    ['not an object', 'run.launched'],
  ])('rejects %s, returning null', (_label, input) => {
    expect(parseRunEvent(input)).toBeNull();
  });
});

const commands: HuddleCommand[] = [
  { type: 'template.upsert', template },
  { type: 'template.remove', templateId: 'tpl-review' },
  { type: 'run.launch', templateId: 'tpl-review' },
  { type: 'run.launch', template, promptOverride: 'Only look at src/.' },
  { type: 'run.stop', runId: RUN },
  { type: 'run.end', runId: RUN },
  { type: 'run.keepWorktree', runId: RUN },
  { type: 'run.discardWorktree', runId: RUN },
  { type: 'run.openWorktree', runId: RUN },
  { type: 'policy.upsertRule', rule },
  { type: 'policy.upsertRule', rule: { id: 'r2', name: 'no curl', enabled: false, action: 'deny', match: {} } },
  {
    type: 'policy.upsertRule',
    rule: {
      id: 'r3',
      name: 'node',
      enabled: true,
      action: 'allow',
      match: { commandPrefix: 'node --version', commandExact: true },
    },
  },
  { type: 'policy.removeRule', ruleId: 'rule-git-status' },
  {
    type: 'budget.set',
    agentKey: 's1::a1',
    budget: { scope: 'agent', maxTokens: 10, warnAtFraction: 1, onExceed: 'stop' },
  },
  { type: 'budget.set', agentKey: null, budget: { scope: 'all', warnAtFraction: 0.9, onExceed: 'notify' } },
];

describe('M4 command schemas', () => {
  it.each(commands.map((c, i) => [`${String(i)} ${c.type}`, c] as const))('round-trips %s through JSON', (_l, cmd) => {
    const json: unknown = JSON.parse(JSON.stringify(cmd));
    expect(parseM4Command(json)).toEqual(cmd);
  });

  it('covers every M4 command type', () => {
    expect(new Set(commands.map((c) => c.type))).toEqual(new Set(M4_COMMAND_TYPES));
  });

  it('keeps unknown fields in a template and accepts a permission mode this build does not know', () => {
    const parsed = teamTemplateSchema.safeParse({ ...template, permissionMode: 'newMode', icon: 'star' });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toMatchObject({ permissionMode: 'newMode', icon: 'star' });
  });

  it('drops a __proto__ agent name (zod skips the key) and never touches the prototype', () => {
    const agents: unknown = JSON.parse(
      '{"__proto__": {"description": "x", "prompt": ""}, "ok": {"description": "", "prompt": ""}}',
    );
    const parsed = parseM4Command({ type: 'template.upsert', template: { ...template, agents } });
    if (parsed?.type !== 'template.upsert') throw new Error('did not parse');
    const out = parsed.template.agents ?? {};
    expect(Object.getOwnPropertyNames(out)).toEqual(['ok']);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
  });

  it.each([
    ['run.launch with neither a template nor its id', { type: 'run.launch' }],
    ['run.launch with both', { type: 'run.launch', templateId: 't', template }],
    ['a template without cwd', { type: 'template.upsert', template: { ...template, cwd: undefined } }],
    ['a template whose worktree is not a boolean', { type: 'template.upsert', template: { ...template, worktree: 1 } }],
    [
      'an agent name starting with "-" (would read as a flag)',
      { type: 'template.upsert', template: { ...template, agents: { '-x': { description: '', prompt: '' } } } },
    ],
    [
      'constructor as an agent name',
      { type: 'template.upsert', template: { ...template, agents: { constructor: { description: '', prompt: '' } } } },
    ],
    ['the M0 rule action ask_user', { type: 'policy.upsertRule', rule: { ...rule, action: 'ask_user' } }],
    ['a rule without match', { type: 'policy.upsertRule', rule: { ...rule, match: undefined } }],
    ['a runId that is not file-name safe', { type: 'run.stop', runId: 'a/b' }],
    ['the M0 discardWorktree by sessionId', { type: 'run.discardWorktree', sessionId: 's1' }],
    [
      'a budget warn fraction above 1',
      { type: 'budget.set', agentKey: null, budget: { scope: 'all', warnAtFraction: 2, onExceed: 'notify' } },
    ],
    ['a command M4 does not add', { type: 'all.stop' }],
  ])('rejects %s, returning null', (_label, input) => {
    expect(parseM4Command(input)).toBeNull();
  });
});

describe('huddle:query', () => {
  const queries: HuddleQuery[] = [
    { type: 'policy.preview', rule },
    { type: 'pick.folder' },
    { type: 'pick.folder', defaultPath: 'C:/projects' },
  ];

  it.each(queries.map((q, i) => [`${String(i)} ${q.type}`, q] as const))('round-trips %s', (_l, query) => {
    expect(parseHuddleQuery(JSON.parse(JSON.stringify(query)))).toEqual(query);
  });

  it.each([
    ['an unknown query', { type: 'fs.read', path: 'C:/x' }],
    ['a preview without a rule', { type: 'policy.preview' }],
    ['an empty default path', { type: 'pick.folder', defaultPath: '' }],
    ['null', null],
  ])('rejects %s', (_label, input) => {
    expect(parseHuddleQuery(input)).toBeNull();
  });
});
