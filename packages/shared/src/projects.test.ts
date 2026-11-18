import { describe, expect, it } from 'vitest';
import { EMPTY_USAGE, type AgentNode, type AttentionItem, type HuddleState } from './model.js';
import {
  isHarnessSession,
  isTooBroadFolder,
  NO_FOLDER,
  NO_FOLDER_ID,
  projectKey,
  selectHiddenSessionCount,
  selectHomeCounts,
  selectProjects,
} from './projects.js';
import { selectNeedsYouCount, selectTree } from './selectors.js';

const T0 = Date.UTC(2026, 10, 16, 9, 0, 0);
const MIN = 60_000;

function node(key: string, partial: Partial<AgentNode> = {}): AgentNode {
  const sessionId = key.split('::')[0] ?? key;
  const sub = key.includes('::');
  return {
    key,
    sessionId,
    agentId: sub ? key : null,
    parentKey: sub ? sessionId : null,
    childKeys: [],
    kind: sub ? 'subagent' : 'main',
    origin: 'attached',
    name: sub ? 'Explore #1' : 'main',
    role: sub ? 'Explore' : 'main',
    roleDescription: null,
    model: null,
    cwd: null,
    status: 'idle',
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
    toolCalls: 4,
    toolFailures: 0,
    startedAt: T0,
    endedAt: null,
    lastEventAt: T0,
    ...partial,
  };
}

function stateOf(nodes: AgentNode[], inbox: AttentionItem[] = []): HuddleState {
  const agents = Object.fromEntries(nodes.map((n) => [n.key, n]));
  for (const n of nodes) {
    const parent = n.parentKey === null ? undefined : agents[n.parentKey];
    if (parent !== undefined && !parent.childKeys.includes(n.key)) parent.childKeys.push(n.key);
  }
  return { agents, rootKeys: nodes.filter((n) => n.kind === 'main').map((n) => n.key), inbox, rateLimits: null };
}

function item(id: string, agentKey: string, partial: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id,
    kind: 'stuck',
    severity: 'warning',
    agentKey,
    title: 'No progress for 10 min',
    detail: '',
    createdAt: T0,
    resolvedAt: null,
    ...partial,
  };
}

const ids = (views: { sessionId: string }[]) => views.map((v) => v.sessionId);

describe('projectKey', () => {
  it.each([
    ['C:\\Work\\API\\', 'c:/work/api'],
    ['C:/Work//API', 'c:/work/api'],
    ['\\\\server\\Share\\x', '//server/share/x'],
    ['/home/me/Api/', '/home/me/Api'],
    ['/', '/'],
  ])('%s -> %s', (path, key) => {
    expect(projectKey(path)).toBe(key);
  });

  it('null and blank are null', () => {
    expect(projectKey(null)).toBeNull();
    expect(projectKey(undefined)).toBeNull();
    expect(projectKey('  ')).toBeNull();
  });
});

describe('selectProjects: grouping', () => {
  it('groups sessions by the folder they started in, case and separators ignored on Windows', () => {
    const state = stateOf([
      node('s1', { sessionCwd: 'C:\\work\\api', lastEventAt: T0 + 1 }),
      node('s2', { sessionCwd: 'c:/Work/API/', lastEventAt: T0 + 2 }),
      node('s3', { sessionCwd: 'C:\\work\\web', lastEventAt: T0 + 3 }),
    ]);
    const projects = selectProjects(state);
    expect(projects.map((p) => [p.name, ids(p.sessions)])).toEqual([
      ['web', ['s3']],
      ['API', ['s2', 's1']],
    ]);
    expect(projects[1]).toMatchObject({ id: 'c:/work/api', path: 'c:/Work/API/' });
  });

  it('a session in a subfolder of another session folder goes under it', () => {
    const state = stateOf([
      node('s1', { sessionCwd: 'C:\\work\\api' }),
      node('s2', { sessionCwd: 'C:\\work\\api\\src\\db' }),
      node('s3', { sessionCwd: 'C:\\work\\api-old' }),
    ]);
    const projects = selectProjects(state);
    expect(projects.map((p) => [p.id, ids(p.sessions).sort()])).toEqual([
      ['c:/work/api', ['s1', 's2']],
      ['c:/work/api-old', ['s3']],
    ]);
  });

  it('a root, top-level or home folder does not swallow the projects below it', () => {
    const state = stateOf([
      node('s1', { sessionCwd: 'C:\\Users\\me' }),
      node('s2', { sessionCwd: 'C:\\Users\\me\\code\\api' }),
      node('s3', { sessionCwd: 'C:\\projects' }),
      node('s4', { sessionCwd: 'C:\\projects\\web' }),
      node('s5', { sessionCwd: '/home/me' }),
      node('s6', { sessionCwd: '/home/me/tool' }),
    ]);
    expect(
      selectProjects(state)
        .map((p) => p.id)
        .sort(),
    ).toEqual(['/home/me', '/home/me/tool', 'c:/projects', 'c:/projects/web', 'c:/users/me', 'c:/users/me/code/api']);
  });

  it('a worktree run goes under its repository; unknown folder under "No folder"', () => {
    const state = stateOf([
      node('s1', { sessionCwd: 'C:\\work\\api' }),
      node('s2', {
        origin: 'managed',
        sessionCwd: 'C:\\Users\\me\\.huddle\\worktrees\\run-1',
        run: {
          runId: 'run-1',
          templateId: null,
          permissionMode: 'default',
          mainAgent: null,
          agentNames: [],
          worktree: {
            path: 'C:\\Users\\me\\.huddle\\worktrees\\run-1',
            branch: 'huddle/run-1',
            state: 'active',
            repoRoot: 'C:\\work\\api',
          },
        },
      }),
      node('s3', { lastEventAt: T0 - MIN }),
    ]);
    const projects = selectProjects(state);
    expect(projects.map((p) => [p.id, p.name, ids(p.sessions).sort()])).toEqual([
      ['c:/work/api', 'api', ['s1', 's2']],
      [NO_FOLDER_ID, NO_FOLDER, ['s3']],
    ]);
    expect(projects[1]?.path).toBeNull();
  });

  it('falls back to cwd when the start folder is unknown', () => {
    const state = stateOf([node('s1', { cwd: '/srv/web/app' }), node('s2', { sessionCwd: '/srv/web' })]);
    expect(selectProjects(state).map((p) => p.id)).toEqual(['/srv/web']);
  });
});

describe('selectProjects: live and Earlier', () => {
  it('ended and stale sessions are Earlier, most recent first; busy live sessions first', () => {
    const cwd = '/srv/api';
    const state = stateOf([
      node('idle', { sessionCwd: cwd, status: 'idle', lastEventAt: T0 + 50 * MIN }),
      node('busy', { sessionCwd: cwd, status: 'working', lastEventAt: T0 + 40 * MIN }),
      node('ended', { sessionCwd: cwd, status: 'done', endedAt: T0 + 30 * MIN, lastEventAt: T0 + 30 * MIN }),
      node('stale', { sessionCwd: cwd, status: 'working', lastEventAt: T0 - 10 * MIN }),
      node('old', { sessionCwd: cwd, status: 'done', endedAt: T0 - 60 * MIN, lastEventAt: T0 - 60 * MIN }),
    ]);
    const [project] = selectProjects(state, { huddleStartedAt: T0 });
    expect(ids(project?.sessions ?? [])).toEqual(['busy', 'idle']);
    expect(ids(project?.earlier ?? [])).toEqual(['ended', 'stale', 'old']);
    expect(project?.workingCount).toBe(1);
  });

  it('without huddleStartedAt nothing is stale', () => {
    const state = stateOf([node('s1', { sessionCwd: '/srv/api', status: 'working', lastEventAt: T0 - 10 * MIN })]);
    expect(ids(selectProjects(state)[0]?.sessions ?? [])).toEqual(['s1']);
  });
});

describe('selectProjects: counts and order', () => {
  it('working counts agents at work in live sessions; needs you counts waiting agents, not stale ones', () => {
    const state = stateOf([
      node('s1', { sessionCwd: '/srv/api', status: 'working', lastEventAt: T0 + MIN }),
      node('s1::a1', { status: 'starting', lastEventAt: T0 + MIN }),
      node('s1::a2', { status: 'waiting_approval', lastEventAt: T0 + MIN }),
      node('s2', { sessionCwd: '/srv/api', status: 'waiting_answer', lastEventAt: T0 - MIN }),
    ]);
    const [project] = selectProjects(state, { huddleStartedAt: T0 });
    expect(project).toMatchObject({ workingCount: 2, needsYouCount: 1 });
  });

  it('needs you first, then working, then most recent', () => {
    const state = stateOf([
      node('recent', { sessionCwd: '/srv/recent', status: 'idle', lastEventAt: T0 + 9 * MIN }),
      node('working', { sessionCwd: '/srv/working', status: 'working', lastEventAt: T0 + 5 * MIN }),
      node('asks', { sessionCwd: '/srv/asks', status: 'waiting_approval', lastEventAt: T0 + MIN }),
      node('older', { sessionCwd: '/srv/older', status: 'idle', lastEventAt: T0 + 2 * MIN }),
    ]);
    expect(selectProjects(state).map((p) => p.name)).toEqual(['asks', 'working', 'recent', 'older']);
  });
});

describe('harness and empty sessions', () => {
  const ended = { status: 'done' as const, endedAt: T0 + MIN, lastEventAt: T0 + MIN };

  it('an ended empty session or a scratch folder run is hidden unless showAll', () => {
    const state = stateOf([
      node('real', { sessionCwd: '/srv/api', ...ended, lastPrompt: 'fix it' }),
      node('empty', { sessionCwd: '/srv/api', ...ended, toolCalls: 0 }),
      node('rec', { sessionCwd: 'C:\\Users\\me\\AppData\\Local\\Temp\\huddle-s18-work-ab12cd', ...ended }),
      node('tmp', { sessionCwd: '/tmp/huddle-m3-work-a1b2c3', ...ended }),
    ]);
    const projects = selectProjects(state);
    expect(projects.map((p) => [p.id, ids(p.earlier), p.hiddenCount])).toEqual([['/srv/api', ['real'], 1]]);
    expect(selectHiddenSessionCount(state)).toBe(3);
    const all = selectProjects(state, { showAll: true });
    expect(all.flatMap((p) => ids(p.earlier)).sort()).toEqual(['empty', 'real', 'rec', 'tmp']);
    expect(all.every((p) => p.hiddenCount === 0)).toBe(true);
    expect(selectHiddenSessionCount(state, { showAll: true })).toBe(0);
  });

  it('a live session is never hidden, even an empty one or one in a scratch folder', () => {
    const state = stateOf([
      node('starting', { sessionCwd: '/srv/api', status: 'starting', toolCalls: 0 }),
      node('s18', { sessionCwd: 'C:\\Temp\\huddle-s18-work-zz99yy', status: 'working' }),
    ]);
    expect(
      selectProjects(state)
        .flatMap((p) => ids(p.sessions))
        .sort(),
    ).toEqual(['s18', 'starting']);
    expect(selectHiddenSessionCount(state)).toBe(0);
  });

  it('isHarnessSession: a prompt, a tool call or a subagent makes a session real', () => {
    const state = stateOf([
      node('empty', { toolCalls: 0, sessionCwd: '/w' }),
      node('prompted', { toolCalls: 0, sessionCwd: '/w', firstPrompt: 'hello' }),
      node('tools', { toolCalls: 1, sessionCwd: '/w' }),
      node('team', { toolCalls: 0, sessionCwd: '/w' }),
      node('team::a1', { toolCalls: 0 }),
    ]);
    const harness = selectTree(state)
      .filter((v) => isHarnessSession(state, v))
      .map((v) => v.sessionId);
    expect(harness).toEqual(['empty']);
  });
});

describe('selectHomeCounts', () => {
  it('working, needs you (= selectNeedsYouCount) and open stuck or loop items, stale left out', () => {
    const state = stateOf(
      [
        node('s1', { status: 'working', lastEventAt: T0 + MIN }),
        node('s1::a1', { status: 'waiting_answer', lastEventAt: T0 + MIN }),
        node('s2', { status: 'working', lastEventAt: T0 - MIN }),
        node('s3', { status: 'done', endedAt: T0 + MIN, lastEventAt: T0 + MIN }),
      ],
      [
        item('i1', 's1'),
        item('i2', 's1::a1', { kind: 'loop' }),
        item('i3', 's1', { resolvedAt: T0 + MIN }),
        item('i4', 's1', { dismissed: true }),
        item('i5', 's1', { kind: 'budget' }),
        item('i6', 's2'),
        item('i7', 'gone'),
      ],
    );
    const opts = { huddleStartedAt: T0 };
    expect(selectHomeCounts(state, opts)).toEqual({ working: 1, needsYou: selectNeedsYouCount(state, opts), stuck: 3 });
    expect(selectHomeCounts(state, opts).needsYou).toBe(1);
    expect(selectHomeCounts(state)).toMatchObject({ working: 2, stuck: 4 });
  });
});

describe('review fixes', () => {
  const ended = { status: 'done' as const, endedAt: T0 + MIN, lastEventAt: T0 + MIN };

  it('a hidden harness session neither takes other sessions in nor names the project; ids do not change with showAll', () => {
    const state = stateOf([
      node('harness', { sessionCwd: '/srv/api', ...ended, toolCalls: 0 }),
      node('real', { sessionCwd: '/srv/api/web', lastPrompt: 'fix it' }),
    ]);
    const hidden = selectProjects(state);
    expect(hidden.map((p) => [p.id, p.name, ids(p.sessions)])).toEqual([['/srv/api/web', 'web', ['real']]]);
    const all = selectProjects(state, { showAll: true });
    expect(all.map((p) => p.id).sort()).toEqual(['/srv/api', '/srv/api/web']);
  });

  it.each([
    ['C:\\Users\\me\\Documents', true],
    ['C:\\Users\\me\\Desktop', true],
    ['C:\\Users\\me\\Downloads', true],
    ['C:\\Users\\me\\source', true],
    ['C:\\Users\\me\\source\\repos', true],
    ['C:\\Users\\me\\repos', true],
    ['C:\\Users\\me\\OneDrive', true],
    ['C:\\Users\\me\\OneDrive - Contoso', true],
    ['C:\\Users\\me\\OneDrive\\Documents', true],
    ['\\\\server\\share', true],
    ['/mnt/c', true],
    ['/mnt/c/Users/me', true],
    ['/mnt/c/Users/me/Documents', true],
    ['/Users/me/Desktop', true],
    ['C:\\Users\\me\\source\\repos\\api', false],
    ['C:\\Users\\me\\Documents\\thesis', false],
    ['\\\\server\\share\\team', false],
    ['/mnt/c/work/api', false],
    ['/srv/web', false],
  ])('isTooBroadFolder(%s) = %s', (path, broad) => {
    expect(isTooBroadFolder(projectKey(path) ?? '')).toBe(broad);
  });

  it('a session in a broad folder does not swallow the projects below it', () => {
    const state = stateOf([
      node('docs', { sessionCwd: 'C:\\Users\\me\\Documents' }),
      node('thesis', { sessionCwd: 'C:\\Users\\me\\Documents\\thesis' }),
      node('repos', { sessionCwd: 'C:\\Users\\me\\source\\repos' }),
      node('api', { sessionCwd: 'C:\\Users\\me\\source\\repos\\api\\src' }),
      node('share', { sessionCwd: '\\\\server\\share' }),
      node('team', { sessionCwd: '\\\\server\\share\\team' }),
    ]);
    expect(
      selectProjects(state)
        .map((p) => p.id)
        .sort(),
    ).toEqual([
      '//server/share',
      '//server/share/team',
      'c:/users/me/documents',
      'c:/users/me/documents/thesis',
      'c:/users/me/source/repos',
      'c:/users/me/source/repos/api/src',
    ]);
  });

  it('only the scripts own scratch folders are harness: D:\\Temp\\huddle-notes is a real project', () => {
    const state = stateOf([
      node('notes', { sessionCwd: 'D:\\Temp\\huddle-notes', ...ended }),
      node('wt', { sessionCwd: 'C:\\Temp\\huddle-s16-wt-a1b2c3d4', ...ended }),
      node('m4', { sessionCwd: 'C:\\Users\\me\\AppData\\Local\\Temp\\huddle-m4-repo-Ab12Cd\\src', ...ended }),
      node('s17', { sessionCwd: '/tmp/huddle-s17-repo-x1y2z3', ...ended }),
    ]);
    const harness = selectTree(state)
      .filter((v) => isHarnessSession(state, v))
      .map((v) => v.sessionId)
      .sort();
    expect(harness).toEqual(['m4', 's17', 'wt']);
  });

  it('a session waiting on the user is never hidden, and the needs-you counts add up', () => {
    const state = stateOf([
      node('rec', { sessionCwd: '/tmp/huddle-s18-work-a1b2c3', status: 'waiting_approval', lastEventAt: T0 - MIN }),
      node('real', { sessionCwd: '/srv/api', status: 'waiting_answer' }),
      node('real::a1', { status: 'waiting_approval' }),
    ]);
    // Stale (before the Huddle started): not live, but waiting, so shown; stale waits are not counted.
    const projects = selectProjects(state, { huddleStartedAt: T0 - 30_000 });
    expect(projects.flatMap((p) => ids([...p.sessions, ...p.earlier])).sort()).toEqual(['real', 'rec']);
    const sum = projects.reduce((n, p) => n + p.needsYouCount, 0);
    expect(sum).toBe(selectHomeCounts(state, { huddleStartedAt: T0 - 30_000 }).needsYou);
    const ended2 = stateOf([
      node('rec', { sessionCwd: '/tmp/huddle-s18-work-a1b2c3', status: 'done', endedAt: T0 }),
      node('rec::a1', { status: 'waiting_answer' }),
    ]);
    expect(selectProjects(ended2).flatMap((p) => ids(p.earlier))).toEqual(['rec']);
    expect(selectHiddenSessionCount(ended2)).toBe(0);
    expect(selectProjects(ended2).reduce((n, p) => n + p.needsYouCount, 0)).toBe(selectNeedsYouCount(ended2));
  });

  it('stuck and loop items of ended sessions are not counted', () => {
    const state = stateOf(
      [node('live', { status: 'working' }), node('gone', { ...ended })],
      [item('i1', 'live'), item('i2', 'gone'), item('i3', 'gone', { kind: 'loop' })],
    );
    expect(selectHomeCounts(state).stuck).toBe(1);
  });

  it('empty means: start seen, nothing done, and over within a minute; a late-attached or long-open session is real', () => {
    const tree = (n: AgentNode) => {
      const state = stateOf([n]);
      const [view] = selectTree(state);
      if (view === undefined) throw new Error('no view');
      return isHarnessSession(state, view);
    };
    const bare = { toolCalls: 0, status: 'done' as const };
    expect(tree(node('quick', { ...bare, sessionCwd: '/w', endedAt: T0 + 30_000, lastEventAt: T0 + 30_000 }))).toBe(
      true,
    );
    expect(tree(node('long', { ...bare, sessionCwd: '/w', endedAt: T0 + 10 * MIN, lastEventAt: T0 + 10 * MIN }))).toBe(
      false,
    );
    // Attached late: the Huddle never saw its SessionStart, only its end (no start folder).
    expect(tree(node('late', { ...bare, cwd: '/w', endedAt: T0, lastEventAt: T0 }))).toBe(false);
  });
});
