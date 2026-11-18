/**
 * Pause and resume (F13): a pause is a held PreToolUse (S6). Pure.
 *
 *  - `agent.pause` -> `control.applied pause`; the reducer sets `pausePending`. The agent's next PreToolUse is held ->
 *    `hold.started {toolUseId, limitAt}`; while the agent has a pause hold, its parallel PreToolUses are held too (S6).
 *  - `agent.resume` -> `control.applied resume` and every pause hold of the agent is answered: the first one carries
 *    the queued next_tool / auto notes (if any), the rest no decision -> `hold.ended resumed` each.
 *  - `all.pause` / `all.resume`: the same for every live attached agent that can be paused.
 *  - Endings: resume (user); self-release at timeout - 5 s -> `hold_limit` (the agent continues, and the UI says so);
 *    Claude Code closed it -> `closed_by_claude_code` (logged as a warning: a frozen Huddle would look like this);
 *    shutdown -> `shutdown`. A refused hold writes nothing: `pausePending` stays and the next tool call tries again.
 *  - An AskUserQuestion while paused takes the question path (decide.ts): answering it is what the user wants then.
 */
import { CONTROL_REASONS, isTerminal, type AgentNode, type HuddleEvent } from '@huddle/shared';
import {
  agentOf,
  commandResult,
  effects,
  holdLimitAt,
  makeEvent,
  whoOf,
  type BrokerCtx,
  type BrokerEffects,
  type BrokerView,
  type HeldEntry,
  type Release,
} from './model.js';
import { controlsOf, noteReply } from './outbox.js';

function pauseHoldsOf(view: BrokerView, key: string): HeldEntry[] {
  return view.held.filter((h) => h.kind === 'pause' && h.agentKey === key);
}

/** Should this agent's PreToolUse be held for a pause? */
export function isPaused(view: BrokerView, node: AgentNode): boolean {
  if (!node.capabilities.pause || isTerminal(node.status)) return false;
  return node.pausePending === true || pauseHoldsOf(view, node.key).length > 0;
}

/** Hold this PreToolUse of a paused agent. */
export function holdForPause(
  view: BrokerView,
  hook: { sessionId: string; agentKey: string; receivedAt: number; toolUseId: string | null },
  ctx: BrokerCtx,
): BrokerEffects {
  const entry: HeldEntry = {
    holdId: ctx.nextId(),
    kind: 'pause',
    agentKey: hook.agentKey,
    sessionId: hook.sessionId,
    requestId: null,
    toolUseId: hook.toolUseId,
    receivedAt: hook.receivedAt,
    timeoutAt: hook.receivedAt + view.timeouts.preToolUse,
    question: null,
    call: null,
  };
  const limitAt = holdLimitAt(entry);
  return effects({
    hold: {
      entry,
      timers: [{ at: limitAt, kind: 'hold_limit' }],
      events: [
        makeEvent<'hold.started'>(ctx, entry, 'huddle', { type: 'hold.started', toolUseId: hook.toolUseId, limitAt }),
      ],
    },
  });
}

function ended(
  ctx: BrokerCtx,
  entry: HeldEntry,
  why: 'resumed' | 'hold_limit' | 'closed_by_claude_code' | 'shutdown',
  source: 'user' | 'huddle',
) {
  return makeEvent<'hold.ended'>(ctx, entry, source, { type: 'hold.ended', toolUseId: entry.toolUseId, why });
}

/** Who asked for a pause: the user (a command), or the Huddle itself (a budget, F19) with a detail naming why. */
export interface PauseBy {
  source: 'user' | 'huddle';
  detail: string | null;
  /** M6 (ADR-030): a paired phone asked for it. */
  via?: 'phone';
}

const BY_USER: PauseBy = { source: 'user', detail: null };

function control(ctx: BrokerCtx, node: AgentNode, action: 'pause' | 'resume', by: PauseBy = BY_USER): HuddleEvent {
  return makeEvent<'control.applied'>(ctx, whoOf(node), by.source, {
    type: 'control.applied',
    action,
    detail: by.detail,
    ...(by.via !== undefined ? { via: by.via } : {}),
  });
}

/** The releases that resume one agent: notes ride on the first held call. */
function resumeReleases(view: BrokerView, node: AgentNode, ctx: BrokerCtx): Release[] {
  const holds = pauseHoldsOf(view, node.key);
  return holds.map((entry, index) => {
    const note = index === 0 ? noteReply(node, ctx) : { reply: { kind: 'none' } as const, events: [] };
    return { holdId: entry.holdId, reply: note.reply, events: [ended(ctx, entry, 'resumed', 'user'), ...note.events] };
  });
}

/**
 * `agent.pause`. Already paused or pausing: ok, nothing new. `by`: the user unless the Huddle pauses on its own (a
 * budget, F19), which writes `control.applied` with source 'huddle'. The same capability checks apply either way.
 */
export function pauseAgent(view: BrokerView, key: string, ctx: BrokerCtx, by: PauseBy = BY_USER): BrokerEffects {
  const node = agentOf(view.state, key);
  if (node === undefined) return commandResult({ ok: false, code: 'not_found', message: 'That agent is not known.' });
  if (isPaused(view, node)) return commandResult({ ok: true, detail: CONTROL_REASONS.alreadyPaused });
  const pause = controlsOf(view, node).pause;
  if (!pause.enabled) {
    return commandResult({ ok: false, code: 'unsupported', message: pause.reason ?? CONTROL_REASONS.noPause });
  }
  return commandResult({ ok: true }, { events: [control(ctx, node, 'pause', by)] });
}

/** `agent.resume`. */
export function resumeAgent(view: BrokerView, key: string, ctx: BrokerCtx, via?: 'phone'): BrokerEffects {
  const node = agentOf(view.state, key);
  if (node === undefined) return commandResult({ ok: false, code: 'not_found', message: 'That agent is not known.' });
  if (!isPaused(view, node)) return commandResult({ ok: false, code: 'expired', message: CONTROL_REASONS.notPaused });
  return commandResult(
    { ok: true },
    {
      events: [control(ctx, node, 'resume', via !== undefined ? { source: 'user', detail: null, via } : BY_USER)],
      releases: resumeReleases(view, node, ctx),
    },
  );
}

/** Live, attached, pausable agents (replayed history and ended agents are left alone). */
function liveAttached(view: BrokerView): AgentNode[] {
  const started = view.huddleStartedAt;
  return Object.values(view.state.agents).filter(
    (n) =>
      n.origin === 'attached' &&
      n.capabilities.pause &&
      !isTerminal(n.status) &&
      n.endedAt === null &&
      (started === null || n.lastEventAt >= started),
  );
}

/** `all.pause`. */
export function pauseAll(view: BrokerView, ctx: BrokerCtx): BrokerEffects {
  const targets = liveAttached(view).filter((n) => !isPaused(view, n));
  return commandResult(
    { ok: true, detail: `Pausing ${String(targets.length)} agent${targets.length === 1 ? '' : 's'}.` },
    { events: targets.map((n) => control(ctx, n, 'pause')) },
  );
}

/** `all.resume`: every paused or pausing agent, live or not (a pending pause is always safe to call off). */
export function resumeAll(view: BrokerView, ctx: BrokerCtx): BrokerEffects {
  const targets = Object.values(view.state.agents).filter((n) => isPaused(view, n));
  return commandResult(
    { ok: true, detail: `Resuming ${String(targets.length)} agent${targets.length === 1 ? '' : 's'}.` },
    {
      events: targets.map((n) => control(ctx, n, 'resume')),
      releases: targets.flatMap((n) => resumeReleases(view, n, ctx)),
    },
  );
}

/** Self-release just before the hook timeout: the agent continues. */
export function pauseHoldLimit(entry: HeldEntry, ctx: BrokerCtx): BrokerEffects {
  return effects({
    releases: [{ holdId: entry.holdId, reply: { kind: 'none' }, events: [ended(ctx, entry, 'hold_limit', 'huddle')] }],
  });
}

export function pauseClosed(
  entry: HeldEntry,
  why: 'closed_by_claude_code' | 'shutdown',
  ctx: BrokerCtx,
): BrokerEffects {
  return effects({
    events: [ended(ctx, entry, why, 'huddle')],
    warnings:
      why === 'closed_by_claude_code'
        ? [
            {
              message: 'pause hold closed by Claude Code before the Huddle released it',
              data: { agentKey: entry.agentKey, heldMs: ctx.now - entry.receivedAt },
            },
          ]
        : [],
  });
}

export function pauseShutdown(entry: HeldEntry, ctx: BrokerCtx): BrokerEffects {
  return effects({
    releases: [{ holdId: entry.holdId, reply: { kind: 'none' }, events: [ended(ctx, entry, 'shutdown', 'huddle')] }],
  });
}
