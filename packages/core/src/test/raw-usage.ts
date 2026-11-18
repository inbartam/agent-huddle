/**
 * Test helper: sums `api_request` records straight from a fixture's OTLP JSON, without the OTLP parser, the
 * normalizer or the reducer, so usage checks are independent of the code under test. Not exported from the package.
 */
import { readFixture } from './fixtures.js';

export interface RawUsageTotals {
  records: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
}

export interface RawApiRequest {
  sessionId: string;
  agentId: string | null;
  querySource: string | null;
  requestId: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
}

interface RawAttribute {
  key: string;
  value: Record<string, unknown>;
}
interface RawBatch {
  resourceLogs?: { scopeLogs?: { logRecords?: { attributes?: RawAttribute[] }[] }[] }[];
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Every api_request record of a fixture, in file order. */
export function rawApiRequests(file: string): RawApiRequest[] {
  const out: RawApiRequest[] = [];
  for (const line of readFixture(file)) {
    if (line.kind !== 'otlp-logs') continue;
    const batch = line.payload as RawBatch;
    for (const rl of batch.resourceLogs ?? []) {
      for (const sl of rl.scopeLogs ?? []) {
        for (const record of sl.logRecords ?? []) {
          const a: Record<string, unknown> = {};
          for (const kv of record.attributes ?? []) {
            a[kv.key] = kv.value.stringValue ?? kv.value.intValue ?? kv.value.doubleValue ?? kv.value.boolValue;
          }
          if (a['event.name'] !== 'api_request') continue;
          out.push({
            sessionId: str(a['session.id']) ?? '',
            agentId: str(a.agent_id),
            querySource: str(a.query_source),
            requestId: str(a.request_id),
            inputTokens: Number(a.input_tokens),
            outputTokens: Number(a.output_tokens),
            cacheReadTokens: Number(a.cache_read_tokens),
            cacheCreationTokens: Number(a.cache_creation_tokens),
            costUsd: Number(a.cost_usd),
          });
        }
      }
    }
  }
  return out;
}

export function sumRaw(records: readonly RawApiRequest[]): RawUsageTotals {
  return records.reduce<RawUsageTotals>(
    (t, r) => ({
      records: t.records + 1,
      inputTokens: t.inputTokens + r.inputTokens,
      outputTokens: t.outputTokens + r.outputTokens,
      cacheReadTokens: t.cacheReadTokens + r.cacheReadTokens,
      cacheCreationTokens: t.cacheCreationTokens + r.cacheCreationTokens,
      costUsd: t.costUsd + r.costUsd,
    }),
    { records: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 },
  );
}

export function rawApiRequestTotals(file: string): RawUsageTotals {
  return sumRaw(rawApiRequests(file));
}
