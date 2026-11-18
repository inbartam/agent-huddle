/**
 * `RunReport` -> Markdown (M5, F23), the file saved next to the run history. Pure and deterministic: times are
 * printed from the report's own timestamps as ISO 8601 UTC, numbers with a fixed format (no locale).
 *
 * Escaping. Every string that came from an agent, a hook or a file (names, titles, results, errors, summaries, paths,
 * roles, models, ids) goes through `escapeMarkdown`, so in a CommonMark / GFM viewer it cannot open a link, an image,
 * raw HTML, a code span or fence, emphasis, a heading, a list, a quote or a table cell:
 *  - every ASCII punctuation character with a meaning (`\ ` * _ [ ] ( ) < > ! # | ~ & @ { } +`) is backslash-escaped;
 *  - newlines and other control characters become spaces (each value is one line); format characters (zero-width,
 *    bidi overrides and isolates) are dropped;
 *  - `scheme://` gets its colon escaped and `www.` its dot, which stops GFM's bare-URL autolinks;
 *  - a leading `-`, `=` or `1.` / `1)` is escaped as well.
 * Known limit: a viewer that linkifies plain text after parsing (markdown-it with `linkify`, e.g. VS Code's preview)
 * still turns a bare `https://...` into a link. Such a link shows its real target as its text and loads nothing on
 * open; the dangerous forms (a disguised `[text](url)`, an image that fetches, HTML, `javascript:`) stay inert.
 *
 * Estimates are labeled as estimates (cost is Claude Code's own figure, ADR-013); anything unknown prints "unknown".
 */
import type {
  AgentRunRow,
  ReportAgent,
  ReportApproval,
  ReportFailure,
  ReportFile,
  RunReport,
  TokenCounts,
} from '@huddle/shared';

const UNKNOWN = 'unknown';

/** Markdown-inert, one-line form of untrusted text. */
export function escapeMarkdown(text: string): string {
  return (
    text
      // Cf: format characters (zero-width space and joiners, bidi overrides and isolates U+202A-U+202E and
      // U+2066-U+2069, the BOM): invisible, and a bidi override can make a path or a name read backwards. Dropped.
      .replace(/\p{Cf}+/gu, '')
      // Cc: C0 and C1 control characters (newlines, tabs, NUL); Zl, Zp: the Unicode line and paragraph separators.
      .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ')
      .replace(/[\\`*_[\]()<>!#|~&@{}+]/g, '\\$&')
      .replace(/([A-Za-z][A-Za-z0-9.-]*):(?=\/\/)/g, '$1\\:')
      .replace(/\b(www)\./gi, '$1\\.')
      .replace(/^(\s*)([-=])/, '$1\\$2')
      .replace(/^(\s*\d+)([.)])/, '$1\\$2')
  );
}

function text(value: string | null): string {
  return value === null || value === '' ? UNKNOWN : escapeMarkdown(value);
}

/** "1 request", "2 requests". */
function count(n: number, noun: string): string {
  return `${formatInt(n)} ${noun}${n === 1 ? '' : 's'}`;
}

/** Thousands with commas, no locale. */
export function formatInt(n: number): string {
  const sign = n < 0 ? '-' : '';
  return sign + String(Math.round(Math.abs(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return UNKNOWN;
  if (ms < 1000) return `${(ms / 1000).toFixed(1)} s`;
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${String(h)} h ${String(m).padStart(2, '0')} m`;
  if (m > 0) return `${String(m)} m ${String(s).padStart(2, '0')} s`;
  return `${String(s)} s`;
}

function formatTime(ts: number | null): string {
  return ts === null ? UNKNOWN : new Date(ts).toISOString();
}

function formatTokens(t: TokenCounts | null, partial = false): string {
  if (t === null) return UNKNOWN;
  const base =
    `input ${formatInt(t.input)}, output ${formatInt(t.output)}, cache read ${formatInt(t.cacheRead)}, ` +
    `cache write ${formatInt(t.cacheCreation)} (${count(t.requests, 'request')})`;
  return partial ? `${base}, at least: some agents have no usage record` : base;
}

function formatCost(usd: number | null, partial: boolean): string {
  if (usd === null) return UNKNOWN;
  const lowerBound = partial ? ', at least: some requests had no cost' : '';
  return `$${usd.toFixed(4)} (estimate by Claude Code, not money spent${lowerBound})`;
}

function inOut(t: TokenCounts | null): string {
  return t === null ? UNKNOWN : `${formatInt(t.input)} / ${formatInt(t.output)}`;
}

function approvalsLine(row: AgentRunRow): string {
  const a = row.approvals;
  if (a.requested === 0) return 'none';
  const parts = [
    a.byUser > 0 ? `${String(a.byUser)} by the user` : null,
    a.byPolicy > 0 ? `${String(a.byPolicy)} by a rule` : null,
    a.other > 0 ? `${String(a.other)} ended without a Huddle decision` : null,
    a.unresolved > 0 ? `${String(a.unresolved)} with no recorded end` : null,
  ].filter((p): p is string => p !== null);
  return `${String(a.requested)} requested: ${parts.join(', ')}`;
}

function agentLabel(report: RunReport, key: string): string {
  const agent = report.agents.find((a) => a.row.agentKey === key);
  return agent === undefined
    ? escapeMarkdown(key)
    : `${escapeMarkdown(agent.name)} (${escapeMarkdown(agent.row.role)})`;
}

function agentTable(agents: readonly ReportAgent[]): string[] {
  const lines = [
    '| Agent | Role | Model | Outcome | Time | Tasks done | Tool calls | Failed calls | Approvals | Stuck | Tokens in / out |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const a of agents) {
    const r = a.row;
    lines.push(
      `| ${escapeMarkdown(a.name)} | ${escapeMarkdown(r.role)} | ${text(r.model)} | ${r.outcome} | ` +
        `${formatDuration(r.durationMs)} | ${String(r.tasksCompleted)}/${String(r.tasksCreated)} | ` +
        `${String(r.toolCalls)} | ${String(r.toolFailures)} | ${String(r.approvals.requested)} | ` +
        `${String(r.stuckIncidents)} | ${inOut(r.tokens)} |`,
    );
  }
  return lines;
}

function agentSection(report: RunReport, a: ReportAgent): string[] {
  const r = a.row;
  const lines = [`### ${escapeMarkdown(a.name)}`, ''];
  lines.push(`- **Role:** ${escapeMarkdown(r.role)}`);
  lines.push(`- **Model:** ${text(r.model)}`);
  if (r.parentKey !== null) lines.push(`- **Started by:** ${agentLabel(report, r.parentKey)}`);
  if (a.title !== null) lines.push(`- **Asked to:** ${escapeMarkdown(a.title)}`);
  lines.push(`- **Outcome:** ${r.outcome}`);
  lines.push(`- **Time:** ${formatDuration(r.durationMs)} (${formatTime(r.startedAt)} to ${formatTime(r.endedAt)})`);
  lines.push(`- **Tasks:** ${String(r.tasksCompleted)} of ${String(r.tasksCreated)} completed`);
  const tools =
    a.tools.length === 0
      ? 'none'
      : a.tools
          .map(
            (t) =>
              `${escapeMarkdown(t.toolName)} ${String(t.calls)}${t.failures > 0 ? ` (${String(t.failures)} failed)` : ''}`,
          )
          .join(', ');
  lines.push(`- **Tools:** ${tools}`);
  lines.push(`- **Files written:** ${String(a.fileWrites)}`);
  lines.push(`- **Approvals:** ${approvalsLine(r)}`);
  lines.push(`- **Stuck incidents:** ${String(r.stuckIncidents)}`);
  lines.push(`- **Tokens:** ${formatTokens(r.tokens)}`);
  lines.push(`- **Cost:** ${formatCost(r.estimatedCostUsd, r.costPartial)}`);
  if (a.result !== null) lines.push(`- **Result:** ${escapeMarkdown(a.result)}`);
  lines.push('');
  return lines;
}

function fileLine(report: RunReport, f: ReportFile): string {
  if (f.source === 'worktree') return `- ${escapeMarkdown(f.path)} (worktree, ${f.worktreeStatus ?? UNKNOWN})`;
  const who = f.agentKeys.map((k) => agentLabel(report, k)).join(', ');
  const tools = f.tools.map(escapeMarkdown).join(', ');
  return `- ${escapeMarkdown(f.path)} (${tools}, ${String(f.writes)} ${f.writes === 1 ? 'write' : 'writes'}, by ${who})`;
}

function failureLine(report: RunReport, f: ReportFailure): string {
  const what =
    f.kind === 'tool'
      ? `${text(f.toolName)} failed${f.interrupted ? ' (interrupted)' : ''}`
      : f.kind === 'turn'
        ? 'turn failed'
        : 'run failed';
  return `- ${formatTime(f.ts)}, ${agentLabel(report, f.agentKey)}: ${what}: ${text(f.error)}`;
}

function approvalLine(report: RunReport, a: ReportApproval): string {
  const answer =
    a.outcome === null
      ? 'no recorded answer'
      : `${a.outcome.replace(/_/g, ' ')} by ${a.by === null ? UNKNOWN : a.by.replace(/_/g, ' ')}` +
        (a.policyRuleId !== null ? ` (rule ${escapeMarkdown(a.policyRuleId)})` : '');
  return `- ${formatTime(a.ts)}, ${agentLabel(report, a.agentKey)}: ${escapeMarkdown(a.toolName)}: ${escapeMarkdown(a.summary)}: ${answer}`;
}

export function renderReportMarkdown(report: RunReport): string {
  const s = report.summary;
  const out: string[] = [];
  out.push(`# Run report: ${s.title === null ? 'untitled session' : escapeMarkdown(s.title)}`, '');
  out.push(`- **Session:** ${escapeMarkdown(report.sessionId)}`);
  out.push(`- **Topic:** ${text(s.topic)}`);
  out.push(`- **Folder:** ${text(s.cwd)}`);
  out.push(`- **Model:** ${text(s.model)}`);
  out.push(`- **Launched by:** ${s.origin === 'managed' ? 'Agent Huddle' : 'the user (attached session)'}`);
  out.push(`- **Started:** ${formatTime(s.startedAt)}`);
  out.push(`- **Ended:** ${formatTime(s.endedAt)}${s.endReason !== null ? ` (${escapeMarkdown(s.endReason)})` : ''}`);
  out.push(`- **Duration:** ${formatDuration(s.durationMs)}`);
  out.push(`- **Outcome:** ${s.outcome}`);
  out.push(
    `- **Work:** ${count(s.agents, 'agent')}, ${count(s.tasksCompleted, 'task')} completed, ` +
      `${count(s.toolCalls, 'tool call')} (${String(s.toolFailures)} failed), ${count(s.approvalsRequested, 'approval')}, ` +
      count(s.stuckIncidents, 'stuck incident'),
  );
  out.push(`- **Tokens:** ${formatTokens(s.tokens, s.tokensPartial)}`);
  out.push(`- **Helper requests:** ${s.helperTokens === null ? 'none recorded' : formatTokens(s.helperTokens)}`);
  out.push(`- **Cost:** ${formatCost(s.estimatedCostUsd, s.costPartial)}`, '');

  out.push('## Agents', '', ...agentTable(report.agents), '');
  for (const a of report.agents) out.push(...agentSection(report, a));

  out.push('## Files changed', '');
  if (report.worktree !== null) {
    const w = report.worktree;
    out.push(
      `Worktree ${text(w.path)} on branch ${text(w.branch)}: ${String(w.filesChanged)} files changed, ` +
        `${String(w.insertions)} insertions, ${String(w.deletions)} deletions, ${String(w.untracked)} untracked` +
        `${w.listed < w.filesChanged ? ` (${String(w.listed)} listed)` : ''}; ${w.closed ?? 'not closed yet'}.`,
      '',
    );
  }
  if (report.filesChanged.length === 0) out.push('None recorded.');
  else for (const f of report.filesChanged) out.push(fileLine(report, f));
  out.push('');

  out.push('## Failures', '');
  if (report.failures.length === 0) out.push('None.');
  else for (const f of report.failures) out.push(failureLine(report, f));
  out.push('');

  out.push('## Approvals', '');
  if (report.approvals.length === 0) out.push('None.');
  else for (const a of report.approvals) out.push(approvalLine(report, a));
  out.push('');

  return out.join('\n');
}
