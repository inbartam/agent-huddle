/**
 * Runtime schemas for OpenTelemetry log exports (OTLP/HTTP JSON, `POST /v1/logs`).
 *
 * Shape: `{resourceLogs: [{resource: {attributes}, scopeLogs: [{scope, logRecords: [{timeUnixNano, body,
 * attributes: [{key, value: {stringValue | intValue | doubleValue | boolValue | ...}}]}]}]}]}`.
 *
 * Deliberately loose, like the hook schemas:
 *  - Every object is a `z.looseObject`, so fields a newer exporter adds are kept, not rejected.
 *  - Each level is checked on its own: an unreadable resource, scope, record or attribute is skipped
 *    and counted, and the rest of the batch still parses.
 *  - Attribute values are flattened to `string | number | boolean` (see `OtlpAttributeValue`). Array,
 *    kvlist and bytes values are skipped: no Claude Code attribute the Huddle reads uses them.
 *  - Prompt text, response text and account identifiers are never retained (`DROPPED_ATTRIBUTE_KEYS`),
 *    nor is the record `body`. Claude Code only exports prompt text when `OTEL_LOG_USER_PROMPTS` is set,
 *    but a user may have set it for another tool, so the Huddle drops it regardless.
 *
 * Nothing outside ingest/ and normalize/ may import this module's record types.
 */
import { z } from 'zod';

/**
 * What the HTTP server does with each OTLP path (the exporter appends these to OTEL_EXPORTER_OTLP_ENDPOINT).
 * `logs`: parse with `parseOtlpLogs`, then `normalizeTelemetry`. `discard`: accept with 200 and drop the body,
 * so the exporter does not log errors. Metrics lack per-request correlation (INTEGRATION.md section 2) and
 * Claude Code sends no traces the Huddle uses; usage metering from logs arrives in M2.
 */
export const TELEMETRY_ROUTES = {
  '/v1/logs': 'logs',
  '/v1/metrics': 'discard',
  '/v1/traces': 'discard',
} as const satisfies Record<string, 'logs' | 'discard'>;

export type TelemetryRoute = keyof typeof TELEMETRY_ROUTES;

/**
 * Attribute keys that are never kept: free text the user or model wrote, and account identifiers
 * (INTEGRATION.md: every record carries them; drop at ingest). Any key starting with `user.` is dropped too.
 */
export const DROPPED_ATTRIBUTE_KEYS: ReadonlySet<string> = new Set([
  'prompt',
  'prompt_text',
  'response',
  'tool_input',
  'tool_parameters',
  'organization.id',
]);
const DROPPED_ATTRIBUTE_PREFIXES = ['user.'] as const;

/** Ids, model names and enum-like values are short. A longer string is free text: drop it. */
export const MAX_ATTRIBUTE_STRING_LENGTH = 1024;

/**
 * A flattened attribute value.
 *  - `stringValue` -> string, `boolValue` -> boolean, `doubleValue` -> number.
 *  - `intValue` -> number when it is a safe integer; otherwise the decimal string, so a value above
 *    2^53 is never silently rounded. (Protobuf JSON may send int64 as a string; Claude Code sends numbers.)
 */
export type OtlpAttributeValue = string | number | boolean;
export type OtlpAttributes = Record<string, OtlpAttributeValue>;

export interface OtlpLogRecord {
  /**
   * Event name without the `claude_code.` prefix, e.g. `api_request`: the `event.name` attribute, else the
   * string body. `null` when neither is readable.
   */
  name: string | null;
  /** As sent (a decimal string of nanoseconds), or `null`. Event `ts` comes from receipt, not from here. */
  timeUnixNano: string | null;
  /** The record's attributes, flattened, minus `DROPPED_ATTRIBUTE_KEYS`. Unknown keys are kept. */
  attributes: OtlpAttributes;
  /** The resource's attributes (service.name, service.version, os.type ...), same rules. */
  resource: OtlpAttributes;
}

export type ParseOtlpLogsResult =
  { ok: true; records: OtlpLogRecord[]; skipped: number } | { ok: false; error: string };

const anyValue = z.looseObject({
  stringValue: z.string().optional(),
  boolValue: z.boolean().optional(),
  intValue: z.union([z.number(), z.string()]).optional(),
  doubleValue: z.number().optional(),
});
const keyValue = z.looseObject({ key: z.string(), value: z.unknown().optional() });
const attributeList = z.array(z.unknown());
const timeField = z.union([z.string(), z.number()]).optional().catch(undefined);

export const OtlpLogRecordSchema = z.looseObject({
  timeUnixNano: timeField,
  observedTimeUnixNano: timeField,
  body: z.unknown().optional(),
  attributes: attributeList.optional(),
});
export const OtlpScopeLogsSchema = z.looseObject({ logRecords: z.array(z.unknown()).optional() });
export const OtlpResourceLogsSchema = z.looseObject({
  resource: z.looseObject({ attributes: attributeList.optional() }).optional().catch(undefined),
  scopeLogs: z.array(z.unknown()).optional(),
});
export const OtlpLogsBodySchema = z.looseObject({ resourceLogs: z.array(z.unknown()).optional() });

const EVENT_PREFIX = 'claude_code.';

function isDropped(key: string): boolean {
  return DROPPED_ATTRIBUTE_KEYS.has(key) || DROPPED_ATTRIBUTE_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function readInt(value: number | string): number | string | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (!/^-?\d+$/.test(value)) return undefined;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : value;
}

/** One OTLP AnyValue -> a flat value, or undefined when it is not a scalar the Huddle reads. */
function readValue(raw: unknown): OtlpAttributeValue | undefined {
  const parsed = anyValue.safeParse(raw);
  if (!parsed.success) return undefined;
  const value = parsed.data;
  if (value.stringValue !== undefined) {
    return value.stringValue.length <= MAX_ATTRIBUTE_STRING_LENGTH ? value.stringValue : undefined;
  }
  if (value.boolValue !== undefined) return value.boolValue;
  if (value.intValue !== undefined) return readInt(value.intValue);
  if (value.doubleValue !== undefined) return Number.isFinite(value.doubleValue) ? value.doubleValue : undefined;
  return undefined;
}

/** Flattens a KeyValue list. Unreadable entries and dropped keys are skipped. */
function readAttributes(list: readonly unknown[] | undefined): OtlpAttributes {
  // Null prototype: a key such as `__proto__` from the wire cannot touch Object.prototype.
  const out = Object.create(null) as OtlpAttributes;
  if (list === undefined) return out;
  for (const item of list) {
    const entry = keyValue.safeParse(item);
    if (!entry.success || isDropped(entry.data.key)) continue;
    const value = readValue(entry.data.value);
    if (value !== undefined) out[entry.data.key] = value;
  }
  return out;
}

function stripPrefix(name: string): string {
  return name.startsWith(EVENT_PREFIX) ? name.slice(EVENT_PREFIX.length) : name;
}

function readName(attributes: OtlpAttributes, body: unknown): string | null {
  const fromAttribute = attributes['event.name'];
  if (typeof fromAttribute === 'string' && fromAttribute.length > 0) return stripPrefix(fromAttribute);
  const fromBody = readValue(body);
  if (typeof fromBody === 'string' && fromBody.length > 0) return stripPrefix(fromBody);
  return null;
}

/**
 * Validates one `/v1/logs` body. Never throws and never mutates `body`.
 *
 * - `{ok: true, records, skipped}`: every record that could be read; `skipped` counts the resources,
 *   scopes, records and attribute lists that could not.
 * - `{ok: false, error}`: the body is not an object, or `resourceLogs` is not an array, or the body could
 *   not be read at all. The error never contains values from the body.
 *
 * An empty object is a valid, empty export (protobuf JSON omits empty repeated fields).
 */
export function parseOtlpLogs(body: unknown): ParseOtlpLogsResult {
  try {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return { ok: false, error: 'body is not a JSON object' };
    }
    const parsed = OtlpLogsBodySchema.safeParse(body);
    if (!parsed.success) return { ok: false, error: 'resourceLogs is not an array' };

    const records: OtlpLogRecord[] = [];
    let skipped = 0;
    for (const rawResource of parsed.data.resourceLogs ?? []) {
      const resourceLogs = OtlpResourceLogsSchema.safeParse(rawResource);
      if (!resourceLogs.success) {
        skipped += 1;
        continue;
      }
      const resource = readAttributes(resourceLogs.data.resource?.attributes);
      for (const rawScope of resourceLogs.data.scopeLogs ?? []) {
        const scope = OtlpScopeLogsSchema.safeParse(rawScope);
        if (!scope.success) {
          skipped += 1;
          continue;
        }
        for (const rawRecord of scope.data.logRecords ?? []) {
          const record = OtlpLogRecordSchema.safeParse(rawRecord);
          if (!record.success) {
            skipped += 1;
            continue;
          }
          const attributes = readAttributes(record.data.attributes);
          const time = record.data.timeUnixNano;
          records.push({
            name: readName(attributes, record.data.body),
            timeUnixNano: time === undefined ? null : String(time),
            attributes,
            resource: { ...resource },
          });
        }
      }
    }
    return { ok: true, records, skipped };
  } catch {
    // Defensive: a hostile object (getters, proxies) must not crash ingest.
    return { ok: false, error: 'body could not be read' };
  }
}
