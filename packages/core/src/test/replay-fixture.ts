/**
 * Test helper: turn a recorded fixture into the HuddleEvents the app would log, the way the servers do it.
 * Hook lines go through parseHookPayload -> normalizeHook; otlp-logs lines through parseOtlpLogs ->
 * normalizeTelemetry; statusline lines through
 * parseStatuslinePayload -> normalizeStatusline. Lines are replayed in file (receive) order with one deterministic id counter, and each
 * line's own timestamp as the receive time. Not exported from the package.
 */
import type { HuddleEvent } from '@huddle/shared';
import { parseOtlpLogs } from '../ingest/otlp-schemas.js';
import { parseHookPayload } from '../ingest/schemas.js';
import { parseStatuslinePayload } from '../ingest/statusline-schema.js';
import { normalizeHook } from '../normalize/hooks.js';
import { normalizeStatusline } from '../normalize/statusline.js';
import { normalizeTelemetry } from '../normalize/telemetry.js';
import { readFixture } from './fixtures.js';

export function fixtureEvents(name: string): HuddleEvent[] {
  let n = 0;
  const nextId = (): string => {
    n += 1;
    return `evt-${String(n).padStart(4, '0')}`;
  };
  const events: HuddleEvent[] = [];
  for (const line of readFixture(name)) {
    if (line.kind === 'hook') {
      const parsed = parseHookPayload(line.payload);
      if (!parsed.ok) throw new Error(`${name}: hook line did not parse: ${parsed.error}`);
      events.push(...normalizeHook(parsed, { receivedAt: line.t, nextId }));
    } else if (line.kind === 'otlp-logs') {
      const parsed = parseOtlpLogs(line.payload);
      if (!parsed.ok) throw new Error(`${name}: otlp-logs line did not parse: ${parsed.error}`);
      events.push(...normalizeTelemetry(parsed.records, { receivedAt: line.t, nextId }));
    } else if (line.kind === 'statusline') {
      const parsed = parseStatuslinePayload(line.payload);
      if (!parsed.ok) throw new Error(`${name}: statusline line did not parse: ${parsed.error}`);
      events.push(...normalizeStatusline(parsed.payload, { receivedAt: line.t, nextId }));
    }
  }
  return events;
}
