import { describe, expect, it } from 'vitest';
import {
  cleanPromptTitle,
  modelLabel,
  pathBasename,
  promptTopic,
  selectAgentLabel,
  selectSessionIdentity,
  sessionTopic,
  startedAgo,
  LEAD_AGENT,
  TOPIC_MAX,
} from './identity.js';
import { EMPTY_USAGE, type AgentNode, type AgentRun, type HuddleState } from './model.js';
import { selectPhoneView } from './phone.js';

const T0 = Date.UTC(2026, 10, 14, 12, 0, 0);
const MIN = 60_000;

function main(sessionId: string, partial: Partial<AgentNode> = {}): AgentNode {
  return {
    key: sessionId,
    sessionId,
    agentId: null,
    parentKey: null,
    childKeys: [],
    kind: 'main',
    origin: 'attached',
    name: 'main',
    role: 'main',
    roleDescription: null,
    model: null,
    cwd: null,
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
    usage: { ...EMPTY_USAGE },
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

function stateOf(...nodes: AgentNode[]): HuddleState {
  return {
    agents: Object.fromEntries(nodes.map((n) => [n.key, n])),
    rootKeys: nodes.filter((n) => n.kind === 'main').map((n) => n.key),
    inbox: [],
    rateLimits: null,
  };
}

function run(partial: Partial<AgentRun> = {}): AgentRun {
  return {
    runId: 'run-1',
    templateId: 'tpl-1',
    permissionMode: 'default',
    mainAgent: null,
    agentNames: [],
    worktree: null,
    ...partial,
  };
}

describe('pathBasename', () => {
  it.each([
    ['C:\\projects\\agent-huddle', 'agent-huddle'],
    ['C:\\projects\\agent-huddle\\', 'agent-huddle'],
    ['C:/projects/agent-huddle/', 'agent-huddle'],
    ['/home/me/work/api', 'api'],
    ['/home/me/work/api//', 'api'],
    ['\\\\server\\share\\repo', 'repo'],
    ['repo', 'repo'],
  ])('%s -> %s', (path, expected) => {
    expect(pathBasename(path)).toBe(expected);
  });

  it('unknown or empty is null', () => {
    expect(pathBasename(null)).toBeNull();
    expect(pathBasename(undefined)).toBeNull();
    expect(pathBasename('')).toBeNull();
    expect(pathBasename('\\')).toBeNull();
  });
});

describe('modelLabel', () => {
  it.each([
    ['claude-opus-5-5', 'Opus 5.5'],
    ['claude-sonnet-5-5', 'Sonnet 5.5'],
    ['claude-sonnet-4-20250514', 'Sonnet 4'],
    ['claude-haiku-4-5-20251001', 'Haiku 4.5'],
    ['claude-3-5-haiku-20241022', 'Haiku 3.5'],
    ['claude-opus-5-5[1m]', 'Opus 5.5 · 1M'],
    ['opus', 'Opus'],
    ['sonnet[1m]', 'Sonnet · 1M'],
    ['claude-fable-5', 'Fable 5'],
    ['gpt-something', 'gpt-something'],
  ])('%s -> %s', (model, expected) => {
    expect(modelLabel(model)).toBe(expected);
  });

  it('null or blank is null', () => {
    expect(modelLabel(null)).toBeNull();
    expect(modelLabel('  ')).toBeNull();
  });
});

describe('promptTopic', () => {
  it('first non-empty line, whitespace collapsed', () => {
    expect(promptTopic('\n\n  fix   the\tlogin bug  \nand then the tests')).toBe('fix the login bug');
  });

  it('prompts that open with a tag are not topics', () => {
    expect(promptTopic('<task-notification><task-id>a1</task-id>done')).toBeNull();
    expect(promptTopic('<agent-message from="agent-2">hi')).toBeNull();
    expect(promptTopic('  <browser_instruction>x')).toBeNull();
    expect(promptTopic('   \n ')).toBeNull();
  });

  it(`clips to ${String(TOPIC_MAX)} characters with an ellipsis`, () => {
    const topic = promptTopic('word '.repeat(100)) ?? '';
    expect(topic.length).toBeLessThanOrEqual(TOPIC_MAX);
    expect(topic.endsWith('…')).toBe(true);
  });
});

describe('startedAgo', () => {
  it.each([
    [10_000, 'just now'],
    [3 * MIN, '3m'],
    [125 * MIN, '2h'],
    [30 * 60 * MIN, 'yesterday'],
    [4 * 24 * 60 * MIN, '4d'],
    [-5 * MIN, 'just now'],
  ])('%d ms -> %s', (ago, expected) => {
    expect(startedAgo(T0, T0 + ago)).toBe(expected);
  });
});

describe('selectSessionIdentity', () => {
  it('an unnamed session with nothing else known is "<project> session"', () => {
    const state = stateOf(main('s1', { sessionCwd: 'C:\\work\\billing-api\\', cwd: 'C:\\work\\billing-api\\src' }));
    const id = selectSessionIdentity(state, 's1', T0 + 3 * MIN);
    expect(id).toMatchObject({
      title: 'billing-api session',
      titleFrom: 'project',
      project: 'billing-api',
      projectPath: 'C:\\work\\billing-api\\',
      worktree: false,
      topic: null,
      startedAgo: '3m',
      disambiguator: null,
      label: 'billing-api session',
    });
  });

  it('falls back to cwd, then to "Session <HH:MM>", never "main"', () => {
    expect(selectSessionIdentity(stateOf(main('s1', { cwd: '/srv/web' })), 's1', T0)?.title).toBe('web session');
    const unknown = selectSessionIdentity(stateOf(main('s1')), 's1', T0);
    expect(unknown).toMatchObject({ titleFrom: 'default', project: null, projectPath: null });
    expect(unknown?.title).toMatch(/^Session \d\d:\d\d$/);
  });

  it('the nickname or session title wins over the project; a pending rename wins over both', () => {
    const state = stateOf(main('s1', { name: 'Ingest lead', sessionCwd: 'C:\\work\\api', lastPrompt: 'fix it' }));
    expect(selectSessionIdentity(state, 's1', T0)).toMatchObject({
      title: 'Ingest lead',
      titleFrom: 'name',
      topic: 'fix it',
    });
    const renames = new Map([['s1', 'Night shift']]);
    expect(selectSessionIdentity(state, 's1', T0, { renames })?.title).toBe('Night shift');
  });

  it('a topic that repeats the title is dropped', () => {
    const state = stateOf(main('s1', { name: 'Fix the login bug', lastPrompt: 'Fix the login bug' }));
    expect(selectSessionIdentity(state, 's1', T0)?.topic).toBeNull();
  });

  it('a managed run in a worktree is named after its repository, flagged worktree', () => {
    const wtPath = 'C:\\Users\\me\\.huddle\\worktrees\\run-1';
    const withRepo = main('s1', {
      origin: 'managed',
      sessionCwd: wtPath,
      run: run({ worktree: { path: wtPath, branch: 'huddle/run-1', state: 'active', repoRoot: 'C:\\work\\shop' } }),
    });
    expect(selectSessionIdentity(stateOf(withRepo), 's1', T0)).toMatchObject({
      title: 'shop session',
      project: 'shop',
      projectPath: 'C:\\work\\shop',
      worktree: true,
    });

    // Only run.launched seen: no repoRoot yet, so the template's folder names the project.
    const noRepo = main('s1', {
      origin: 'managed',
      sessionCwd: wtPath,
      run: run({ worktree: { path: wtPath, branch: 'huddle/run-1', state: 'active' } }),
    });
    const state: HuddleState = {
      ...stateOf(noRepo),
      templates: [
        {
          id: 'tpl-1',
          name: 'Reviewer',
          prompt: 'review',
          cwd: '/home/me/shop/',
          mainAgent: null,
          model: null,
          permissionMode: 'default',
          worktree: true,
        },
      ],
    };
    expect(selectSessionIdentity(state, 's1', T0)).toMatchObject({ project: 'shop', worktree: true });
    // Neither known: the worktree folder itself.
    expect(selectSessionIdentity(stateOf(noRepo), 's1', T0)?.project).toBe('run-1');
  });

  it('two sessions with the same title and no topic get their start time; with topics they do not', () => {
    const a = main('s-aaaaaaa1', { sessionCwd: 'C:\\work\\api', startedAt: T0 });
    const b = main('s-bbbbbbb2', { sessionCwd: 'D:\\other\\api', startedAt: T0 + 7 * MIN });
    const state = stateOf(a, b);
    const ia = selectSessionIdentity(state, a.key, T0 + 10 * MIN);
    const ib = selectSessionIdentity(state, b.key, T0 + 10 * MIN);
    const hhmm = (ts: number) =>
      `${String(new Date(ts).getHours()).padStart(2, '0')}:${String(new Date(ts).getMinutes()).padStart(2, '0')}`;
    expect(ia?.disambiguator).toBe(hhmm(T0));
    expect(ib?.disambiguator).toBe(hhmm(T0 + 7 * MIN));
    expect(ia?.label).toBe(`api session · ${hhmm(T0)}`);
    expect(ia?.label).not.toBe(ib?.label);

    // Same minute: the start of the session id instead.
    const c = main('s-ccccccc3', { sessionCwd: 'C:\\work\\api', startedAt: T0 + 1000 });
    const same = stateOf(a, c);
    expect(selectSessionIdentity(same, a.key, T0)?.disambiguator).toBe('#s-aaaa');
    expect(selectSessionIdentity(same, c.key, T0)?.disambiguator).toBe('#s-cccc');

    // Different topics tell them apart already.
    const withTopics = stateOf({ ...a, lastPrompt: 'add paging' }, { ...b, lastPrompt: 'fix the auth test' });
    expect(selectSessionIdentity(withTopics, a.key, T0)?.disambiguator).toBeNull();
    // Peers limit who counts as a twin.
    expect(selectSessionIdentity(state, a.key, T0, { peers: [a.key] })?.disambiguator).toBeNull();
  });

  it('model label and null for a non-root', () => {
    const sub: AgentNode = { ...main('s1'), key: 's1::a1', agentId: 'a1', kind: 'subagent', name: 'Explore #1' };
    const state = stateOf(main('s1', { model: 'claude-opus-5-5[1m]' }), sub);
    expect(selectSessionIdentity(state, 's1', T0)?.model).toBe('Opus 5.5 · 1M');
    expect(selectSessionIdentity(state, 's1::a1', T0)).toBeNull();
    expect(selectSessionIdentity(state, 'nope', T0)).toBeNull();
  });
});

describe('selectAgentLabel', () => {
  it('main agents get the session label, subagents their own name', () => {
    const sub: AgentNode = { ...main('s1'), key: 's1::a1', agentId: 'a1', kind: 'subagent', name: 'Explore #1' };
    const state = stateOf(main('s1', { sessionCwd: '/w/huddle' }), sub);
    expect(selectAgentLabel(state, 's1')).toBe('huddle session');
    expect(selectAgentLabel(state, 's1::a1')).toBe('Explore #1');
    expect(selectAgentLabel(state, 's1::a1', { renames: new Map([['s1::a1', 'Scout']]) })).toBe('Scout');
    expect(selectAgentLabel(state, 'nope')).toBeNull();
  });
});

describe('cleanPromptTitle', () => {
  it('plain text: first non-empty line, collapsed, clipped', () => {
    expect(cleanPromptTitle('\n  fix   the login\tbug \nthen the tests')).toBe('fix the login bug');
    const long = cleanPromptTitle('word '.repeat(100)) ?? '';
    expect(long.length).toBeLessThanOrEqual(TOPIC_MAX);
    expect(long.endsWith('…')).toBe(true);
  });

  it('strips pasted content blocks, keeping the words around them', () => {
    expect(cleanPromptTitle('<pasted_content id="1">line one\nline two</pasted_content>\nsummarise this')).toBe(
      'summarise this',
    );
    expect(cleanPromptTitle('fix <pasted_content_2 lines="40">a\nb</pasted_content_2> please')).toBe('fix please');
  });

  it('strips slash command, local command and shell blocks', () => {
    const cmd =
      '<command-message>review is running…</command-message>\n<command-name>/review</command-name>\n<command-args>the parser</command-args>';
    expect(cleanPromptTitle(cmd)).toBeNull();
    expect(cleanPromptTitle(`${cmd}\nlook at the parser first`)).toBe('look at the parser first');
    expect(cleanPromptTitle('<local-command-stdout>ok</local-command-stdout>add paging')).toBe('add paging');
    expect(cleanPromptTitle('<bash-input>ls</bash-input><bash-stdout>a b</bash-stdout>\nnow sort them')).toBe(
      'now sort them',
    );
  });

  it('strips system reminders, self-closing forms, and blocks cut at the start of a line', () => {
    expect(cleanPromptTitle('<system-reminder>be brief</system-reminder>rename the module')).toBe('rename the module');
    expect(cleanPromptTitle('<pasted_content id="3" />check this')).toBe('check this');
    expect(cleanPromptTitle('rename it\n<system-reminder>cut by a cl')).toBe('rename it');
    expect(cleanPromptTitle('<command-name>/review')).toBeNull();
    expect(cleanPromptTitle('</command-args> go on')).toBe('go on');
  });

  it('an unclosed pasted block goes to the end wherever it is, even cut inside its tag', () => {
    expect(cleanPromptTitle('explain the log <pasted_content id="4">huge paste cut by a cl')).toBe('explain the log');
    expect(cleanPromptTitle('explain <pasted_content id="5"')).toBe('explain');
  });

  it('a Claude Code tag named in prose is text: unclosed or stray in mid-line', () => {
    expect(cleanPromptTitle('explain what <command-name> does')).toBe('explain what <command-name> does');
    expect(cleanPromptTitle('why does </system-reminder> show up')).toBe('why does </system-reminder> show up');
    expect(cleanPromptTitle('compare <command-name> and <command-args> please')).toBe(
      'compare <command-name> and <command-args> please',
    );
    // A closed pair in prose is a block: Claude Code writes them, people rarely type both.
    expect(cleanPromptTitle('see <command-name>/x</command-name> here')).toBe('see here');
  });

  it('nested blocks go with their parent, same name or not, and leak nothing', () => {
    expect(cleanPromptTitle('<pasted_content>x <command-name>/a</command-name> y</pasted_content>then ship it')).toBe(
      'then ship it',
    );
    expect(
      cleanPromptTitle('<pasted_content>a<pasted_content>INNER</pasted_content>OUTER-TAIL</pasted_content>done'),
    ).toBe('done');
    expect(cleanPromptTitle('<system-reminder>a<system-reminder>b</system-reminder>LEAK</system-reminder> ok')).toBe(
      'ok',
    );
  });

  it('other tags are text, even at the start; only harness tags give no title', () => {
    expect(cleanPromptTitle('<div> not centered')).toBe('<div> not centered');
    expect(cleanPromptTitle('<b>no</b>')).toBe('<b>no</b>');
    expect(cleanPromptTitle('say <img src=x onerror=alert(1)> please')).toBe('say <img src=x onerror=alert(1)> please');
    expect(cleanPromptTitle('is a < b')).toBe('is a < b');
    expect(cleanPromptTitle('<task-notification><task-id>a1</task-id>done')).toBeNull();
    expect(cleanPromptTitle('<agent-message from="agent-2">hi')).toBeNull();
    expect(cleanPromptTitle('  <browser_instruction>open the page')).toBeNull();
  });

  it('null when nothing is left', () => {
    expect(cleanPromptTitle('')).toBeNull();
    expect(cleanPromptTitle(null)).toBeNull();
    expect(cleanPromptTitle(undefined)).toBeNull();
    expect(cleanPromptTitle('<system-reminder>only this</system-reminder>  \n ')).toBeNull();
  });

  it('drops bidi controls and zero-width characters', () => {
    expect(cleanPromptTitle('fix \u202Egnp.exe\u202C the\u200B bug\uFEFF')).toBe('fix gnp.exe the bug');
    expect(cleanPromptTitle('<system-\u200Breminder>x</system-reminder>go')).toBe('go');
  });

  it('is linear: 2000 characters of near-tags in well under 5 ms', () => {
    const inputs = [
      `<command-${'a-'.repeat(1000)}`,
      '<'.repeat(2000),
      `${'<command-name>'.repeat(140)}x`,
      `fix ${'<pasted_content'.repeat(130)}`,
      `a ${'<command-name> '.repeat(130)}`,
    ];
    for (const input of inputs) cleanPromptTitle(input);
    for (const input of inputs) {
      const t0 = Date.now();
      for (let i = 0; i < 10; i++) cleanPromptTitle(input);
      expect((Date.now() - t0) / 10).toBeLessThan(5);
    }
  });
});

describe('selectSessionIdentity: one naming rule everywhere', () => {
  const child = (sessionId: string, agentId: string, title: string | null): AgentNode => ({
    ...main(sessionId),
    key: `${sessionId}::${agentId}`,
    agentId,
    parentKey: sessionId,
    kind: 'subagent',
    role: 'general-purpose',
    name: title ?? 'general-purpose #1',
    handoff: { toolUseId: null, title, brief: null, result: null, link: 'exact' },
  });

  it('order: name, first prompt, last prompt, first subagent task, "<project> session", "Session HH:MM"', () => {
    const sub = child('s1', 'a1', 'Apply approved site copy/design');
    const base = { sessionCwd: '/w/api', childKeys: [sub.key] };
    const at = (n: AgentNode) => selectSessionIdentity(stateOf(n, sub), 's1', T0);
    expect(at(main('s1', { ...base, name: 'Ingest lead', firstPrompt: 'fix it' }))).toMatchObject({
      title: 'Ingest lead',
      titleFrom: 'name',
    });
    expect(at(main('s1', { ...base, firstPrompt: 'fix the login bug', lastPrompt: 'now tests' }))).toMatchObject({
      title: 'fix the login bug',
      titleFrom: 'prompt',
      topic: 'now tests',
      project: 'api',
    });
    expect(at(main('s1', { ...base, lastPrompt: 'only the last' }))).toMatchObject({
      title: 'only the last',
      titleFrom: 'prompt',
      topic: null,
    });
    expect(at(main('s1', base))).toMatchObject({ title: 'Apply approved site copy/design', titleFrom: 'task' });
    expect(selectSessionIdentity(stateOf(main('s1', { sessionCwd: '/w/api' })), 's1', T0)).toMatchObject({
      title: 'api session',
      titleFrom: 'project',
    });
    expect(selectSessionIdentity(stateOf(main('s1')), 's1', T0)?.title).toMatch(/^Session \d\d:\d\d$/);
  });

  it('never shows the raw "main" or "Untitled session"', () => {
    for (const n of [main('s1'), main('s1', { sessionCwd: '/w/x' }), main('s1', { name: 'main' })]) {
      const title = selectSessionIdentity(stateOf(n), 's1', T0)?.title ?? '';
      expect(title).not.toBe('main');
      expect(title).not.toMatch(/untitled/i);
    }
  });

  it('a subagent without a task is skipped for the next one; tags in a task are cleaned', () => {
    const a = child('s1', 'a1', null);
    const b = child('s1', 'a2', '<system-reminder>x</system-reminder>Map token kinds');
    const state = stateOf(main('s1', { childKeys: [a.key, b.key] }), a, b);
    expect(selectSessionIdentity(state, 's1', T0)?.title).toBe('Map token kinds');
  });

  it('a first prompt that cleans to nothing falls through to the next rule', () => {
    const state = stateOf(main('s1', { firstPrompt: '<system-reminder>x</system-reminder>', sessionCwd: '/w/api' }));
    expect(selectSessionIdentity(state, 's1', T0)?.title).toBe('api session');
  });

  it('a rename wins at once, trimmed', () => {
    const state = stateOf(main('s1', { firstPrompt: 'add paging' }));
    const renames = new Map([['s1', '  Paging work ']]);
    expect(selectSessionIdentity(state, 's1', T0, { renames })).toMatchObject({
      title: 'Paging work',
      titleFrom: 'name',
    });
  });

  it('the topic is dropped when it repeats the title, kept when it moved on', () => {
    const same = stateOf(main('s1', { firstPrompt: 'add paging', lastPrompt: 'add paging' }));
    expect(selectSessionIdentity(same, 's1', T0)?.topic).toBeNull();
    const moved = stateOf(main('s1', { firstPrompt: 'add paging', lastPrompt: 'now the tests' }));
    expect(selectSessionIdentity(moved, 's1', T0)?.topic).toBe('now the tests');
  });

  it('two sessions that both fall back to their folder are told apart by start time', () => {
    const state = stateOf(
      main('s1', { sessionCwd: '/w/api' }),
      main('s2', { sessionCwd: '/w/api', startedAt: T0 + 5 * MIN }),
    );
    expect(selectSessionIdentity(state, 's2', T0)?.label).toMatch(/^api session · \d\d:\d\d$/);
  });

  it('the main agent is labelled as the lead', () => {
    expect(LEAD_AGENT).toBe('Lead agent');
  });
});

describe('sessionTopic', () => {
  it('the cleaned last prompt, else the cleaned first, else null', () => {
    expect(sessionTopic('<system-reminder>x</system-reminder>add paging', 'first')).toBe('add paging');
    expect(sessionTopic('<command-name>/clear</command-name>', 'fix the parser')).toBe('fix the parser');
    expect(sessionTopic(null, undefined)).toBeNull();
  });
});

describe('the phone names sessions by the same rule', () => {
  it('session title from the rule without prompts (the phone carries no prompt text), never "main"', () => {
    const state = stateOf(
      main('s1', { sessionCwd: '/w/api', firstPrompt: 'fix the login bug', lastPrompt: 'x' }),
      main('s2'),
    );
    const view = selectPhoneView(state, T0);
    const s1 = view.sessions.find((s) => s.rootKey === 's1');
    expect(s1).toMatchObject({ title: 'api session', project: 'api' });
    expect(JSON.stringify(view)).not.toContain('fix the login bug');
    expect(s1?.agents[0]?.name).toBe('Lead agent');
    const s2 = view.sessions.find((s) => s.rootKey === 's2');
    expect(s2?.title).toMatch(/^Session \d\d:\d\d$/);
    expect(view.sessions.map((s) => s.title)).not.toContain('main');
  });
});
