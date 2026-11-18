/** Run history derivations (M5, F23 F24): agent run rows, the end-of-run report, its Markdown, scorecards. Pure. */
export {
  agentRunRows,
  isScorecardRun,
  scanSession,
  scorecardRows,
  type SessionScan,
  type ApprovalFact,
} from './agent-runs.js';
export { buildRunReport, sessionEvents, type BuildRunReportOptions } from './run-report.js';
export { escapeMarkdown, renderReportMarkdown } from './markdown.js';
export { computeScorecards, MIN_PRIOR_SAMPLES, priorUnitMsFor } from './scorecards.js';
export { buildAskContext, ASK_INSTRUCTIONS, type AskContextOptions } from './ask-context.js';
