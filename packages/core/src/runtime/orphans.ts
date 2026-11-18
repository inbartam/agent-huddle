/**
 * Start-up reconciliation of managed runs a Huddle crash left behind (M4 follow-up, ADR-020 known limits). Pure: the
 * replayed state, the run registry (run-registry.ts) and a process list go in; what to kill and which `run.exited` to
 * write come out. RunHost.reconcileOrphans does the I/O (read the registry, read command lines, kill, write events).
 *
 * A run is a candidate when the registry names it, or when the replayed log has its `run.launched` and no `run.exited`
 * (the log is the record of what happened; the registry only adds the pid). For each candidate:
 *  - the log already has its `run.exited`: nothing to do but drop the registry entry (the crash came between the
 *    exit's event and the registry write). Its pid is never looked at: it may belong to another process by now.
 *  - no pid (the crash came between `run.launched` and the registry write, or the run is from a build without the
 *    registry): its process cannot be checked. Not killed; `run.exited` says so.
 *  - the pid runs and its command line carries `--session-id <runId>`: it is that run's `claude`. Its tree is killed
 *    and `run.exited` says it was stopped.
 *  - the pid does not run, or runs with another command line (the pid was reused): the run's process is gone. Not
 *    killed; `run.exited` says it had ended.
 *  - the process list could not be read, or the pid runs but its command line cannot be read: it cannot be verified,
 *    so it is NOT killed (a pid may be reused); `run.exited` says it could not be checked.
 * Every `run.exited` is `how: 'stopped'`, `exitCode: null`: the Huddle does not know how the process ended, and the
 * root must stop looking alive so a worktree can be discarded.
 */
import { isRunAlive, type HuddleState } from '@huddle/shared';
import type { CommandLines } from './process-info.js';
import type { RunRegistryEntry } from './run-registry.js';

export const ORPHAN_STOPPED = 'The Huddle restarted while this run was going; it was stopped.';
export const ORPHAN_NOT_CHECKED = 'The Huddle restarted while this run was going; its process could not be checked.';
export const ORPHAN_ENDED = 'The Huddle restarted while this run was going; its process had already ended.';

export interface OrphanCandidate {
  runId: string;
  /**
   * The session the run's events are filed under: its root's, from the log (runs.ts makes it equal to the run id); the
   * run id for a registry entry the log does not know.
   */
  sessionId: string;
  /** From the registry; null when the registry has no entry for the run. */
  pid: number | null;
  /** The replayed log has the run's `run.exited`. */
  exitedInLog: boolean;
  /** The run's worktree path from the log, when it has one that was not discarded (it gets a summary). */
  worktreePath: string | null;
}

export type ProcessCheck = 'ours' | 'gone' | 'other' | 'unknown';

export interface OrphanDecision {
  runId: string;
  sessionId: string;
  /** Kill this pid's tree. */
  kill: number | null;
  /** The `run.exited` error text, or null for no event (the log already has the exit). */
  exitedError: string | null;
  worktreePath: string | null;
  check: ProcessCheck | 'no_pid' | 'exited';
}

/**
 * Pure: the runs to reconcile, registry entries first (in file order), then the replayed runs without an exit that the
 * registry does not name (sorted by run id, for a stable order).
 */
export function orphanCandidates(state: HuddleState, entries: readonly RunRegistryEntry[]): OrphanCandidate[] {
  const roots = new Map<string, { sessionId: string; exited: boolean; worktreePath: string | null }>();
  for (const node of Object.values(state.agents)) {
    const run = node.kind === 'main' ? (node.run ?? null) : null;
    if (run === null) continue;
    const wt = run.worktree ?? null;
    roots.set(run.runId.toLowerCase(), {
      sessionId: node.sessionId,
      exited: !isRunAlive(run),
      worktreePath: wt !== null && wt.state !== 'discarded' && wt.path !== '' ? wt.path : null,
    });
  }
  const out: OrphanCandidate[] = [];
  const named = new Set<string>();
  for (const entry of entries) {
    const id = entry.runId.toLowerCase();
    if (named.has(id)) continue;
    named.add(id);
    const known = roots.get(id);
    out.push({
      runId: entry.runId,
      sessionId: known?.sessionId ?? entry.runId,
      pid: entry.pid,
      exitedInLog: known?.exited ?? false,
      worktreePath: known?.worktreePath ?? null,
    });
  }
  const rest = Object.values(state.agents)
    .filter((n) => n.kind === 'main' && n.run != null && isRunAlive(n.run) && !named.has(n.run.runId.toLowerCase()))
    .map((n) => ({ runId: n.run?.runId ?? '', sessionId: n.sessionId }))
    .sort((a, b) => (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));
  for (const { runId, sessionId } of rest) {
    out.push({
      runId,
      sessionId,
      pid: null,
      exitedInLog: false,
      worktreePath: roots.get(runId.toLowerCase())?.worktreePath ?? null,
    });
  }
  return out;
}

/** The pids worth asking the process list about (candidates still open in the log, with a pid). */
export function pidsToCheck(candidates: readonly OrphanCandidate[]): number[] {
  return [...new Set(candidates.filter((c) => !c.exitedInLog && c.pid !== null).map((c) => c.pid as number))];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Pure: does this command line belong to the run? It must carry `--session-id <runId>` as its own arguments (the flag
 * and the id as whole tokens, optionally quoted, or `--session-id=<runId>`). The run id must be a UUID.
 */
export function commandLineIsRun(commandLine: string, runId: string): boolean {
  if (!UUID.test(runId)) return false;
  const id = runId.toLowerCase();
  const re = new RegExp(`(?:^|\\s)"?--session-id"?(?:\\s+|=)"?${id}"?(?=\\s|$)`, 'i');
  return re.test(commandLine);
}

/** Pure: what the process list says about one candidate's pid. `lines` null: the list could not be read. */
export function checkProcess(pid: number, runId: string, lines: CommandLines | null): ProcessCheck {
  if (lines === null) return 'unknown';
  if (!lines.has(pid)) return 'gone';
  const line = lines.get(pid) ?? null;
  if (line === null) return 'unknown';
  return commandLineIsRun(line, runId) ? 'ours' : 'other';
}

/** Pure: the decision for one candidate (see the file comment). */
export function decideOrphan(candidate: OrphanCandidate, lines: CommandLines | null): OrphanDecision {
  const base = { runId: candidate.runId, sessionId: candidate.sessionId, worktreePath: candidate.worktreePath };
  if (candidate.exitedInLog) return { ...base, kill: null, exitedError: null, check: 'exited' };
  if (candidate.pid === null) return { ...base, kill: null, exitedError: ORPHAN_NOT_CHECKED, check: 'no_pid' };
  const check = checkProcess(candidate.pid, candidate.sessionId, lines);
  switch (check) {
    case 'ours':
      return { ...base, kill: candidate.pid, exitedError: ORPHAN_STOPPED, check };
    case 'gone':
    case 'other':
      return { ...base, kill: null, exitedError: ORPHAN_ENDED, check };
    case 'unknown':
      return { ...base, kill: null, exitedError: ORPHAN_NOT_CHECKED, check };
  }
}

/** Pure: every decision, in candidate order. */
export function decideOrphans(candidates: readonly OrphanCandidate[], lines: CommandLines | null): OrphanDecision[] {
  return candidates.map((c) => decideOrphan(c, lines));
}
