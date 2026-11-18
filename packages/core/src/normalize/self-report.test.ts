/**
 * F27 self-reported progress (spike S19): PostToolUse(mcp__huddle__report_progress) -> progress.reported.
 * Replays fixtures/mcp-progress.jsonl (S19 e2: four main-agent reports and one subagent report) and the edge cases
 * of the boundary check, built on the fixture's own payloads.
 */
import { describe, expect, it } from 'vitest';
import { agentKey, CLIP_LIMITS, type HuddleEvent } from '@huddle/shared';
import { parseHookPayload } from '../ingest/schemas.js';
import { HUDDLE_PROGRESS_TOOL } from '../ingest/huddle-mcp.js';
import { readFixture } from '../test/fixtures.js';
import { fixtureEvents } from '../test/replay-fixture.js';
import { normalizeHook } from './hooks.js';
import { MAX_MINUTES_LEFT, progressReportSummary, readProgressReport } from './self-report.js';

const FIXTURE = 'mcp-progress.jsonl';
const SECRET = 'ghp_0123456789abcdefghijABCDEFGHIJ';

function ctx(): { receivedAt: string; nextId: () => string } {
  let n = 0;
  return { receivedAt: '2026-11-16T12:00:00.000Z', nextId: () => `evt-${String(++n)}` };
}

function normalize(payload: unknown): HuddleEvent[] {
  const parsed = parseHookPayload(payload);
  if (!parsed.ok) throw new Error(parsed.error);
  return normalizeHook(parsed, ctx());
}

/** The fixture's first report payload for `event`, from the main agent (or the subagent), with `patch` merged in. */
function reportPayload(
  event: 'PreToolUse' | 'PostToolUse',
  patch: Record<string, unknown> = {},
  subagent = false,
): Record<string, unknown> {
  const line = readFixture(FIXTURE).find((l) => {
    const p = l.payload as Record<string, unknown>;
    return l.event === event && p.tool_name === HUDDLE_PROGRESS_TOOL && (p.agent_id !== undefined) === subagent;
  });
  if (!line) throw new Error(`no ${event} report in fixture`);
  return { ...(line.payload as Record<string, unknown>), ...patch };
}

function reports(events: readonly HuddleEvent[]) {
  return events.filter((e): e is Extract<HuddleEvent, { type: 'progress.reported' }> => e.type === 'progress.reported');
}

function withInput(input: unknown): HuddleEvent[] {
  return normalize(reportPayload('PostToolUse', { tool_input: input }));
}

describe('mcp-progress.jsonl (S19 e2)', () => {
  const events = fixtureEvents(FIXTURE);
  const main = agentKey('session-1');
  const sub = agentKey('session-1', 'agent-1');

  it('emits one progress.reported per successful call, on the calling agent', () => {
    expect(reports(events).map((e) => [e.agentKey, e.fraction, e.etaMinutes, e.note])).toEqual([
      [main, 0.05, 2, 'step 1 started'],
      [main, 0.3, 2, 'step 1 done, step 2 next'],
      [main, 0.6, 1, 'step 2 done, step 3 next'],
      [sub, 1, 0, 'subagent task done'],
      [main, 1, 0, 'all steps done'],
    ]);
  });

  it('keeps the ordinary tool events for each call, with a readable summary', () => {
    const started = events.filter((e) => e.type === 'tool.started' && e.toolName === HUDDLE_PROGRESS_TOOL);
    const finished = events.filter((e) => e.type === 'tool.finished' && e.toolName === HUDDLE_PROGRESS_TOOL);
    expect(started).toHaveLength(5);
    expect(finished).toHaveLength(5);
    expect(started[0]).toMatchObject({ summary: 'reported progress 5%, 2 min left: step 1 started' });
  });

  it('reads the report only from PostToolUse: PreToolUse and a failed call give none', () => {
    expect(reports(normalize(reportPayload('PreToolUse')))).toEqual([]);
    const failed = { ...reportPayload('PostToolUse'), hook_event_name: 'PostToolUseFailure', error: 'denied' };
    expect(reports(normalize(failed))).toEqual([]);
  });

  it('never stores tool_response, even when the payload has one', () => {
    const out = normalize(reportPayload('PostToolUse', { tool_response: [{ type: 'text', text: `ok ${SECRET}` }] }));
    expect(JSON.stringify(out)).not.toContain('tool_response');
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(reports(out)).toHaveLength(1);
  });
});

describe('the tool name must match exactly', () => {
  it.each([
    'mcp__other__report_progress',
    'mcp__huddle__report_progress2',
    'mcp__Huddle__report_progress',
    'report_progress',
    'mcp__huddle__other',
  ])('%s gives no report', (name) => {
    const out = normalize(reportPayload('PostToolUse', { tool_name: name }));
    expect(reports(out)).toEqual([]);
    expect(out.map((e) => e.type)).toEqual(['tool.finished']);
  });
});

describe('boundary check of tool_input (zod)', () => {
  it('a subagent report lands on the subagent key, never on the main agent', () => {
    const out = reports(normalize(reportPayload('PostToolUse', {}, true)));
    expect(out.map((e) => e.agentKey)).toEqual([agentKey('session-1', 'agent-1')]);
  });

  it.each<[string, unknown, number | null]>([
    ['a string', '0.5', null],
    ['Infinity (JSON 1e400 parses to it)', Number.POSITIVE_INFINITY, null],
    ['negative', -0.2, 0],
    ['above 1', 1.7, 1],
    ['a percent by mistake', 40, 1],
    ['null', null, null],
    ['a boolean', true, null],
    ['an object', { value: 0.5 }, null],
    ['in range', 0.42, 0.42],
  ])('fraction %s', (_label, fraction, expected) => {
    const out = reports(withInput({ fraction, note: 'n' }));
    expect(out[0]?.fraction).toBe(expected);
  });

  it('NaN and Infinity (as a JS value, from a test or a future transport) are refused', () => {
    expect(readProgressReport({ fraction: Number.NaN, minutesLeft: Number.POSITIVE_INFINITY })).toBeNull();
  });

  it.each<[string, unknown, number | null]>([
    ['a string', '5', null],
    ['negative', -1, null],
    ['zero', 0, 0],
    ['fractional', 2.5, 2.5],
    ['huge', 1e9, MAX_MINUTES_LEFT],
    ['just above 24 h', 24 * 60 + 1, MAX_MINUTES_LEFT],
    ['Infinity', Number.POSITIVE_INFINITY, null],
  ])('minutesLeft %s', (_label, minutesLeft, expected) => {
    const out = reports(withInput({ minutesLeft, note: 'n' }));
    expect(out[0]?.etaMinutes).toBe(expected);
  });

  it('masks a secret in the note and in the summary', () => {
    const out = withInput({ fraction: 0.5, note: `pushed with token ${SECRET}` });
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(reports(out)[0]?.note).toContain('pushed with token');
  });

  it('collapses whitespace and clips a long note to CLIP_LIMITS.summary', () => {
    const note = reports(withInput({ note: `line one\n\n  line two ${'x'.repeat(5000)}` }))[0]?.note ?? '';
    expect(note.startsWith('line one line two x')).toBe(true);
    expect(note.length).toBe(CLIP_LIMITS.summary);
    expect(note.endsWith('…')).toBe(true);
  });

  it('a blank note or a non-string note counts as no note', () => {
    expect(reports(withInput({ note: '   \n ' }))).toEqual([]);
    expect(reports(withInput({ note: 42 }))).toEqual([]);
    expect(reports(withInput({ fraction: 0.1, note: ['a'] }))[0]?.note).toBeNull();
  });

  it('ignores unknown fields and never copies them', () => {
    const out = reports(withInput({ fraction: 0.2, extra: SECRET, content: 'file text', minutes: 4 }));
    expect(out).toHaveLength(1);
    const fields = Object.keys(out[0] ?? {}).filter((k) => k !== 'id' && k !== 'ts');
    expect(fields.sort()).toEqual(['agentKey', 'etaMinutes', 'fraction', 'note', 'sessionId', 'source', 'type']);
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  it('a call with none of the three usable gives no event, only the tool event', () => {
    for (const input of [{}, { fraction: 'half' }, { minutesLeft: -3 }, { other: 1 }]) {
      const out = withInput(input);
      expect(reports(out)).toEqual([]);
      expect(out.map((e) => e.type)).toEqual(['tool.finished']);
    }
    expect(readProgressReport(null)).toBeNull();
    expect(readProgressReport([0.5])).toBeNull();
    expect(readProgressReport('0.5')).toBeNull();
  });

  it('a key named like an Object.prototype member is not read from the prototype', () => {
    expect(readProgressReport(Object.create({ fraction: 0.5 }) as unknown)).toBeNull();
  });

  it('a partial report keeps the missing fields null', () => {
    expect(readProgressReport({ minutesLeft: 3 })).toEqual({ fraction: null, etaMinutes: 3, note: null });
    expect(readProgressReport({ note: 'reading' })).toEqual({ fraction: null, etaMinutes: null, note: 'reading' });
  });
});

describe('progressReportSummary (timeline line)', () => {
  it.each<[unknown, string]>([
    [{ fraction: 0.4 }, 'reported progress 40%'],
    [{ minutesLeft: 12.4 }, 'reported progress 12 min left'],
    [{ minutesLeft: 2.25 }, 'reported progress 2.3 min left'],
    [{ note: 'reading' }, 'reported progress: reading'],
    [{ fraction: 1, minutesLeft: 0, note: 'done' }, 'reported progress 100%, 0 min left: done'],
    [{}, 'reported progress'],
    ['junk', 'reported progress'],
  ])('%j -> %s', (input, expected) => {
    expect(progressReportSummary(input)).toBe(expected);
  });
});
