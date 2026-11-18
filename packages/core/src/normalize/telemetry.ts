/**
 * Telemetry normalizer: OTLP log records -> `model.observed`, `usage.recorded` and `context.measured`.
 *
 * Only `api_request` records are read (INTEGRATION.md section 0 and 2, SPIKES S3 and S9, ADR-013).
 *
 * `model.observed` (M1): which model the session's main loop is running on, the fallback for headless `-p` runs
 * whose `SessionStart` has no `model`. Counts only when:
 *  - its `query_source` is a main-loop source: `repl_main_thread` (interactive) or `sdk` (headless);
 *  - it carries no `agent_id` (that attribute marks a subagent's request);
 *  - it has a non-empty `session.id` and `model`.
 * Within one batch a repeat of the model already emitted for that session is collapsed.
 *
 * `usage.recorded` (M2): one per `api_request` with a non-empty `session.id`, whatever its `query_source`, so the
 * session total matches Claude Code's own `total_cost_usd` (S3). Cost is Claude Code's `cost_usd` (ADR-013; the
 * `cost_usd_micros` fallback when only that is present), never priced from a table. No cost at all: 0 with
 * `costMissing: true`. `agentKey` is the subagent's when `agent_id` is present, else the main agent's;
 * `querySourceKind` tells the reducer whether the request counts on that agent or on the root's helper usage.
 *
 * `context.measured` (M2, `measuredBy: 'telemetry'`): for main and subagent requests only. Used tokens are
 * input + cache read + cache creation of that request (S9); the window comes from `modelWindowTokens` (null when
 * the model is unknown). A subagent-sourced request without `agent_id` is not attributed to the main agent's context.
 *
 * Account identifiers (`user.*`, `organization.id`) are dropped by the OTLP parser before records reach this code,
 * and nothing here copies attributes it does not name.
 *
 * Pure and stateless: ids and the receive time come from `ctx`. Deduplication by request id is the reducer's job.
 */
import { agentKey, CLIP_LIMITS, type EventOfType, type HuddleEvent } from '@huddle/shared';
import type { OtlpAttributes, OtlpLogRecord } from '../ingest/otlp-schemas.js';
import { isIngestSessionId } from '../store/jsonl-store.js';
import { clip } from '../text.js';
import { modelWindowTokens } from './model-windows.js';

export interface TelemetryContext {
  /** ISO time the Huddle received the export; becomes each event's `ts`. */
  receivedAt: string;
  nextId: () => string;
}

/** `query_source` values of the main conversation loop. */
export const MAIN_LOOP_QUERY_SOURCES: ReadonlySet<string> = new Set(['repl_main_thread', 'sdk']);

/** Hidden helper requests: never the main agent's model, never shown as agents. */
export const HELPER_QUERY_SOURCES: ReadonlySet<string> = new Set([
  'generate_session_title',
  'prompt_suggestion',
  'away_summary',
]);

/** Context compaction (seen in fixtures/compaction.jsonl). */
export const COMPACT_QUERY_SOURCE = 'compact';

const SUBAGENT_QUERY_SOURCE_PREFIX = 'agent:';

export type QuerySourceKind = NonNullable<EventOfType<'usage.recorded'>['querySourceKind']>;

/** Classifies an `api_request.query_source`. Unknown or missing values are `other` and are not trusted. */
export function classifyQuerySource(querySource: unknown): QuerySourceKind {
  if (typeof querySource !== 'string') return 'other';
  if (MAIN_LOOP_QUERY_SOURCES.has(querySource)) return 'main';
  if (HELPER_QUERY_SOURCES.has(querySource)) return 'helper';
  if (querySource === COMPACT_QUERY_SOURCE) return 'compact';
  if (querySource.startsWith(SUBAGENT_QUERY_SOURCE_PREFIX)) return 'subagent';
  return 'other';
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** A token count: a finite, non-negative number, else 0. */
function tokens(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** Claude Code's own cost for the request, or null when the record carries none. */
function costUsd(attributes: OtlpAttributes): number | null {
  const cost = attributes.cost_usd;
  if (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0) return cost;
  const micros = attributes.cost_usd_micros;
  if (typeof micros === 'number' && Number.isFinite(micros) && micros >= 0) return micros / 1_000_000;
  return null;
}

/** Id attributes that must fit CLIP_LIMITS.id, or the record is refused. */
const ID_ATTRIBUTES = ['agent_id', 'parent_agent_id', 'request_id'] as const;

function idAttribute(attributes: OtlpAttributes, key: string): string | undefined {
  const value = nonEmptyString(attributes[key]);
  return value === undefined ? undefined : clip(value, CLIP_LIMITS.id);
}

/** Turns one parsed `/v1/logs` batch into events. Pure: no clock, no randomness, no I/O. */
export function normalizeTelemetry(records: readonly OtlpLogRecord[], ctx: TelemetryContext): HuddleEvent[] {
  const ts = Date.parse(ctx.receivedAt);
  const events: HuddleEvent[] = [];
  const lastModelBySession = new Map<string, string>();
  for (const record of records) {
    if (record.name !== 'api_request') continue;
    const attributes = record.attributes;
    // Unclipped, like the hook normalizer, so the key matches the session's hook events. An id longer than
    // CLIP_LIMITS.id is not a Claude Code id: the record is refused rather than stored (same rule as statusline.ts),
    // since clipping it could merge two different ids.
    const sessionId = nonEmptyString(attributes['session.id']);
    if (!isIngestSessionId(sessionId)) continue;
    if (ID_ATTRIBUTES.some((name) => (nonEmptyString(attributes[name])?.length ?? 0) > CLIP_LIMITS.id)) continue;
    const kind = classifyQuerySource(attributes.query_source);
    const agentId = idAttribute(attributes, 'agent_id');
    const parentAgentId = idAttribute(attributes, 'parent_agent_id');
    const model = idAttribute(attributes, 'model') ?? null;
    const key = agentKey(sessionId, agentId);
    const base = { ts, sessionId, agentKey: key, source: 'telemetry' as const };

    // model.observed: main loop, no agent_id.
    if (kind === 'main' && agentId === undefined && model !== null && lastModelBySession.get(sessionId) !== model) {
      lastModelBySession.set(sessionId, model);
      events.push({ id: ctx.nextId(), type: 'model.observed', ...base, model, via: 'telemetry' });
    }

    const inputTokens = tokens(attributes.input_tokens);
    const cacheReadTokens = tokens(attributes.cache_read_tokens);
    const cacheCreationTokens = tokens(attributes.cache_creation_tokens);
    const cost = costUsd(attributes);
    events.push({
      id: ctx.nextId(),
      type: 'usage.recorded',
      ...base,
      model,
      inputTokens,
      outputTokens: tokens(attributes.output_tokens),
      cacheReadTokens,
      cacheCreationTokens,
      estimatedCostUsd: cost ?? 0,
      requestId: idAttribute(attributes, 'request_id') ?? null,
      querySourceKind: kind,
      ...(parentAgentId !== undefined ? { parentAgentId } : {}),
      ...(cost === null ? { costMissing: true } : {}),
    });

    // context.measured: the agent's own requests only. A subagent source without agent_id cannot be placed.
    const ownRequest = kind === 'main' || (kind === 'subagent' && agentId !== undefined);
    if (ownRequest) {
      events.push({
        ...base,
        id: ctx.nextId(),
        type: 'context.measured',
        usedTokens: inputTokens + cacheReadTokens + cacheCreationTokens,
        windowTokens: modelWindowTokens(model),
        measuredBy: 'telemetry',
      });
    }
  }
  return events;
}
