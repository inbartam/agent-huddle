/**
 * The lead's answer about an idle teammate (M6 P5b, ADR-027): a PostToolUse for `mcp__huddle__report_teammate` becomes
 * `teammate.reported` on the caller's key. Replays fixtures/agent-team-report.jsonl (the S20 team run with two lead
 * answers added; derived, not recorded) and checks single payloads for every field rule.
 */
import { describe, expect, it } from 'vitest';
import { agentKey, CLIP_LIMITS, type HuddleEvent } from '@huddle/shared';
import { parseHookPayload } from '../ingest/schemas.js';
import { fixtureEvents } from '../test/replay-fixture.js';
import { normalizeHook } from './hooks.js';
import { readTeammateReport, TEAMMATE_NAME_MAX, teammateReportSummary } from './self-report.js';

const SID = '00000000-0000-4000-8000-000000000002';
const TOOL = 'mcp__huddle__report_teammate';

function ofType<T extends HuddleEvent['type']>(events: readonly HuddleEvent[], type: T) {
  return events.filter((e): e is Extract<HuddleEvent, { type: T }> => e.type === type);
}

function post(toolInput: unknown, extra: Record<string, unknown> = {}): HuddleEvent[] {
  const parsed = parseHookPayload({
    session_id: SID,
    hook_event_name: 'PostToolUse',
    tool_name: TOOL,
    tool_use_id: 'tu-1',
    tool_input: toolInput,
    ...extra,
  });
  if (!parsed.ok) throw new Error(parsed.error);
  let n = 0;
  return normalizeHook(parsed, { receivedAt: '2026-11-16T12:00:00.000Z', nextId: () => `e${String((n += 1))}` });
}

describe('agent-team-report.jsonl (derived from S20 b)', () => {
  const events = fixtureEvents('agent-team-report.jsonl');

  it('emits one teammate.reported per answer, on the lead (the caller), in order', () => {
    const reports = ofType(events, 'teammate.reported');
    expect(reports.map((r) => [r.agentKey, r.teammateName, r.status, r.note])).toEqual([
      [agentKey(SID), 'alpha', 'finished', null],
      [agentKey(SID), 'beta', 'waiting', 'waits for the reply'],
    ]);
  });

  it('still logs the call as an ordinary tool call with a readable summary', () => {
    const started = ofType(events, 'tool.started').filter((e) => e.toolName === TOOL);
    expect(started.map((e) => e.summary)).toEqual([
      'reported teammate alpha finished',
      'reported teammate beta waiting: waits for the reply',
    ]);
  });

  it('comes from PostToolUse only (a call that went through), right after its tool.finished', () => {
    events.forEach((e, i) => {
      if (e.type !== 'teammate.reported') return;
      const before = events[i - 1];
      expect(before?.type === 'tool.finished' && before.toolName === TOOL).toBe(true);
    });
  });
});

describe('PostToolUse(report_teammate), field by field', () => {
  it('is put on the caller: the lead without agent_id, a subagent with one', () => {
    expect(ofType(post({ name: 'alpha', status: 'finished' }), 'teammate.reported')[0]?.agentKey).toBe(agentKey(SID));
    const fromSub = post({ name: 'alpha', status: 'waiting' }, { agent_id: 'a0000000000000009', agent_type: 'x' });
    expect(ofType(fromSub, 'teammate.reported')[0]?.agentKey).toBe(agentKey(SID, 'a0000000000000009'));
  });

  it('emits an unknown name too (the reducer decides), trimmed', () => {
    expect(ofType(post({ name: '  nobody ', status: 'finished' }), 'teammate.reported')[0]?.teammateName).toBe(
      'nobody',
    );
  });

  it.each([
    [{}],
    [{ name: 'alpha' }],
    [{ status: 'finished' }],
    [{ name: '', status: 'finished' }],
    [{ name: '   ', status: 'finished' }],
    [{ name: 'x'.repeat(TEAMMATE_NAME_MAX + 1), status: 'finished' }],
    [{ name: 'al\u0007pha', status: 'finished' }],
    [{ name: 'al‮pha', status: 'finished' }],
    [{ name: 7, status: 'finished' }],
    [{ name: 'alpha', status: 'done' }],
    [{ name: 'alpha', status: 'FINISHED' }],
    [null],
    [['alpha', 'finished']],
    ['alpha finished'],
  ])('emits nothing for an unusable input %j', (input) => {
    const events = post(input);
    expect(ofType(events, 'teammate.reported')).toEqual([]);
    expect(ofType(events, 'tool.finished')).toHaveLength(1);
  });

  it('keeps a usable name and status when only the note is bad', () => {
    expect(readTeammateReport({ name: 'beta', status: 'waiting', note: 5 })).toEqual({
      teammateName: 'beta',
      status: 'waiting',
      note: null,
    });
    expect(readTeammateReport({ name: 'beta', status: 'waiting', note: '   ' })?.note).toBeNull();
  });

  it('masks and clips the note', () => {
    const secret = 'sk-ant-api03-' + 'A'.repeat(40);
    const note = readTeammateReport({
      name: 'beta',
      status: 'waiting',
      note: `token ${secret} ${'y'.repeat(900)}`,
    })?.note;
    expect(note).not.toContain(secret);
    expect(note?.length).toBeLessThanOrEqual(CLIP_LIMITS.summary);
  });

  it('ignores unknown fields and never reads tool_response or the prototype', () => {
    const report = readTeammateReport(
      JSON.parse('{"name":"a","status":"finished","__proto__":{"note":"x"},"extra":1}'),
    );
    expect(report).toEqual({ teammateName: 'a', status: 'finished', note: null });
    const events = post({ name: 'a', status: 'finished' }, { tool_response: { content: 'secret output' } });
    expect(JSON.stringify(events)).not.toContain('secret output');
  });

  it('summarizes an unusable call without inventing fields', () => {
    expect(teammateReportSummary({})).toBe('reported a teammate');
  });

  it('matches the tool name exactly', () => {
    const parsed = parseHookPayload({
      session_id: SID,
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__other__report_teammate',
      tool_input: { name: 'alpha', status: 'finished' },
    });
    if (!parsed.ok) throw new Error(parsed.error);
    const events = normalizeHook(parsed, { receivedAt: '2026-11-16T12:00:00.000Z', nextId: () => 'e' });
    expect(ofType(events, 'teammate.reported')).toEqual([]);
  });
});
