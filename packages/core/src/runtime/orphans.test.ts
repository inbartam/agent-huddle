/** Orphan reconciliation decisions (pure): candidates from the replayed state and runs.json, and what is done to each. */
import { describe, expect, it } from 'vitest';
import type { HuddleEvent } from '@huddle/shared';
import { initialState, reduce, type ReducerState } from '../state/reduce.js';
import {
  checkProcess,
  commandLineIsRun,
  decideOrphans,
  ORPHAN_ENDED,
  ORPHAN_NOT_CHECKED,
  ORPHAN_STOPPED,
  orphanCandidates,
  pidsToCheck,
} from './orphans.js';
import type { RunRegistryEntry } from './run-registry.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const D = '44444444-4444-4444-8444-444444444444';
const E = '55555555-5555-4555-8555-555555555555';

let n = 0;
function ev(type: string, runId: string, fields: Record<string, unknown>): HuddleEvent {
  n += 1;
  return {
    id: `e${String(n)}`,
    type,
    ts: 1_000 + n,
    sessionId: runId,
    agentKey: runId,
    source: 'huddle',
    ...fields,
  } as unknown as HuddleEvent;
}

function launched(runId: string, worktreePath: string | null = null): HuddleEvent {
  return ev('run.launched', runId, {
    runId,
    claudeSessionId: runId,
    templateId: null,
    cwd: worktreePath ?? 'C:\\repo',
    model: null,
    permissionMode: 'default',
    mainAgent: null,
    agentNames: [],
    worktree: worktreePath === null ? null : { path: worktreePath, branch: `huddle/${runId}` },
  });
}

function exited(runId: string): HuddleEvent {
  return ev('run.exited', runId, { runId, exitCode: 0, how: 'completed', error: null });
}

function stateOf(...events: HuddleEvent[]): ReducerState {
  return events.reduce(reduce, initialState());
}

function entry(runId: string, pid: number): RunRegistryEntry {
  return { runId, pid, startedAt: 1, command: 'C:\\bin\\claude.exe' };
}

const line = (runId: string) => `"C:\\bin\\claude.exe" -p --input-format stream-json --session-id ${runId} --verbose`;

describe('commandLineIsRun', () => {
  it('needs --session-id and the run id as whole tokens', () => {
    expect(commandLineIsRun(line(A), A)).toBe(true);
    expect(commandLineIsRun(line(A).toUpperCase(), A)).toBe(true);
    expect(commandLineIsRun(`claude --session-id "${A}"`, A)).toBe(true);
    expect(commandLineIsRun(`claude --session-id=${A}`, A)).toBe(true);
    expect(commandLineIsRun(`claude --session-id ${A}0`, A)).toBe(false);
    expect(commandLineIsRun(`claude --session-id x${A}`, A)).toBe(false);
    expect(commandLineIsRun(`claude --resume ${A}`, A)).toBe(false);
    expect(commandLineIsRun(`claude ${A}`, A)).toBe(false);
    expect(commandLineIsRun(`claude --my-session-id ${A}`, A)).toBe(false);
    expect(commandLineIsRun(line(B), A)).toBe(false);
    expect(commandLineIsRun('claude --session-id .*', '.*')).toBe(false);
  });
});

describe('checkProcess', () => {
  it('ours, gone, other (pid reused), unknown (no list, or no command line)', () => {
    const lines = new Map<number, string | null>([
      [10, line(A)],
      [11, 'C:\\Windows\\notepad.exe'],
      [12, null],
    ]);
    expect(checkProcess(10, A, lines)).toBe('ours');
    expect(checkProcess(11, A, lines)).toBe('other');
    expect(checkProcess(12, A, lines)).toBe('unknown');
    expect(checkProcess(13, A, lines)).toBe('gone');
    expect(checkProcess(10, A, null)).toBe('unknown');
  });
});

describe('orphanCandidates and decideOrphans', () => {
  it('registry entries and replayed runs without run.exited; each gets the right ending', () => {
    const state = stateOf(
      launched(A, 'C:\\wt\\a'),
      launched(B),
      launched(C),
      exited(C),
      launched(D),
      launched(E, 'C:\\wt\\e'),
    );
    // A: alive and ours. B: pid reused. C: exited in the log (pid never looked at). D: no registry entry.
    // E: its pid is running but its command line cannot be read. And one entry for a run the log does not know.
    const unknownRun = '66666666-6666-4666-8666-666666666666';
    const entries = [entry(A, 10), entry(B, 11), entry(C, 12), entry(E, 14), entry(unknownRun, 15)];
    const candidates = orphanCandidates(state, entries);
    expect(candidates.map((c) => [c.runId, c.pid, c.exitedInLog, c.worktreePath])).toEqual([
      [A, 10, false, 'C:\\wt\\a'],
      [B, 11, false, null],
      [C, 12, true, null],
      [E, 14, false, 'C:\\wt\\e'],
      [unknownRun, 15, false, null],
      [D, null, false, null],
    ]);
    expect(pidsToCheck(candidates)).toEqual([10, 11, 14, 15]);

    const lines = new Map<number, string | null>([
      [10, line(A)],
      [11, 'C:\\Program Files\\Something\\other.exe --flag'],
      [12, line(C)], // a process with C's id is running, but the log says C exited: left alone
      [14, null],
      [15, line(unknownRun)],
    ]);
    const decisions = decideOrphans(candidates, lines);
    expect(decisions.map((d) => [d.runId, d.check, d.kill, d.exitedError])).toEqual([
      [A, 'ours', 10, ORPHAN_STOPPED],
      [B, 'other', null, ORPHAN_ENDED],
      [C, 'exited', null, null],
      [E, 'unknown', null, ORPHAN_NOT_CHECKED],
      [unknownRun, 'ours', 15, ORPHAN_STOPPED],
      [D, 'no_pid', null, ORPHAN_NOT_CHECKED],
    ]);
  });

  it('the process list could not be read: nothing is killed, every open run says it could not be checked', () => {
    const state = stateOf(launched(A), launched(B));
    const decisions = decideOrphans(orphanCandidates(state, [entry(A, 10)]), null);
    expect(decisions.map((d) => [d.runId, d.kill, d.exitedError])).toEqual([
      [A, null, ORPHAN_NOT_CHECKED],
      [B, null, ORPHAN_NOT_CHECKED],
    ]);
  });

  it('a pid that is not running: the run had ended, nothing killed', () => {
    const state = stateOf(launched(A));
    const [d] = decideOrphans(orphanCandidates(state, [entry(A, 10)]), new Map());
    expect(d).toMatchObject({ kill: null, exitedError: ORPHAN_ENDED, check: 'gone' });
  });

  it('nothing open and an empty registry: no candidates', () => {
    expect(orphanCandidates(stateOf(launched(A), exited(A)), [])).toEqual([]);
    expect(orphanCandidates(initialState(), [])).toEqual([]);
  });

  it("files the ending under the root's session and checks the command line for that session id", () => {
    const run = launched(A);
    const state = stateOf({ ...run, runId: 'run-x', claudeSessionId: B, sessionId: B, agentKey: B } as HuddleEvent);
    const candidates = orphanCandidates(state, [entry('run-x', 10)]);
    expect(candidates.map((c) => [c.runId, c.sessionId])).toEqual([['run-x', B]]);
    expect(decideOrphans(candidates, new Map([[10, line(B)]]))[0]).toMatchObject({ kill: 10, sessionId: B });
    expect(decideOrphans(candidates, new Map([[10, line(A)]]))[0]).toMatchObject({ kill: null, check: 'other' });
  });

  it('a discarded worktree gets no summary', () => {
    const state = stateOf(
      launched(A, 'C:\\wt\\a'),
      ev('worktree.closed', A, { runId: A, outcome: 'discarded', error: null }),
    );
    expect(orphanCandidates(state, [])[0]?.worktreePath).toBeNull();
  });
});
