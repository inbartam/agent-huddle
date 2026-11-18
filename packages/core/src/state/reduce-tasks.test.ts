/**
 * Task list from a real run (spike S4b, `fixtures/tasks-enabled.jsonl`): with CLAUDE_CODE_ENABLE_TODO_TOOLS=1 the
 * TaskCreated/TaskCompleted hooks fire, and the main agent's progress uses basis 'tasks' (ADR-010 update).
 * PostToolUse(TaskUpdate, in_progress) gives task.started, so the task being worked on is known (selectCurrentTask).
 */
import { describe, expect, it } from 'vitest';
import {
  agentKey,
  selectCurrentTask,
  selectProgress,
  type AgentNode,
  type EventOfType,
  type HuddleEvent,
} from '@huddle/shared';
import { fixtureEvents } from '../test/replay-fixture.js';
import { initialState, MAX_TASKS_PER_AGENT, reduce, replay, type ReducerState } from './reduce.js';

function mainOf(state: ReducerState): AgentNode {
  const main = Object.values(state.agents).find((a): a is AgentNode => a.kind === 'main');
  if (main === undefined) throw new Error('no main agent');
  return main;
}

describe('task list from fixtures/tasks-enabled.jsonl', () => {
  const events = fixtureEvents('tasks-enabled.jsonl');
  const state = replay(events);
  const main = Object.values(state.agents).find((a): a is AgentNode => a.kind === 'main');

  it('records three tasks with their subjects, all completed', () => {
    expect(main).toBeDefined();
    if (main === undefined) return;
    expect(main.tasks.map((t) => [t.id, t.status])).toEqual([
      ['1', 'completed'],
      ['2', 'completed'],
      ['3', 'completed'],
    ]);
    expect(main.tasks.every((t) => t.subject.length > 0)).toBe(true);
  });

  it('reports progress on basis tasks: 3 of 3', () => {
    if (main === undefined) throw new Error('no main agent');
    const last = events[events.length - 1];
    const progress = selectProgress(state, main.key, last === undefined ? 0 : last.ts);
    expect(progress?.basis).toBe('tasks');
    expect(progress?.completedTasks).toBe(3);
    expect(progress?.totalTasks).toBe(3);
  });
});

describe('task in progress from fixtures/tasks-enabled.jsonl', () => {
  const events = fixtureEvents('tasks-enabled.jsonl');
  const started = events.filter((e): e is EventOfType<'task.started'> => e.type === 'task.started');

  it('normalizes three task.started events, one per task', () => {
    expect(started.map((e) => e.taskId)).toEqual(['1', '2', '3']);
  });

  it('shows task 1 after the first start, task 2 just after the second', () => {
    const upTo = (event: HuddleEvent | undefined) => {
      if (event === undefined) throw new Error('missing task.started');
      return replay(events.slice(0, events.indexOf(event) + 1));
    };
    expect(selectCurrentTask(mainOf(upTo(started[0])))?.id).toBe('1');
    const second = mainOf(upTo(started[1]));
    expect(selectCurrentTask(second)?.id).toBe('2');
    expect(second.tasks.map((t) => [t.id, t.status, t.startedAt !== undefined])).toEqual([
      ['1', 'completed', true],
      ['2', 'pending', true],
      ['3', 'pending', false],
    ]);
  });

  it('has no current task once all three are completed', () => {
    expect(selectCurrentTask(mainOf(replay(events)))).toBeNull();
  });
});

describe('task.started in the reducer', () => {
  const S = 'session-t';
  const MAIN = agentKey(S);
  let n = 0;
  function ev<T extends HuddleEvent['type']>(
    type: T,
    fields: Omit<EventOfType<T>, 'id' | 'type' | 'ts' | 'sessionId' | 'agentKey' | 'source'>,
  ): HuddleEvent {
    n += 1;
    return {
      id: `t${String(n)}`,
      type,
      ts: 1000 + n * 10,
      sessionId: S,
      agentKey: MAIN,
      source: 'hook',
      ...fields,
    } as unknown as HuddleEvent;
  }
  const created = (taskId: string) => ev('task.created', { taskId, subject: `Task ${taskId}`, description: null });
  const task = (state: ReducerState, id: string) => mainOf(state).tasks.find((t) => t.id === id);

  it('stamps startedAt on a pending task, then completes it', () => {
    let state = replay([
      ev('session.started', { origin: 'attached', cwd: null, title: null, model: null, startKind: 'startup' }),
      created('1'),
    ]);
    const start = ev('task.started', { taskId: '1' });
    state = reduce(state, start);
    expect(task(state, '1')).toMatchObject({ status: 'pending', startedAt: start.ts });
    expect(mainOf(state).lastEventAt).toBe(start.ts);
    expect(selectCurrentTask(mainOf(state))?.id).toBe('1');
    const done = ev('task.completed', { taskId: '1' });
    state = reduce(state, done);
    expect(task(state, '1')).toMatchObject({ status: 'completed', startedAt: start.ts, completedAt: done.ts });
    expect(selectCurrentTask(mainOf(state))).toBeNull();
  });

  it('leaves the state unchanged for an unknown task id, an unknown agent, or a completed task', () => {
    const state = replay([created('1'), ev('task.completed', { taskId: '1' })]);
    expect(reduce(state, ev('task.started', { taskId: 'nope' }))).toBe(state);
    expect(reduce(state, ev('task.started', { taskId: '1' }))).toBe(state);
    const empty = initialState();
    expect(reduce(empty, ev('task.started', { taskId: '1' }))).toBe(empty);
  });

  it('keeps startedAt when the same task is created again', () => {
    let state = replay([created('1')]);
    const start = ev('task.started', { taskId: '1' });
    state = reduce(state, start);
    state = reduce(state, created('1'));
    expect(task(state, '1')).toMatchObject({ status: 'pending', startedAt: start.ts });
    expect(mainOf(state).tasks).toHaveLength(1);
  });

  it('moves startedAt to the latest start of the same task', () => {
    let state = replay([
      created('1'),
      created('2'),
      ev('task.started', { taskId: '1' }),
      ev('task.started', { taskId: '2' }),
    ]);
    expect(selectCurrentTask(mainOf(state))?.id).toBe('2');
    const again = ev('task.started', { taskId: '1' });
    state = reduce(state, again);
    expect(task(state, '1')?.startedAt).toBe(again.ts);
    expect(selectCurrentTask(mainOf(state))?.id).toBe('1');
  });
});

describe('task list cap (MAX_TASKS_PER_AGENT)', () => {
  const S = 'session-cap';
  const MAIN = agentKey(S);
  let n = 0;
  function ev(type: HuddleEvent['type'], fields: Record<string, unknown>): HuddleEvent {
    n += 1;
    return {
      id: `c${String(n)}`,
      type,
      ts: 1000 + n,
      sessionId: S,
      agentKey: MAIN,
      source: 'hook',
      ...fields,
    } as HuddleEvent;
  }
  const created = (id: string) => ev('task.created', { taskId: id, subject: `task ${id}`, description: null });
  const completed = (id: string) => ev('task.completed', { taskId: id });

  it('keeps at most MAX_TASKS_PER_AGENT tasks, dropping the oldest completed first, then the oldest', () => {
    const events: HuddleEvent[] = [];
    // Tasks 0..9 completed, the rest pending; then enough new ones to pass the cap by 15.
    for (let i = 0; i < MAX_TASKS_PER_AGENT + 15; i++) events.push(created(String(i)));
    for (let i = 0; i < 10; i++) events.push(completed(String(i)));
    let state = initialState();
    // Interleave so the completions land before the cap is passed.
    const early = events.filter((e) => e.type === 'task.created').slice(0, 10);
    const done = events.filter((e) => e.type === 'task.completed');
    const late = events.filter((e) => e.type === 'task.created').slice(10);
    for (const e of [...early, ...done, ...late]) state = reduce(state, e);
    const ids = mainOf(state).tasks.map((t) => t.id);
    expect(ids).toHaveLength(MAX_TASKS_PER_AGENT);
    // The 10 completed went first, then the 5 oldest pending (10..14).
    expect(ids[0]).toBe('15');
    expect(ids.at(-1)).toBe(String(MAX_TASKS_PER_AGENT + 14));
    expect(mainOf(state).tasks.every((t) => t.status === 'pending')).toBe(true);
  });
});
