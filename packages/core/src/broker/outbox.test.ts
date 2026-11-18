import { describe, expect, it } from 'vitest';
import { agentKey, CLIP_LIMITS, CONTROL_REASONS } from '@huddle/shared';
import { hookReply, NOTE_PREFIX } from '../ingest/hook-replies.js';
import { BrokerSim, payloads } from '../test/broker-sim.js';
import { MAX_OUTBOX } from '../state/reduce.js';
import { FOLLOW_UP_PREFIX, MAX_QUEUED_CHARS, OUTBOX_FULL, OUTBOX_TOO_LONG, queueMessage } from './outbox.js';

const MAIN = agentKey('session-1');
const SUB = agentKey('session-1', 'sub-1');

function queued(sim: BrokerSim, text: string, delivery: 'auto' | 'next_tool' | 'turn_end', key = MAIN) {
  const fx = sim.command({ type: 'agent.message', agentKey: key, text, delivery });
  expect(fx.result).toEqual({ ok: true });
  const event = fx.events[0];
  if (event?.type !== 'message.queued') throw new Error('not queued');
  return event.messageId;
}

describe('agent.message (F12)', () => {
  it('queues a clipped message; empty text is invalid; unknown agent not_found', () => {
    const sim = new BrokerSim().startSession();
    queued(sim, `  ${'m'.repeat(CLIP_LIMITS.message + 10)}  `, 'auto');
    const outbox = sim.state.agents[MAIN]?.outbox ?? [];
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.text.length).toBe(CLIP_LIMITS.message);
    expect(sim.command({ type: 'agent.message', agentKey: MAIN, text: '   ', delivery: 'auto' }).result).toMatchObject({
      code: 'invalid',
    });
    expect(sim.command({ type: 'agent.message', agentKey: 'x', text: 'hi', delivery: 'auto' }).result).toMatchObject({
      code: 'not_found',
    });
  });

  it('refuses a message once MAX_OUTBOX are queued, so the reducer never drops the oldest', () => {
    const sim = new BrokerSim().startSession();
    for (let i = 0; i < MAX_OUTBOX; i++) queued(sim, `m${String(i)}`, 'next_tool');
    const fx = sim.command({ type: 'agent.message', agentKey: MAIN, text: 'one more', delivery: 'next_tool' });
    expect(fx.result).toEqual({ ok: false, code: 'invalid', message: OUTBOX_FULL });
    expect(sim.state.agents[MAIN]?.outbox).toHaveLength(MAX_OUTBOX);
    expect(sim.ofType('message.dropped')).toEqual([]);
  });

  it('refuses a message that would make the queued text longer than MAX_QUEUED_CHARS; one delivery stays bounded', () => {
    const sim = new BrokerSim().startSession();
    const full = 'f'.repeat(CLIP_LIMITS.message);
    for (let i = 0; i < 3; i++) queued(sim, full, 'auto');
    // A fourth full message would pass the limit by the joins between them.
    const fx = sim.command({ type: 'agent.message', agentKey: MAIN, text: full, delivery: 'auto' });
    expect(fx.result).toEqual({ ok: false, code: 'invalid', message: OUTBOX_TOO_LONG });
    queued(sim, 'short', 'auto');
    const reply = sim.post(payloads.preToolUse('tu-1')).fx.reply;
    expect(reply.kind === 'preToolUse.note' ? reply.text.length : 0).toBeLessThanOrEqual(MAX_QUEUED_CHARS);
    // Delivered: the outbox is empty again and takes new messages.
    expect(sim.state.agents[MAIN]?.outbox ?? []).toEqual([]);
    queued(sim, full, 'auto');
  });

  it('a subagent cannot take a turn_end message (followUp false)', () => {
    const sim = new BrokerSim().startSession();
    sim.post(payloads.subagentStart('sub-1'));
    const fx = sim.command({ type: 'agent.message', agentKey: SUB, text: 'hi', delivery: 'turn_end' });
    expect(fx.result).toEqual({ ok: false, code: 'unsupported', message: CONTROL_REASONS.noFollowUp });
    expect(sim.ofType('message.queued')).toEqual([]);
  });
});

describe('delivery', () => {
  it('next PreToolUse answers at once with every next_tool and auto note joined; turn_end waits', () => {
    const sim = new BrokerSim().startSession();
    const a = queued(sim, 'first', 'next_tool');
    const b = queued(sim, 'second', 'auto');
    queued(sim, 'later', 'turn_end');
    const { fx, held } = sim.post(payloads.preToolUse('tu-1'));
    expect(held).toBeNull();
    expect(fx.reply).toEqual({ kind: 'preToolUse.note', text: 'first\n\nsecond' });
    expect(hookReply(fx.reply)).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: `${NOTE_PREFIX}first\n\nsecond` },
    });
    expect(sim.ofType('message.delivered').map((e) => [e.messageId, e.via])).toEqual([
      [a, 'pre_tool_context'],
      [b, 'pre_tool_context'],
    ]);
    expect(sim.state.agents[MAIN]?.outbox?.map((m) => m.text)).toEqual(['later']);
    // Nothing left for the next call.
    expect(sim.post(payloads.preToolUse('tu-2')).fx.reply).toEqual({ kind: 'none' });
  });

  it('Stop blocks once with every turn_end and auto message; the continuing Stop passes through', () => {
    const sim = new BrokerSim().startSession();
    queued(sim, 'one', 'turn_end');
    queued(sim, 'two', 'auto');
    const first = sim.post(payloads.stop(false));
    expect(first.fx.reply).toEqual({ kind: 'stop.block', reason: `${FOLLOW_UP_PREFIX}one\n\ntwo` });
    expect(hookReply(first.fx.reply)).toEqual({ decision: 'block', reason: `${FOLLOW_UP_PREFIX}one\n\ntwo` });
    expect(sim.ofType('message.delivered').map((e) => e.via)).toEqual(['stop_continuation', 'stop_continuation']);

    queued(sim, 'three', 'turn_end');
    // stop_hook_active: Claude Code is already continuing. Never block again.
    expect(sim.post(payloads.stop(true)).fx.reply).toEqual({ kind: 'none' });
    expect(sim.state.agents[MAIN]?.outbox?.map((m) => m.text)).toEqual(['three']);
  });

  it('Stop with only next_tool notes queued does not block', () => {
    const sim = new BrokerSim().startSession();
    queued(sim, 'note', 'next_tool');
    expect(sim.post(payloads.stop()).fx.reply).toEqual({ kind: 'none' });
  });

  it('a subagent gets its notes at its own next PreToolUse, not the main agent', () => {
    const sim = new BrokerSim().startSession();
    sim.post(payloads.subagentStart('sub-1'));
    queued(sim, 'for the sub', 'auto', SUB);
    expect(sim.post(payloads.preToolUse('tu-m')).fx.reply).toEqual({ kind: 'none' });
    expect(sim.post({ ...payloads.preToolUse('tu-s'), agent_id: 'sub-1' }).fx.reply).toEqual({
      kind: 'preToolUse.note',
      text: 'for the sub',
    });
  });
});

describe('cancel and drop', () => {
  it('message.cancel -> message.dropped cancelled; again -> expired', () => {
    const sim = new BrokerSim().startSession();
    const id = queued(sim, 'oops', 'auto');
    expect(sim.command({ type: 'message.cancel', agentKey: MAIN, messageId: id }).result).toEqual({ ok: true });
    expect(sim.ofType('message.dropped')).toEqual([
      expect.objectContaining({ messageId: id, reason: 'cancelled', source: 'user' }),
    ]);
    expect(sim.command({ type: 'message.cancel', agentKey: MAIN, messageId: id }).result).toMatchObject({
      code: 'expired',
    });
    expect(sim.post(payloads.preToolUse('tu-1')).fx.reply).toEqual({ kind: 'none' });
  });

  it('SessionEnd drops every queued message (agent_ended), main and subagents', () => {
    const sim = new BrokerSim().startSession();
    sim.post(payloads.subagentStart('sub-1'));
    const a = queued(sim, 'main', 'turn_end');
    const b = queued(sim, 'sub', 'next_tool', SUB);
    sim.post(payloads.sessionEnd());
    expect(sim.ofType('message.dropped').map((e) => [e.messageId, e.reason, e.agentKey])).toEqual([
      [a, 'agent_ended', MAIN],
      [b, 'agent_ended', SUB],
    ]);
  });

  it('a subagent ending drops its own queue only', () => {
    const sim = new BrokerSim().startSession();
    sim.post(payloads.subagentStart('sub-1'));
    queued(sim, 'main', 'auto');
    const b = queued(sim, 'sub', 'auto', SUB);
    sim.post(payloads.subagentStop('sub-1'));
    expect(sim.ofType('message.dropped').map((e) => e.messageId)).toEqual([b]);
    expect(sim.state.agents[MAIN]?.outbox).toHaveLength(1);
  });
});

describe('messages the Huddle writes itself (M6 P5b, ADR-027: the lead check)', () => {
  function byHuddle(sim: BrokerSim, text: string) {
    const fx = sim.apply(queueMessage(sim.view(), { agentKey: MAIN, text, delivery: 'auto' }, sim.ctx(), 'huddle'));
    expect(fx.result).toEqual({ ok: true });
    const event = fx.events[0];
    if (event?.type !== 'message.queued') throw new Error('not queued');
    expect(event.source).toBe('huddle');
    return event.messageId;
  }

  it('a note made only of Huddle messages has no "from the user" prefix; a user message keeps source user', () => {
    const sim = new BrokerSim().startSession();
    byHuddle(sim, 'Agent Huddle (an automatic check): teammate "a" is idle.');
    const reply = sim.post(payloads.preToolUse('tu-1')).fx.reply;
    expect(reply).toEqual({
      kind: 'preToolUse.note',
      text: 'Agent Huddle (an automatic check): teammate "a" is idle.',
      author: 'huddle',
    });
    const body = JSON.stringify(hookReply(reply));
    expect(body).not.toContain(NOTE_PREFIX);
    expect(body).toContain('Agent Huddle (an automatic check)');
    queued(sim, 'hello', 'auto');
    expect(sim.ofType('message.queued').map((e) => e.source)).toEqual(['huddle', 'user']);
  });

  it('a mixed note keeps the user prefix (the Huddle text still says who wrote it)', () => {
    const sim = new BrokerSim().startSession();
    queued(sim, 'from me', 'next_tool');
    byHuddle(sim, 'Agent Huddle (an automatic check): x');
    const reply = sim.post(payloads.preToolUse('tu-1')).fx.reply;
    expect(reply).toEqual({ kind: 'preToolUse.note', text: 'from me\n\nAgent Huddle (an automatic check): x' });
    expect(JSON.stringify(hookReply(reply))).toContain(NOTE_PREFIX);
  });

  it('the Stop continuation: no FOLLOW_UP_PREFIX for Huddle-only messages, kept for a mixed batch', () => {
    const sim = new BrokerSim().startSession();
    byHuddle(sim, 'check teammate a');
    expect(sim.post(payloads.stop(false)).fx.reply).toEqual({ kind: 'stop.block', reason: 'check teammate a' });
    const mixed = new BrokerSim().startSession();
    byHuddle(mixed, 'check teammate a');
    queued(mixed, 'and from me', 'turn_end');
    expect(mixed.post(payloads.stop(false)).fx.reply).toEqual({
      kind: 'stop.block',
      reason: `${FOLLOW_UP_PREFIX}check teammate a\n\nand from me`,
    });
  });

  it('goes through the same checks as a user message (a subagent cannot take turn_end, the outbox cap)', () => {
    const sim = new BrokerSim().startSession();
    for (let i = 0; i < MAX_OUTBOX; i++) queued(sim, `m${String(i)}`, 'next_tool');
    const fx = queueMessage(sim.view(), { agentKey: MAIN, text: 'x', delivery: 'auto' }, sim.ctx(), 'huddle');
    expect(fx.result).toEqual({ ok: false, code: 'invalid', message: OUTBOX_FULL });
  });
});
