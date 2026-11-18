/**
 * F29: the reducer's task list (`huddle_task.*`), the shared selector that derives a task's status from its run, the
 * event schemas, and a fixture replay with task events mixed in (the tree must not change).
 */
import { describe, expect, it } from 'vitest';
import {
  HUDDLE_TASK_TITLE_MAX,
  MAX_HUDDLE_TASKS,
  selectHuddleTasks,
  TASKS_SESSION_ID,
  type EventOfType,
  type HuddleEvent,
} from '@huddle/shared';
import { parseHuddleTaskEvent } from '../contracts/orch-schemas.js';
import { fixtureEvents } from '../test/replay-fixture.js';
import { listFixtureFiles } from '../test/fixtures.js';
import { HUDDLE_SESSION_IDS } from './huddle-sessions.js';
import { initialState, reduce, replay, toHuddleState } from './reduce.js';

type Fields<T extends HuddleEvent['type']> = Omit<
  EventOfType<T>,
  'id' | 'type' | 'ts' | 'sessionId' | 'agentKey' | 'source'
>;

let n = 0;
function ev<T extends HuddleEvent['type']>(
  type: T,
  fields: Fields<T>,
  at: { sessionId?: string; source?: HuddleEvent['source']; ts?: number } = {},
): HuddleEvent {
  n += 1;
  const sessionId = at.sessionId ?? TASKS_SESSION_ID;
  return {
    id: `t${String(n).padStart(4, '0')}`,
    type,
    ts: at.ts ?? 5000 + n * 10,
    sessionId,
    agentKey: sessionId,
    source: at.source ?? 'user',
    ...fields,
  } as unknown as HuddleEvent;
}

const created = (taskId: string, extra: Partial<Fields<'huddle_task.created'>> = {}) =>
  ev('huddle_task.created', {
    taskId,
    title: 'Fix the login test',
    details: 'It fails on Windows.',
    projectPath: 'C:/projects/app',
    templateId: null,
    ...extra,
  });

describe('huddle_task reducer (F29)', () => {
  it('adds, updates field by field and deletes a task', () => {
    const state = replay([
      created('task-1'),
      ev('huddle_task.updated', { taskId: 'task-1', title: 'Fix the login test now' }),
      ev('huddle_task.updated', { taskId: 'task-1', runId: 'run-1', status: 'running', launchedAt: 7000 }),
      created('task-2', { title: 'Second' }),
      ev('huddle_task.deleted', { taskId: 'task-2' }),
    ]);
    expect(state.huddleTasks).toHaveLength(1);
    const t = state.huddleTasks?.[0];
    expect(t).toMatchObject({
      taskId: 'task-1',
      title: 'Fix the login test now',
      details: 'It fails on Windows.',
      projectPath: 'C:/projects/app',
      status: 'running',
      runId: 'run-1',
      launchedAt: 7000,
    });
    expect(t?.updatedAt).toBeGreaterThan(t?.createdAt ?? Infinity);
    // The task list crosses IPC; the tree stays empty (the tasks session is never a node).
    expect(toHuddleState(state).huddleTasks).toEqual(state.huddleTasks);
    expect(state.rootKeys).toEqual([]);
    expect(Object.keys(state.agents)).toEqual([]);
  });

  it('ignores a second created, unknown ids, bad statuses and wrong types; clips text', () => {
    const before = replay([created('task-1')]);
    const same = [
      created('task-1', { title: 'other' }),
      ev('huddle_task.updated', { taskId: 'nope', title: 'x' }),
      ev('huddle_task.deleted', { taskId: 'nope' }),
    ];
    let state = before;
    for (const e of same) state = reduce(state, e);
    expect(state.huddleTasks).toEqual(before.huddleTasks);

    const odd = {
      ...ev('huddle_task.updated', { taskId: 'task-1' }),
      status: 'exploded',
      title: 42,
      launchedAt: 'soon',
    } as unknown as HuddleEvent;
    state = reduce(state, odd);
    expect(state.huddleTasks?.[0]).toMatchObject({ status: 'todo', title: 'Fix the login test', launchedAt: null });

    const long = replay([created('task-9', { title: 'x'.repeat(HUDDLE_TASK_TITLE_MAX + 50) })]);
    expect(long.huddleTasks?.[0]?.title).toHaveLength(HUDDLE_TASK_TITLE_MAX);
  });

  it('keeps at most MAX_HUDDLE_TASKS, oldest first out', () => {
    const events = Array.from({ length: MAX_HUDDLE_TASKS + 3 }, (_, i) => created(`task-${String(i)}`));
    const state = replay(events);
    expect(state.huddleTasks).toHaveLength(MAX_HUDDLE_TASKS);
    expect(state.huddleTasks?.[0]?.taskId).toBe('task-3');
  });

  it('is pure: frozen inputs, JSON-safe output, unknown types unchanged', () => {
    const events = [created('task-1'), ev('huddle_task.updated', { taskId: 'task-1', status: 'done' })];
    let frozen = initialState();
    for (const e of events) frozen = reduce(Object.freeze(frozen), Object.freeze(structuredClone(e)));
    expect(frozen).toEqual(replay(events));
    expect(JSON.parse(JSON.stringify(frozen))).toEqual(frozen);
    const unknown = { ...created('task-x'), type: 'huddle_task.renamed' } as unknown as HuddleEvent;
    expect(reduce(frozen, unknown).huddleTasks).toEqual(frozen.huddleTasks);
  });

  it('the tasks session is one of the Huddle sessions (never pruned, never a run)', () => {
    expect(HUDDLE_SESSION_IDS).toContain(TASKS_SESSION_ID);
  });
});

describe('selectHuddleTasks: status from the linked run', () => {
  const RUN = '11111111-2222-4333-8444-555555555555';
  const launched = ev(
    'run.launched',
    {
      runId: RUN,
      claudeSessionId: RUN,
      templateId: null,
      cwd: 'C:/projects/app',
      model: null,
      permissionMode: 'default',
      mainAgent: null,
      agentNames: [],
      worktree: null,
    },
    { sessionId: RUN, source: 'huddle' },
  );
  const link = ev('huddle_task.updated', { taskId: 'task-1', runId: RUN, status: 'running', launchedAt: 6000 });

  it('running while the run is alive, done or failed by how it exited', () => {
    const base = [created('task-1'), launched, link];
    expect(selectHuddleTasks(replay(base))[0]).toMatchObject({ status: 'running', runRootKey: RUN });
    const exit = (how: EventOfType<'run.exited'>['how']) =>
      ev('run.exited', { runId: RUN, exitCode: how === 'completed' ? 0 : 1, how, error: null }, { sessionId: RUN });
    expect(selectHuddleTasks(replay([...base, exit('completed')]))[0]?.status).toBe('done');
    expect(selectHuddleTasks(replay([...base, exit('failed')]))[0]?.status).toBe('failed');
    expect(selectHuddleTasks(replay([...base, exit('stopped')]))[0]?.status).toBe('failed');
  });

  it('a mark the user makes after the run ended wins ("Mark done" on a failed run, "Reopen" on a done one)', () => {
    const base = [created('task-1'), launched, link];
    const failedExit = ev('run.exited', { runId: RUN, exitCode: 1, how: 'failed', error: null }, { sessionId: RUN });
    const markDone = ev('huddle_task.updated', { taskId: 'task-1', status: 'done' });
    expect(selectHuddleTasks(replay([...base, failedExit, markDone]))[0]?.status).toBe('done');
    const doneExit = ev('run.exited', { runId: RUN, exitCode: 0, how: 'completed', error: null }, { sessionId: RUN });
    const reopen = ev('huddle_task.updated', { taskId: 'task-1', status: 'todo' });
    expect(selectHuddleTasks(replay([...base, doneExit, reopen]))[0]?.status).toBe('todo');
    // A mark made while the run was still alive does not hide the run's outcome.
    const early = ev('huddle_task.updated', { taskId: 'task-1', status: 'done' });
    const laterFail = ev('run.exited', { runId: RUN, exitCode: 1, how: 'failed', error: null }, { sessionId: RUN });
    expect(selectHuddleTasks(replay([...base, early, laterFail]))[0]?.status).toBe('failed');
  });

  it('falls back to the recorded status when the run is not in the state', () => {
    const state = replay([created('task-1'), link, ev('huddle_task.updated', { taskId: 'task-1', status: 'done' })]);
    expect(selectHuddleTasks(state)[0]).toMatchObject({ status: 'done', runRootKey: null });
  });

  it('newest first', () => {
    const state = replay([created('a', { title: 'A' }), created('b', { title: 'B' })]);
    expect(selectHuddleTasks(state).map((t) => t.taskId)).toEqual(['b', 'a']);
  });
});

describe('huddle_task event schemas', () => {
  it('accept what the core writes, clip long text, refuse a wrong shape', () => {
    const e = created('task-1');
    expect(parseHuddleTaskEvent(e)).toEqual(e);
    const long = { ...e, details: 'd'.repeat(10_000) };
    expect((parseHuddleTaskEvent(long) as EventOfType<'huddle_task.created'> | null)?.details.length).toBe(4000);
    expect(parseHuddleTaskEvent({ ...e, taskId: '' })).toBeNull();
    expect(parseHuddleTaskEvent({ ...e, type: 'task.created' })).toBeNull();
    const upd = ev('huddle_task.updated', { taskId: 'task-1', status: 'done' });
    expect(parseHuddleTaskEvent(upd)).toEqual(upd);
    expect(parseHuddleTaskEvent({ ...upd, status: 'exploded' })).toBeNull();
  });
});

describe('fixtures with task events mixed in', () => {
  it.each(listFixtureFiles())('%s: tasks never change the tree, and a log without them has none', (name) => {
    const recorded = fixtureEvents(name);
    const plain = replay(recorded);
    expect(plain.huddleTasks).toBeUndefined();
    const mixed: HuddleEvent[] = [];
    recorded.forEach((e, i) => {
      mixed.push(e);
      if (i === 0) mixed.push(created('task-f', { title: 'Watch this run' }));
      if (i === Math.floor(recorded.length / 2))
        mixed.push(ev('huddle_task.updated', { taskId: 'task-f', status: 'done' }));
    });
    const state = replay(mixed);
    expect(state.agents).toEqual(plain.agents);
    expect(state.rootKeys).toEqual(plain.rootKeys);
    expect(state.inbox).toEqual(plain.inbox);
    expect(state.huddleTasks).toHaveLength(1);
    expect(state.huddleTasks?.[0]?.status).toBe(recorded.length > 1 ? 'done' : 'todo');
  });
});
