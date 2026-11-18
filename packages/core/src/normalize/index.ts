/** Pure functions: raw Claude Code payload -> HuddleEvent[]. No clock, no randomness, no I/O. */
export { normalizeHook, toolSummary, type NormalizeHookContext, type NormalizableHook } from './hooks.js';
export { clip } from '../text.js';
export {
  normalizeTelemetry,
  classifyQuerySource,
  MAIN_LOOP_QUERY_SOURCES,
  HELPER_QUERY_SOURCES,
  COMPACT_QUERY_SOURCE,
  type TelemetryContext,
  type QuerySourceKind,
} from './telemetry.js';
export { modelWindowTokens, baseModelId, MODEL_WINDOWS, ONE_MILLION_TOKENS } from './model-windows.js';
export { normalizeStatusline, type StatuslineContext } from './statusline.js';
export { hookFacts, type HookFacts, type RawQuestion, type RawQuestionCall } from './hook-facts.js';
export { normalizeStreamLine, normalizeStreamMessage, type StreamContext, type StreamNormalized } from './stream.js';
export {
  readProgressReport,
  progressReportSummary,
  readTeammateReport,
  teammateReportSummary,
  TEAMMATE_NAME_MAX,
  type TeammateReportFields,
  MAX_MINUTES_LEFT,
  type ProgressReportFields,
} from './self-report.js';
