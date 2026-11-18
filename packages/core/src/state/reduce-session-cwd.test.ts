/**
 * `AgentNode.sessionCwd` (M4, F18, security review 2026-11-14): the trusted session folder approval rules contain
 * allows in. Set once; a later hook never moves it; `run.launched` (the Huddle chose the folder) is authoritative.
 */
import { describe, expect, it } from 'vitest';
import { agentKey, type HuddleEvent } from '@huddle/shared';
import { listFixtureFiles } from '../test/fixtures.js';
import { fixtureEvents } from '../test/replay-fixture.js';
import { initialState, reduce, replay, type ReducerState } from './reduce.js';

const S = 'session-1';
const MAIN = agentKey(S);
let n = 0;

function started(cwd: string | null, startKind = 'startup'): HuddleEvent {
  n += 1;
  return {
    id: `s${String(n)}`,
    type: 'session.started',
    ts: 1000 + n,
    sessionId: S,
    agentKey: MAIN,
    source: 'hook',
    origin: 'attached',
    cwd,
    title: null,
    model: null,
    startKind,
  } as HuddleEvent;
}

function launched(cwd: string, worktree: { path: string; branch: string } | null = null): HuddleEvent {
  n += 1;
  return {
    id: `l${String(n)}`,
    type: 'run.launched',
    ts: 1000 + n,
    sessionId: S,
    agentKey: MAIN,
    source: 'huddle',
    runId: 'run-1',
    claudeSessionId: S,
    templateId: null,
    cwd,
    model: null,
    permissionMode: 'default',
    mainAgent: null,
    agentNames: [],
    worktree,
  };
}

function fold(events: HuddleEvent[]): ReducerState {
  return events.reduce((s, e) => reduce(s, e), initialState());
}

describe('sessionCwd', () => {
  it('is the first session.started cwd; a later SessionStart (compact, after a cd) moves cwd but not sessionCwd', () => {
    const state = fold([started('C:/repo'), started('C:/elsewhere', 'compact')]);
    expect(state.agents[MAIN]).toMatchObject({ cwd: 'C:/elsewhere', sessionCwd: 'C:/repo' });
  });

  it('waits for a session.started that carries a cwd', () => {
    const state = fold([started(null), started('C:/repo', 'resume')]);
    expect(state.agents[MAIN]?.sessionCwd).toBe('C:/repo');
  });

  it('run.launched is authoritative, before or after the hook; a worktree path wins over cwd', () => {
    expect(fold([started('C:/agent-said'), launched('C:/repo')]).agents[MAIN]?.sessionCwd).toBe('C:/repo');
    expect(fold([launched('C:/repo'), started('C:/agent-said')]).agents[MAIN]?.sessionCwd).toBe('C:/repo');
    const wt = { path: 'C:/data/worktrees/run-1', branch: 'huddle/run-1' };
    expect(fold([launched('C:/repo', wt), started('C:/repo')]).agents[MAIN]?.sessionCwd).toBe(wt.path);
  });

  it('every fixture replay gives each root its first reported cwd and no subagent a sessionCwd', () => {
    for (const file of listFixtureFiles()) {
      const events = fixtureEvents(file);
      const state = replay(events);
      for (const node of Object.values(state.agents)) {
        if (node.kind !== 'main') {
          expect(node.sessionCwd ?? null, file).toBeNull();
          continue;
        }
        const first = events.find(
          (e) => e.type === 'session.started' && e.sessionId === node.sessionId && e.cwd !== null,
        );
        const want = first?.type === 'session.started' ? first.cwd : null;
        expect(node.sessionCwd ?? null, file).toBe(want);
      }
    }
  });
});

function prompt(cwd: string | undefined): HuddleEvent {
  n += 1;
  return {
    id: `p${String(n)}`,
    type: 'prompt.submitted',
    ts: 1000 + n,
    sessionId: S,
    agentKey: MAIN,
    source: 'hook',
    text: 'go on',
    promptId: null,
    kind: 'user',
    ...(cwd !== undefined ? { cwd } : {}),
  };
}

describe('a session first seen mid-run (no SessionStart) learns its folder from a prompt (2026-11-18)', () => {
  it('sets cwd from the first prompt that carries one, never sessionCwd', () => {
    const state = fold([prompt(undefined), prompt('C:/repo'), prompt('C:/elsewhere')]);
    expect(state.agents[MAIN]?.cwd).toBe('C:/repo');
    expect(state.agents[MAIN]?.sessionCwd ?? null).toBeNull();
  });

  it('a folder from SessionStart wins; a prompt never replaces it', () => {
    const state = fold([started('C:/repo'), prompt('C:/elsewhere')]);
    expect(state.agents[MAIN]).toMatchObject({ cwd: 'C:/repo', sessionCwd: 'C:/repo' });
  });
});
