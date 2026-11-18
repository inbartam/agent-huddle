/**
 * Outbox (F12): messages the user writes to an attached agent, delivered at the agent's next hook that can carry them.
 * Pure. The queue itself is reducer state (`AgentNode.outbox`, from `message.*` events); this file only decides.
 *
 *  - `next_tool`: as `additionalContext` on the agent's next PreToolUse that is not held for a pause (S7a). Every queued
 *    `next_tool` and `auto` note goes in one reply, joined; the reply builder adds NOTE_PREFIX.
 *  - `turn_end`: on the main agent's Stop as `{decision: 'block', reason}` (S7b), every queued `turn_end` and `auto`
 *    message joined into one reason. Never when `stop_hook_active` (Claude Code is already continuing): at most one
 *    block per Stop, and a message is delivered once because delivery removes it. Subagents: not allowed (followUp).
 *  - `auto`: whichever of the two comes first.
 *  - A managed root (ADR-020 §5): whatever is still queued when its turn ends goes to stdin (runtime/runs.ts
 *    `flushOutbox`, `message.delivered via:'stream_input'`).
 *  - Bounded at queue time: at most MAX_OUTBOX messages and MAX_QUEUED_CHARS of text per agent, else `invalid`.
 *  - Cancel -> `message.dropped cancelled`. The agent's end (the reducer empties its outbox) -> `message.dropped
 *    agent_ended` for every message that was not delivered.
 * Notes and Stop answers are given at once, never held. The broker never writes a message the user did not write, with
 * one exception the owner chose (M6 P5b, ADR-027): the lead check on an idle teammate (`queueMessage` with author
 * 'huddle', source 'huddle'). Such a message labels itself; a delivery made only of Huddle messages carries no "from the
 * user" prefix (NOTE_PREFIX / FOLLOW_UP_PREFIX), a mixed one keeps the user's prefix and the Huddle text still says who
 * wrote it.
 */
import {
  CLIP_LIMITS,
  CONTROL_REASONS,
  selectControls,
  type AgentNode,
  type HuddleEvent,
  type HuddleState,
  type QueuedMessage,
} from '@huddle/shared';
import { clip } from '../text.js';
import { MAX_OUTBOX } from '../state/reduce.js';
import {
  agentOf,
  commandResult,
  effects,
  makeEvent,
  type BrokerCtx,
  type BrokerEffects,
  type BrokerView,
  type Release,
  whoOf,
} from './model.js';

/** Opens a Stop continuation, so the agent knows who wrote it (the PreToolUse note has NOTE_PREFIX). */
export const FOLLOW_UP_PREFIX = 'Message from the user via Agent Huddle: ';

/** Between messages delivered together (a note, a Stop reason, or one stdin message of a managed run). */
export const OUTBOX_JOIN = '\n\n';

/**
 * Most text queued for one agent, all messages joined: four full-length messages. Everything queued can land in one
 * reply (an `auto` message joins either delivery), so this bounds what one note or Stop reason carries.
 */
export const MAX_QUEUED_CHARS = CLIP_LIMITS.message * 4;

/** Refusals at queue time, so the reducer's outbox cap never drops a message and no delivery grows without bound. */
export const OUTBOX_FULL = 'Too many queued messages for this agent. Wait until they are delivered, or take one back.';
export const OUTBOX_TOO_LONG =
  'The queued messages for this agent are too long together. Wait until they are delivered, or take one back.';

/** selectControls reads the connection; the broker answers whenever hooks arrive, so it is taken as attached. */
const LIVE = { status: 'attached', message: null } as const;

export function controlsOf(view: BrokerView, node: AgentNode) {
  return selectControls(node, LIVE, view.huddleStartedAt ?? undefined);
}

function outboxOf(node: AgentNode | undefined): QueuedMessage[] {
  return node?.outbox ?? [];
}

/** Queued messages that land on the next PreToolUse. */
export function notesFor(node: AgentNode | undefined): QueuedMessage[] {
  return outboxOf(node).filter((m) => m.delivery === 'next_tool' || m.delivery === 'auto');
}

/** Every message in the batch was written by the Huddle (M6 P5b): the delivery then has no 'from the user' prefix. */
function allByHuddle(messages: readonly QueuedMessage[]): boolean {
  return messages.length > 0 && messages.every((m) => m.author === 'huddle');
}

/** Queued messages that land on the main agent's Stop. */
function followUpsFor(node: AgentNode | undefined): QueuedMessage[] {
  return outboxOf(node).filter((m) => m.delivery === 'turn_end' || m.delivery === 'auto');
}

function delivered(
  ctx: BrokerCtx,
  node: AgentNode,
  messages: QueuedMessage[],
  via: 'pre_tool_context' | 'stop_continuation',
): HuddleEvent[] {
  return messages.map((m) =>
    makeEvent<'message.delivered'>(ctx, whoOf(node), 'huddle', {
      type: 'message.delivered',
      messageId: m.messageId,
      via,
    }),
  );
}

/** The note reply for the agent's queued notes (none queued: no decision), with its delivery events. */
export function noteReply(
  node: AgentNode | undefined,
  ctx: BrokerCtx,
): { reply: Release['reply']; events: HuddleEvent[] } {
  const notes = notesFor(node);
  if (node === undefined || notes.length === 0 || node.capabilities.message === 'none') {
    return { reply: { kind: 'none' }, events: [] };
  }
  return {
    reply: {
      kind: 'preToolUse.note',
      text: notes.map((m) => m.text).join(OUTBOX_JOIN),
      ...(allByHuddle(notes) ? { author: 'huddle' as const } : {}),
    },
    events: delivered(ctx, node, notes, 'pre_tool_context'),
  };
}

/** A PreToolUse not held for a pause: deliver the queued notes, if any. */
export function onPreToolUseNotes(view: BrokerView, key: string, ctx: BrokerCtx): BrokerEffects {
  const { reply, events } = noteReply(agentOf(view.state, key), ctx);
  return effects({ reply, events });
}

/** The main agent's Stop: one continuation with every queued follow-up, unless Claude Code is already continuing. */
export function onStop(
  view: BrokerView,
  hook: { agentKey: string; continuing: boolean },
  ctx: BrokerCtx,
): BrokerEffects {
  if (hook.continuing) return effects();
  const node = agentOf(view.state, hook.agentKey);
  if (node === undefined || node.capabilities.followUp !== true) return effects();
  const messages = followUpsFor(node);
  if (messages.length === 0) return effects();
  return effects({
    reply: {
      kind: 'stop.block',
      reason: (allByHuddle(messages) ? '' : FOLLOW_UP_PREFIX) + messages.map((m) => m.text).join(OUTBOX_JOIN),
    },
    events: delivered(ctx, node, messages, 'stop_continuation'),
  });
}

/**
 * `agent.message`. `author` 'huddle' (M6 P5b): the Huddle wrote it (the lead check, ADR-027); the event's source is then
 * 'huddle' instead of 'user', and every check below applies the same.
 */
export function queueMessage(
  view: BrokerView,
  cmd: { agentKey: string; text: string; delivery: 'auto' | 'next_tool' | 'turn_end' },
  ctx: BrokerCtx,
  author: 'user' | 'huddle' = 'user',
  via?: 'phone',
): BrokerEffects {
  const node = agentOf(view.state, cmd.agentKey);
  if (node === undefined) return commandResult({ ok: false, code: 'not_found', message: 'That agent is not known.' });
  const controls = controlsOf(view, node);
  if (!controls.message.enabled) {
    return commandResult({
      ok: false,
      code: 'unsupported',
      message: controls.message.reason ?? CONTROL_REASONS.noMessage,
    });
  }
  if (node.capabilities.message !== 'queued' && node.capabilities.message !== 'live') {
    return commandResult({ ok: false, code: 'unsupported', message: CONTROL_REASONS.noMessage });
  }
  // 'live' (a managed root, ADR-020 §5): HuddleCore writes to the run's stdin itself while the root is idle and only
  // hands the message here while a turn runs (stdin is read only after a `result`, S8): the note at the next tool
  // call or the follow-up at the turn's end carries it then, as for an attached session.
  if (cmd.delivery === 'turn_end' && !controls.messageTurnEnd.enabled) {
    return commandResult({
      ok: false,
      code: 'unsupported',
      message: controls.messageTurnEnd.reason ?? CONTROL_REASONS.noFollowUp,
    });
  }
  const text = cmd.text.trim();
  if (text === '') return commandResult({ ok: false, code: 'invalid', message: 'The message is empty.' });
  const queued = outboxOf(node);
  if (queued.length >= MAX_OUTBOX) return commandResult({ ok: false, code: 'invalid', message: OUTBOX_FULL });
  const clipped = clip(text, CLIP_LIMITS.message);
  const joined = [...queued.map((m) => m.text), clipped].join(OUTBOX_JOIN).length;
  if (joined > MAX_QUEUED_CHARS) return commandResult({ ok: false, code: 'invalid', message: OUTBOX_TOO_LONG });
  return commandResult(
    { ok: true },
    {
      events: [
        makeEvent<'message.queued'>(ctx, whoOf(node), author, {
          type: 'message.queued',
          messageId: ctx.nextId(),
          text: clipped,
          delivery: cmd.delivery,
          ...(via !== undefined ? { via } : {}),
        }),
      ],
    },
  );
}

/** `message.cancel`. */
export function cancelMessage(
  view: BrokerView,
  cmd: { agentKey: string; messageId: string },
  ctx: BrokerCtx,
): BrokerEffects {
  const node = agentOf(view.state, cmd.agentKey);
  if (node === undefined) return commandResult({ ok: false, code: 'not_found', message: 'That agent is not known.' });
  if (!outboxOf(node).some((m) => m.messageId === cmd.messageId)) {
    return commandResult({ ok: false, code: 'expired', message: 'That message was already delivered or taken back.' });
  }
  return commandResult(
    { ok: true },
    {
      events: [
        makeEvent<'message.dropped'>(ctx, whoOf(node), 'user', {
          type: 'message.dropped',
          messageId: cmd.messageId,
          reason: 'cancelled',
        }),
      ],
    },
  );
}

/**
 * Messages the reducer took out of an outbox because the agent ended (`session.ended`, `agent.stopped`), between
 * `before` and `after`, that `batch` did not deliver or drop: each becomes `message.dropped agent_ended`.
 */
export function droppedByEnd(
  before: HuddleState,
  after: HuddleState,
  batch: readonly HuddleEvent[],
  ctx: BrokerCtx,
): HuddleEvent[] {
  const settled = new Set<string>();
  for (const e of batch) if (e.type === 'message.delivered' || e.type === 'message.dropped') settled.add(e.messageId);
  const out: HuddleEvent[] = [];
  for (const node of Object.values(before.agents)) {
    const queued = node.outbox ?? [];
    if (queued.length === 0) continue;
    const now = agentOf(after, node.key);
    const left = new Set(outboxOf(now).map((m) => m.messageId));
    for (const m of queued) {
      if (left.has(m.messageId) || settled.has(m.messageId)) continue;
      out.push(
        makeEvent<'message.dropped'>(ctx, whoOf(node), 'huddle', {
          type: 'message.dropped',
          messageId: m.messageId,
          reason: 'agent_ended',
        }),
      );
    }
  }
  return out;
}
