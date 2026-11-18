/**
 * Scorecards (M5, F24): agent run rows from any number of sessions -> one `Scorecard` per (role, model). Pure.
 *
 * Time and tokens are per unit of work, the unit the ETA paces by (see `Scorecard` in @huddle/shared/history): a task
 * when the agent kept a task list, else the whole run. Only completed runs with a known duration give a time, so a
 * failed or stopped run never makes a role look fast. Tokens per task use the same completed runs, minus those with
 * unknown tokens (left out, never counted as 0). The median is over runs (one value per run), because the tasks
 * of one run are not independent samples.
 *
 * A main agent's duration is its whole session, idle time between prompts included, so a "main" scorecard from an
 * interactive session reads slow; subagent and headless rows do not have that problem.
 *
 * The rows given are the ones the scorecards count: `scorecardRows` (agent-runs.ts) leaves out sessions with no main
 * agent and agents that did nothing. The history service stores only those rows in `agent_runs`, and the ETA evaluation
 * filters the same way. A card with an unknown model, or a 0 ms median, is still shown but never used as an ETA prior
 * (`priorUnitMsFor`).
 */
import { median, workTokens, type AgentRunRow, type Scorecard } from '@huddle/shared';

export { MIN_PRIOR_SAMPLES, priorUnitMsFor } from '@huddle/shared';

function groupKey(row: AgentRunRow): string {
  return `${row.role}\u0000${row.model ?? ''}\u0000${row.model === null ? 'null' : 'model'}`;
}

/** Units of work in a completed run: its completed tasks, or 1 when it kept no task list. */
function unitsOf(row: AgentRunRow): number {
  return row.tasksCompleted > 0 ? row.tasksCompleted : 1;
}

function card(rows: readonly AgentRunRow[]): Scorecard {
  const first = rows[0] as AgentRunRow;
  const timed = rows.filter((r) => r.outcome === 'completed' && r.durationMs !== null);
  const perUnit = timed.map((r) => (r.durationMs as number) / unitsOf(r));
  const withTokens = timed.filter((r) => r.tokens !== null);
  const tokenUnits = withTokens.reduce((s, r) => s + unitsOf(r), 0);
  const tokenSum = withTokens.reduce((s, r) => s + (r.tokens === null ? 0 : workTokens(r.tokens)), 0);
  const known = rows.filter((r) => r.outcome !== 'unknown');
  const failed = known.filter((r) => r.outcome === 'failed').length;
  const toolCalls = rows.reduce((s, r) => s + r.toolCalls, 0);
  const toolFailures = rows.reduce((s, r) => s + r.toolFailures, 0);
  return {
    role: first.role,
    model: first.model,
    runs: rows.length,
    tasksCompleted: rows.reduce((s, r) => s + r.tasksCompleted, 0),
    units: timed.reduce((s, r) => s + unitsOf(r), 0),
    medianTaskMs: median(perUnit),
    sampleSize: timed.length,
    tokensPerTask: tokenUnits === 0 ? null : tokenSum / tokenUnits,
    tokenSampleSize: withTokens.length,
    failureRate: known.length === 0 ? null : failed / known.length,
    toolFailureRate: toolCalls === 0 ? null : toolFailures / toolCalls,
    approvalsRequested: rows.reduce((s, r) => s + r.approvals.requested, 0),
    stuckIncidents: rows.reduce((s, r) => s + r.stuckIncidents, 0),
    firstRunAt: Math.min(...rows.map((r) => r.startedAt)),
    lastRunAt: Math.max(...rows.map((r) => r.startedAt)),
  };
}

/** One scorecard per (role, model), sorted by role, then model (unknown model last). */
export function computeScorecards(rows: readonly AgentRunRow[]): Scorecard[] {
  const groups = new Map<string, AgentRunRow[]>();
  for (const row of rows) {
    const key = groupKey(row);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [row]);
    else group.push(row);
  }
  return [...groups.values()].map(card).sort((a, b) => {
    if (a.role !== b.role) return a.role < b.role ? -1 : 1;
    if (a.model === b.model) return 0;
    if (a.model === null) return 1;
    if (b.model === null) return -1;
    return a.model < b.model ? -1 : 1;
  });
}
