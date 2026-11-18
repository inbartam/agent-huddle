/**
 * Agent run rows (M5, F23 F24): one `AgentRunRow` per agent, from a session's stored HuddleEvents. Pure: events in,
 * rows out; no clock, no I/O.
 *
 * Where each field comes from
 *  - The tree (role, model, parent, status, tasks, tool counts, usage, start and end) is the reducer's final state
 *    (`replay`), so the model precedence, usage deduplication and helper routing stay in one place.
 *      role:  `agent.started.role` (SubagentStart `agent_type`); "main" for the session root.
 *      model: `model.observed` / `session.started.model` / the Agent call (reducer precedence, ADR-015). In headless
 *             runs the root's model comes from main-loop telemetry, a subagent's from PostToolUse(Agent)
 *             `resolvedModel` (rank 2) over the alias in the Agent call's input (rank 1).
 *      tokens: the agent's own `usage.recorded` (telemetry `api_request`); helper requests are not in any row.
 *  - Approvals, stuck incidents and how a turn or run ended are read from the events by `scanSession` below.
 *
 * Outcome: a managed root uses its `run.exited`; otherwise the final status (done -> completed, failed -> failed,
 * stopped -> stopped, anything else -> unknown). A last turn that failed (StopFailure) makes it failed even when a
 * SubagentStop or SessionEnd followed (they set 'done'), unless the run was stopped.
 */
import { CLIP_LIMITS } from '@huddle/shared';
import type {
  AgentNode,
  AgentRunRow,
  ApprovalCounts,
  ApprovalResolved,
  EventOfType,
  HuddleEvent,
  RunOutcome,
  TokenCounts,
  TokenUsage,
} from '@huddle/shared';
import { clip } from '../text.js';
import { replay, type ReducerState } from '../state/reduce.js';

/** Claude Code's own question box arrives as a permission request in older logs; it is not an approval (reducer). */
const QUESTION_TOOL = 'AskUserQuestion';

export interface ApprovalFact {
  ts: number;
  requestId: string;
  agentKey: string;
  toolName: string;
  summary: string;
  resolution: EventOfType<'approval.resolved'> | null;
}

export interface SessionScan {
  /** In request order; one per request id, first resolution kept. */
  approvals: ApprovalFact[];
  stuckByAgent: Map<string, number>;
  /** Per agent, whether the last turn it closed failed. */
  lastTurnFailed: Map<string, boolean>;
  /** Per Claude Code session, the last `run.exited` of a run launched for it. */
  runExitBySession: Map<string, EventOfType<'run.exited'>>;
  /** runId -> Claude Code session id, from `run.launched` (a later launch with a session id corrects an earlier one). */
  runSession: Map<string, string>;
  /**
   * Agents that were given a prompt or had a turn: a `prompt.submitted`, `turn.ended` (Stop, SubagentStop) or
   * `turn.failed` (StopFailure) of their own. See `isScorecardRun`.
   */
  turnAgents: Set<string>;
}

/** Facts the tree does not keep: approvals and who answered, stuck episodes, failed turns, run exits. */
export function scanSession(events: readonly HuddleEvent[]): SessionScan {
  const approvals: ApprovalFact[] = [];
  const byRequest = new Map<string, ApprovalFact>();
  const stuckByAgent = new Map<string, number>();
  const openStuck = new Set<string>();
  const lastTurnFailed = new Map<string, boolean>();
  const runSession = new Map<string, string>();
  const turnAgents = new Set<string>();
  const exits: EventOfType<'run.exited'>[] = [];

  for (const e of events) {
    switch (e.type) {
      case 'approval.requested': {
        if (e.request.toolName === QUESTION_TOOL || byRequest.has(e.request.requestId)) break;
        const fact: ApprovalFact = {
          ts: e.ts,
          requestId: e.request.requestId,
          agentKey: e.agentKey,
          toolName: e.request.toolName,
          summary: e.request.summary,
          resolution: null,
        };
        byRequest.set(fact.requestId, fact);
        approvals.push(fact);
        break;
      }
      case 'approval.resolved': {
        const fact = byRequest.get(e.requestId);
        if (fact !== undefined && fact.resolution === null) fact.resolution = e;
        break;
      }
      case 'attention.raised': {
        if (e.item.kind !== 'stuck' || openStuck.has(e.item.id)) break;
        openStuck.add(e.item.id);
        stuckByAgent.set(e.item.agentKey, (stuckByAgent.get(e.item.agentKey) ?? 0) + 1);
        break;
      }
      case 'attention.resolved':
        openStuck.delete(e.itemId);
        break;
      case 'turn.ended':
        lastTurnFailed.set(e.agentKey, false);
        turnAgents.add(e.agentKey);
        break;
      case 'turn.failed':
        lastTurnFailed.set(e.agentKey, true);
        turnAgents.add(e.agentKey);
        break;
      case 'prompt.submitted':
        turnAgents.add(e.agentKey);
        // A new turn: an earlier failure no longer describes how the agent ends.
        lastTurnFailed.delete(e.agentKey);
        break;
      case 'agent.started':
        // As above: a (re)started agent's earlier failure no longer describes how it ends.
        lastTurnFailed.delete(e.agentKey);
        break;
      case 'run.launched':
        if (e.claudeSessionId !== null) runSession.set(e.runId, e.claudeSessionId);
        break;
      case 'run.exited':
        exits.push(e);
        break;
      default:
        break;
    }
  }

  const runExitBySession = new Map<string, EventOfType<'run.exited'>>();
  for (const exit of exits) {
    const session = runSession.get(exit.runId) ?? exit.sessionId;
    runExitBySession.set(session, exit);
  }
  return { approvals, stuckByAgent, lastTurnFailed, runExitBySession, runSession, turnAgents };
}

function statusOutcome(node: AgentNode): RunOutcome {
  switch (node.status) {
    case 'done':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'stopped':
      return 'stopped';
    default:
      return 'unknown';
  }
}

function exitOutcome(how: EventOfType<'run.exited'>['how']): RunOutcome {
  switch (how) {
    case 'completed':
      return 'completed';
    case 'stopped':
      return 'stopped';
    case 'failed':
    case 'spawn_failed':
      return 'failed';
  }
}

export function outcomeOf(node: AgentNode, scan: SessionScan): RunOutcome {
  const exit = node.kind === 'main' ? scan.runExitBySession.get(node.sessionId) : undefined;
  const base = exit !== undefined ? exitOutcome(exit.how) : statusOutcome(node);
  if (base === 'stopped') return base;
  return scan.lastTurnFailed.get(node.key) === true ? 'failed' : base;
}

/** Token counts from a usage total; null when no request was counted (unknown, not zero). */
export function tokenCounts(usage: TokenUsage | undefined): TokenCounts | null {
  if (usage === undefined || usage.requests === 0) return null;
  return {
    input: usage.inputTokens,
    output: usage.outputTokens,
    cacheRead: usage.cacheReadTokens,
    cacheCreation: usage.cacheCreationTokens,
    requests: usage.requests,
  };
}

function approvalCounts(facts: readonly ApprovalFact[]): ApprovalCounts {
  const counts: ApprovalCounts = { requested: 0, byUser: 0, byPolicy: 0, other: 0, unresolved: 0 };
  for (const fact of facts) {
    counts.requested += 1;
    const by: ApprovalResolved['by'] | undefined = fact.resolution?.by;
    if (by === undefined) counts.unresolved += 1;
    else if (by === 'user') counts.byUser += 1;
    else if (by === 'policy') counts.byPolicy += 1;
    else counts.other += 1;
  }
  return counts;
}

/** Nodes that get a row: every agent the reducer placed, in start order (then key, for a stable order). */
export function reportNodes(state: ReducerState, sessionId?: string): AgentNode[] {
  return Object.values(state.agents)
    .filter((n) => n.role !== '' && (sessionId === undefined || n.sessionId === sessionId))
    .sort((a, b) => a.startedAt - b.startedAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

export function rowFor(node: AgentNode, scan: SessionScan): AgentRunRow {
  const usage = node.usage;
  const tokens = tokenCounts(usage);
  return {
    sessionId: node.sessionId,
    agentKey: node.key,
    parentKey: node.parentKey,
    kind: node.kind,
    role: clip(node.role, CLIP_LIMITS.id),
    model: node.model === null ? null : clip(node.model, CLIP_LIMITS.id),
    startedAt: node.startedAt,
    endedAt: node.endedAt,
    durationMs: node.endedAt === null ? null : Math.max(0, node.endedAt - node.startedAt),
    outcome: outcomeOf(node, scan),
    tasksCreated: node.tasks.length,
    tasksCompleted: node.tasks.filter((t) => t.status === 'completed').length,
    toolCalls: node.toolCalls,
    toolFailures: node.toolFailures,
    approvals: approvalCounts(scan.approvals.filter((a) => a.agentKey === node.key)),
    stuckIncidents: scan.stuckByAgent.get(node.key) ?? 0,
    tokens,
    estimatedCostUsd: tokens === null ? null : usage.estimatedCostUsd,
    costPartial: tokens !== null && (usage.requestsWithoutCost ?? 0) > 0,
  };
}

/**
 * One row per agent in the events (every session they hold, or only `sessionId`), in start order. Hidden helpers
 * (empty role) get none.
 */
export function agentRunRows(events: readonly HuddleEvent[], sessionId?: string): AgentRunRow[] {
  const state = replay(events);
  const scan = scanSession(events);
  return reportNodes(state, sessionId).map((node) => rowFor(node, scan));
}

/**
 * Did this agent do anything a scorecard can count as a run of its role? It made a tool call, kept a task list, or was
 * given a prompt or had a turn (`SessionScan.turnAgents`). A session opened and closed without a prompt has a root with
 * none of these; its "run" would be a 0 ms sample of "main" and drag the median (and the ETA prior) to nothing.
 */
export function isScorecardRun(row: AgentRunRow, scan: SessionScan): boolean {
  return row.toolCalls > 0 || row.tasksCreated > 0 || scan.turnAgents.has(row.agentKey);
}

/**
 * The rows the scorecards count (F24), from the agent rows of `events` (`agentRunRows` or a report's `agents[].row`).
 * Left out:
 *  - every row of a session with no main agent among `rows`: a telemetry-only fragment (`model.observed`,
 *    `usage.recorded`, `context.measured` and no session start) is not a run, and the history list hides it too;
 *  - rows of agents that did nothing (`isScorecardRun`).
 * The history service stores only these in `agent_runs`; the ETA evaluation filters the same way, so both see the same
 * samples. Pure.
 */
export function scorecardRows(rows: readonly AgentRunRow[], events: readonly HuddleEvent[]): AgentRunRow[] {
  const rooted = new Set(rows.filter((r) => r.kind === 'main').map((r) => r.sessionId));
  const scan = scanSession(events);
  return rows.filter((r) => rooted.has(r.sessionId) && isScorecardRun(r, scan));
}
