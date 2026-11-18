/**
 * Settings → Self-reported progress (M6, F27): the `setup.selfReportPreview` question on `huddle:query`. Like
 * phone-query.ts, the answer is checked here: a result of the wrong shape reads as `failed`, a missing bridge as
 * "unavailable in this build", and the core's own refusals come through with their message.
 */
import type {
  QueryResult,
  SelfReportDiffLine,
  SelfReportRegistrationMode,
  SelfReportRegistrationPreview,
  SelfReportRegistrationState,
} from '@huddle/shared';
import { ask } from './history-query.js';
import { QUERY_FAILED, type QueryFn } from './query.js';

type Failed = Extract<QueryResult, { ok: false }>;

const failed: Failed = { ok: false, code: 'failed', message: QUERY_FAILED };

export type SelfReportPreviewAnswer = { ok: true; preview: SelfReportRegistrationPreview } | Failed;

const STATES: ReadonlySet<string> = new Set<SelfReportRegistrationState>(['absent', 'ours', 'foreign', 'unreadable']);
/** More than this many commands or notes is not a preview this build understands. */
const LIST_MAX = 50;

function strings(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length > LIST_MAX) return null;
  const out: string[] = [];
  for (const s of v) {
    if (typeof s !== 'string') return null;
    out.push(s);
  }
  return out;
}

function diffLines(v: unknown): SelfReportDiffLine[] {
  if (!Array.isArray(v)) return [];
  const out: SelfReportDiffLine[] = [];
  for (const l of v) {
    if (typeof l !== 'object' || l === null) continue;
    const r = l as Record<string, unknown>;
    const op = r['op'];
    if ((op === ' ' || op === '+' || op === '-') && typeof r['text'] === 'string') out.push({ op, text: r['text'] });
  }
  return out;
}

/** What registering (or removing) the self-report server would run and change. Runs nothing. */
export async function loadSelfReportPreview(
  query: QueryFn | null,
  mode: SelfReportRegistrationMode,
): Promise<SelfReportPreviewAnswer> {
  const r = await ask(query, { type: 'setup.selfReportPreview', mode });
  if (!r.ok) return r;
  const p: unknown = r.r['preview'];
  if (typeof p !== 'object' || p === null) return failed;
  const v = p as Record<string, unknown>;
  const state = v['state'];
  const commands = strings(v['commands']);
  const notes = strings(v['notes']);
  const refusal = v['refusal'];
  if (
    v['mode'] !== mode ||
    typeof state !== 'string' ||
    !STATES.has(state) ||
    commands === null ||
    notes === null ||
    typeof v['diffText'] !== 'string' ||
    typeof v['claudeJsonPath'] !== 'string' ||
    typeof v['serverScriptPath'] !== 'string' ||
    (refusal !== null && typeof refusal !== 'string') ||
    typeof v['changed'] !== 'boolean' ||
    typeof v['fingerprint'] !== 'string'
  ) {
    return failed;
  }
  return {
    ok: true,
    preview: {
      mode,
      state: state as SelfReportRegistrationState,
      claudeJsonPath: v['claudeJsonPath'],
      serverScriptPath: v['serverScriptPath'],
      commands,
      diff: diffLines(v['diff']),
      diffText: v['diffText'],
      notes,
      refusal,
      changed: v['changed'],
      fingerprint: v['fingerprint'],
    },
  };
}
