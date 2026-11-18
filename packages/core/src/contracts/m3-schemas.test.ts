import { describe, expect, it } from 'vitest';
import { CLIP_LIMITS, type HuddleCommand, type HuddleEvent } from '@huddle/shared';
import { parseInteractionEvent, parseM3Command } from './m3-schemas.js';

const base = {
  id: '1763100000000-0001',
  ts: 1_763_100_000_000,
  sessionId: 's1',
  agentKey: 's1',
  source: 'huddle',
} as const;

const events: HuddleEvent[] = [
  { ...base, type: 'hold.started', toolUseId: 'toolu_01', limitAt: 1_763_100_595_000 },
  { ...base, type: 'hold.started', toolUseId: null, limitAt: 1_763_100_595_000 },
  { ...base, type: 'hold.ended', toolUseId: 'toolu_01', why: 'resumed' },
  { ...base, type: 'hold.ended', toolUseId: 'toolu_01', why: 'hold_limit' },
  { ...base, type: 'hold.ended', toolUseId: null, why: 'closed_by_claude_code' },
  { ...base, type: 'hold.ended', toolUseId: 'toolu_01', why: 'shutdown' },
  { ...base, type: 'question.closed', requestId: 'q1', outcome: 'passed_through' },
  { ...base, type: 'question.closed', requestId: 'q1', outcome: 'expired' },
  { ...base, type: 'question.closed', requestId: 'q1', outcome: 'answered_elsewhere' },
  { ...base, type: 'question.closed', requestId: 'q1', outcome: 'shutdown' },
  { ...base, source: 'user', type: 'message.queued', messageId: 'm1', text: 'use pnpm', delivery: 'auto' },
  { ...base, source: 'user', type: 'message.queued', messageId: 'm2', text: 'stop', delivery: 'turn_end' },
  { ...base, type: 'message.delivered', messageId: 'm1', via: 'pre_tool_context' },
  { ...base, type: 'message.dropped', messageId: 'm2', reason: 'cancelled' },
  { ...base, type: 'message.dropped', messageId: 'm2', reason: 'agent_ended' },
  {
    ...base,
    type: 'approval.resolved',
    requestId: 'r1',
    outcome: 'passed_through',
    by: 'shutdown',
    policyRuleId: null,
    message: null,
  },
  {
    ...base,
    source: 'user',
    type: 'approval.resolved',
    requestId: 'r2',
    outcome: 'denied',
    by: 'user',
    policyRuleId: null,
    message: 'use the test database',
  },
  {
    ...base,
    type: 'approval.resolved',
    requestId: 'r3',
    outcome: 'allowed',
    by: 'user',
    policyRuleId: null,
    message: null,
    // M4 (F18): an ask rule sent it to the user
    askedByRuleId: 'ask-git',
  },
  {
    ...base,
    type: 'approval.resolved',
    requestId: 'r4',
    outcome: 'allowed',
    by: 'policy',
    policyRuleId: 'default:git-status',
    message: null,
  },
];

describe('M3 event schemas', () => {
  it.each(events.map((e) => [`${e.type} ${JSON.stringify(e).slice(-60)}`, e] as const))(
    'round-trips %s through JSON',
    (_label, event) => {
      const json: unknown = JSON.parse(JSON.stringify(event));
      expect(parseInteractionEvent(json)).toEqual(event);
    },
  );

  it('keeps unknown extra fields', () => {
    const parsed = parseInteractionEvent({ ...base, type: 'hold.ended', toolUseId: 't', why: 'resumed', later: 'x' });
    expect(parsed).toMatchObject({ later: 'x', why: 'resumed' });
  });

  it('clips free text instead of rejecting it', () => {
    const long = 'a'.repeat(CLIP_LIMITS.message + 50);
    const queued = parseInteractionEvent({
      ...base,
      type: 'message.queued',
      messageId: 'm',
      text: long,
      delivery: 'auto',
    });
    expect(queued?.type === 'message.queued' ? queued.text.length : -1).toBe(CLIP_LIMITS.message);
    const denied = parseInteractionEvent({
      ...base,
      type: 'approval.resolved',
      requestId: 'r',
      outcome: 'denied',
      by: 'user',
      policyRuleId: null,
      message: long,
    });
    expect(denied?.type === 'approval.resolved' ? denied.message?.length : -1).toBe(CLIP_LIMITS.message);
  });

  it('rejects wrong shapes without throwing', () => {
    const bad: unknown[] = [
      null,
      'hold.started',
      [],
      { ...base, type: 'hold.started', toolUseId: 't' }, // no limitAt
      { ...base, type: 'hold.started', toolUseId: 't', limitAt: 'soon' },
      { ...base, type: 'hold.ended', toolUseId: 't', why: 'bored' },
      { ...base, type: 'question.closed', requestId: '', outcome: 'expired' },
      { ...base, type: 'question.closed', requestId: 'q', outcome: 'answered' },
      { ...base, type: 'message.dropped', messageId: 'm', reason: 'lost' },
      { ...base, type: 'message.queued', messageId: 'm', text: 'x', delivery: 'soon' },
      {
        ...base,
        type: 'approval.resolved',
        requestId: 'r',
        outcome: 'allowed',
        by: 'robot',
        policyRuleId: null,
        message: null,
      },
      { ...base, ts: -1, type: 'hold.ended', toolUseId: 't', why: 'resumed' },
      { ...base, source: 'mystery', type: 'hold.ended', toolUseId: 't', why: 'resumed' },
      { ...base, type: 'tool.started' }, // not an interaction event
    ];
    for (const input of bad) {
      expect(() => parseInteractionEvent(input)).not.toThrow();
      expect(parseInteractionEvent(input)).toBeNull();
    }
  });
});

describe('M3 command schemas', () => {
  const commands: HuddleCommand[] = [
    { type: 'message.cancel', agentKey: 's1::a1', messageId: 'm1' },
    { type: 'settings.update', patch: {} },
    {
      type: 'settings.update',
      patch: {
        detectors: { stuckMinutes: 10 },
        toasts: { loop: false },
        questionHoldSeconds: 0,
        globalShortcut: 'Alt+F9',
      },
    },
    { type: 'settings.update', patch: { widgetCollapsed: true } },
  ];

  it.each(commands.map((c) => [c.type, c] as const))('round-trips %s through JSON', (_label, command) => {
    expect(parseM3Command(JSON.parse(JSON.stringify(command)))).toEqual(command);
  });

  it('keeps unknown extra fields', () => {
    expect(parseM3Command({ type: 'message.cancel', agentKey: 's', messageId: 'm', extra: 1 })).toMatchObject({
      extra: 1,
    });
  });

  it('rejects wrong shapes without throwing', () => {
    const bad: unknown[] = [
      undefined,
      { type: 'message.cancel', agentKey: 's' },
      { type: 'message.cancel', agentKey: '', messageId: 'm' },
      { type: 'settings.update' },
      { type: 'settings.update', patch: { questionHoldSeconds: 10_000 } },
      { type: 'settings.update', patch: { toasts: { approval: 1 } } },
      { type: 'settings.update', patch: { widgetCollapsed: 'yes' } },
      { type: 'agent.pause', agentKey: 's' }, // existing command, validated by desktop's validate.ts
    ];
    for (const input of bad) {
      expect(() => parseM3Command(input)).not.toThrow();
      expect(parseM3Command(input)).toBeNull();
    }
  });
});
