/**
 * Approvals (F10): a PermissionRequest is held until the user, a rule, Claude Code or shutdown ends it. Pure.
 *
 * Endings, each written as one `approval.resolved`:
 *  1. user:       `approval.decide` allow / deny (+ message), or `approval.passThrough` (answered with no decision, so
 *                 Claude Code's own prompt carries on, S1) -> by 'user'.
 *  2. rule:       `view.ruleDecision` (M4, F18: policy/) answers at arrival -> by 'policy' + rule id. allow: allowed;
 *                 deny: denied with a message naming the rule (`permission.denyByRule`, never the user's DENY_PREFIX);
 *                 ask: held for the user as without rules, the rule id noted (`askedByRuleId` on the ending).
 *                 `approval.allowAllMatchingPolicy` checks the held requests again and allows those an allow rule
 *                 matches now: managed sessions whose run is live only (`managedRunLive`), until S15 shows what a
 *                 late allow does after a terminal "No".
 *  3. Claude Code closed the request -> 'expired' (by 'timeout') when within EXPIRY_WINDOW_MS of its timeout, else
 *                 'answered_elsewhere' (by 'claude_code'), most likely answered in the terminal. Inferred from timing.
 *     Or the terminal prompt is over while the request is still open: Claude Code 2.1.325 does not close a held
 *                 PermissionRequest when the terminal answers it (SPIKES S1, 2026-11-14). Evidence for the same agent:
 *                 the same tool call ended (PostToolUse / PostToolUseFailure / PermissionDenied with the same tool name
 *                 and input digest or summary), or its turn is over (Stop, SubagentStop, a new UserPromptSubmit for the
 *                 main agent), or the session ended. Answered with no decision (Claude Code ignores it by then) ->
 *                 'answered_elsewhere' by 'claude_code', the same shape as an early close.
 *  4. shutdown:   answered with no decision -> 'passed_through' by 'shutdown'.
 * Plus the self-release at timeout - 5 s: answered with no decision -> 'expired' by 'timeout'.
 * A refused hold (cap reached, or closing) was answered with no decision by the server -> 'passed_through'.
 */
import {
  agentKey,
  CLIP_LIMITS,
  isTerminal,
  type AgentKey,
  type ApprovalRequest,
  type HuddleState,
} from '@huddle/shared';
import type { PolicyFacts, ToolCallKey } from '../normalize/hook-facts.js';
import { clip } from '../text.js';
import { approvalItemId } from '../state/reduce.js';
import {
  agentOf,
  closedAtTimeout,
  commandResult,
  effects,
  holdLimitAt,
  makeEvent,
  managedRunLive,
  noRuleDecision,
  type BrokerCtx,
  type BrokerEffects,
  type BrokerView,
  type EventFields,
  type HeldEntry,
  type Release,
} from './model.js';

type Resolution = Omit<EventFields<'approval.resolved'>, 'type' | 'requestId'>;

function resolved(ctx: BrokerCtx, entry: HeldEntry, source: 'user' | 'huddle', r: Resolution) {
  const asked = entry.askedByRuleId ?? null;
  return makeEvent<'approval.resolved'>(ctx, entry, source, {
    type: 'approval.resolved',
    requestId: entry.requestId ?? '',
    ...r,
    ...(asked !== null ? { askedByRuleId: asked } : {}),
  });
}

/** The trusted session folder (F18): the root node's `sessionCwd`, set once by the reducer. */
function sessionCwdOf(state: HuddleState, sessionId: string): string | null {
  return agentOf(state, agentKey(sessionId))?.sessionCwd ?? null;
}

/** The request as the inbox shows it, if any. */
export function approvalRequestOf(state: HuddleState, requestId: string): ApprovalRequest | null {
  const item = state.inbox.find((i) => i.id === approvalItemId(requestId));
  return item?.approval ?? null;
}

/**
 * A PermissionRequest arrived. Holds it when the agent is known and can be approved from the Huddle.
 * AskUserQuestion is never held: it is Claude Code's own question box, which the user is about to answer in the terminal.
 */
export function onPermissionRequest(
  view: BrokerView,
  hook: {
    sessionId: string;
    agentKey: string;
    receivedAt: number;
    requestId: string | null;
    call: ToolCallKey | null;
    askUserQuestion: boolean;
    /** Raw facts for the approval rules (in memory only); null when the hook carried none. */
    policy?: PolicyFacts | null;
  },
  ctx: BrokerCtx,
): BrokerEffects {
  if (hook.askUserQuestion) return effects();
  const node = agentOf(view.state, hook.agentKey);
  // Unknown agent (e.g. a subagent never seen start), no request event, or no capability: never hold.
  if (node === undefined || hook.requestId === null || !node.capabilities.approve || isTerminal(node.status)) {
    return effects();
  }
  const entry: HeldEntry = {
    holdId: ctx.nextId(),
    kind: 'approval',
    agentKey: hook.agentKey,
    sessionId: hook.sessionId,
    requestId: hook.requestId,
    toolUseId: null,
    receivedAt: hook.receivedAt,
    timeoutAt: hook.receivedAt + view.timeouts.permissionRequest,
    question: null,
    call: hook.call,
    policy: hook.policy ?? null,
  };

  // Ending 2 is decided here, before anything is held. The request's `approval.requested` is already in the reducer's
  // state, but this runs synchronously in the same tick and listeners get events in later batches, so no window ever
  // shows (or toasts) an open item for a request a rule decided.
  const request = approvalRequestOf(view.state, hook.requestId);
  const verdict =
    request === null
      ? null
      : (view.ruleDecision ?? noRuleDecision)({
          request,
          node,
          facts: hook.policy ?? null,
          sessionCwd: sessionCwdOf(view.state, node.sessionId),
          managedRunLive: managedRunLive(view, node),
        });
  if (verdict !== null && verdict.decision !== 'ask') {
    return ruleDecided(entry, { decision: verdict.decision, ruleId: verdict.ruleId, message: verdict.message }, ctx);
  }
  const held: HeldEntry = verdict === null ? entry : { ...entry, askedByRuleId: clip(verdict.ruleId, CLIP_LIMITS.id) };
  return effects({ hold: { entry: held, timers: [{ at: holdLimitAt(held), kind: 'hold_limit' }], events: [] } });
}

/** A rule allowed or denied a request: the reply and its `approval.resolved` by 'policy'. */
function ruleDecided(
  entry: HeldEntry,
  verdict: { decision: 'allow' | 'deny'; ruleId: string; message: string | null },
  ctx: BrokerCtx,
): BrokerEffects {
  const release = ruleRelease(entry, verdict, ctx);
  return effects({ reply: release.reply, events: release.events });
}

function ruleRelease(
  entry: HeldEntry,
  verdict: { decision: 'allow' | 'deny'; ruleId: string; message: string | null },
  ctx: BrokerCtx,
): Release {
  const ruleId = clip(verdict.ruleId, CLIP_LIMITS.id);
  // A rule's deny always says which rule refused, even when the hook gave no message.
  const message =
    verdict.decision === 'deny'
      ? clip(verdict.message ?? `Denied by an Agent Huddle rule (${ruleId}).`, CLIP_LIMITS.message)
      : null;
  return {
    holdId: entry.holdId,
    reply:
      verdict.decision === 'allow'
        ? { kind: 'permission.allow' }
        : { kind: 'permission.denyByRule', message: message ?? '' },
    events: [
      resolved(ctx, entry, 'huddle', {
        outcome: verdict.decision === 'allow' ? 'allowed' : 'denied',
        by: 'policy',
        policyRuleId: ruleId,
        message,
      }),
    ],
  };
}

/**
 * `approval.allowAllMatchingPolicy` (M4, F18): check every held approval again against the rules as they are now and
 * allow those an allow rule matches. Managed sessions only until S15 is run: for an attached session the terminal
 * prompt may already have been answered "No", and what a late allow does then is not known (SPIKES S15). Requests a
 * deny or ask rule matches, or no rule, stay held. Pure.
 */
export function allowHeldMatchingPolicy(view: BrokerView, ctx: BrokerCtx): BrokerEffects {
  const hook = view.ruleDecision ?? noRuleDecision;
  const releases: Release[] = [];
  for (const entry of view.held) {
    if (entry.kind !== 'approval' || entry.requestId === null) continue;
    const node = agentOf(view.state, entry.agentKey);
    // Managed and live: a managed root resumed in a terminal after its run ended is attached for this (L1).
    if (node === undefined || !managedRunLive(view, node) || !node.capabilities.approve) continue;
    const request = approvalRequestOf(view.state, entry.requestId);
    if (request === null) continue;
    const verdict = hook({
      request,
      node,
      facts: entry.policy ?? null,
      sessionCwd: sessionCwdOf(view.state, node.sessionId),
      managedRunLive: true,
    });
    if (verdict?.decision !== 'allow') continue;
    releases.push(ruleRelease(entry, { decision: 'allow', ruleId: verdict.ruleId, message: null }, ctx));
  }
  const n = releases.length;
  return commandResult(
    { ok: true, detail: n === 1 ? '1 request allowed by a rule.' : `${String(n)} requests allowed by rules.` },
    { releases },
  );
}

/** No held request with this id: already answered (expired) or never seen (not found). */
export function missingApproval(view: BrokerView, requestId: string): BrokerEffects {
  if (approvalRequestOf(view.state, requestId) !== null) {
    return commandResult({
      ok: false,
      code: 'expired',
      message: 'This request was already answered or has timed out.',
    });
  }
  return commandResult({ ok: false, code: 'not_found', message: 'That request is not known.' });
}

export function heldApproval(view: BrokerView, requestId: string): HeldEntry | undefined {
  return view.held.find((h) => h.kind === 'approval' && h.requestId === requestId);
}

/** `approval.decide`: allow, or deny with an optional message the agent reads (S1). */
export function decideApproval(
  view: BrokerView,
  cmd: { requestId: string; decision: 'allow' | 'deny'; message?: string; via?: 'phone' },
  ctx: BrokerCtx,
): BrokerEffects {
  const entry = heldApproval(view, cmd.requestId);
  if (entry === undefined) return missingApproval(view, cmd.requestId);
  const trimmed = cmd.decision === 'deny' ? (cmd.message ?? '').trim() : '';
  const message = trimmed === '' ? null : clip(trimmed, CLIP_LIMITS.message);
  return commandResult(
    { ok: true },
    {
      releases: [
        {
          holdId: entry.holdId,
          reply:
            cmd.decision === 'allow'
              ? { kind: 'permission.allow' }
              : { kind: 'permission.deny', ...(message !== null ? { message } : {}) },
          events: [
            resolved(ctx, entry, 'user', {
              outcome: cmd.decision === 'allow' ? 'allowed' : 'denied',
              by: 'user',
              policyRuleId: null,
              message,
              // M6 (F26): a decision made on a paired phone says so; the desktop's stays as before (absent).
              ...(cmd.via !== undefined ? { via: cmd.via } : {}),
            }),
          ],
        },
      ],
    },
  );
}

/** `approval.passThrough`: answer with no decision, so Claude Code's own prompt is the way to answer (S1). */
export function passThroughApproval(entry: HeldEntry, ctx: BrokerCtx): BrokerEffects {
  return commandResult(
    { ok: true },
    {
      releases: [
        {
          holdId: entry.holdId,
          reply: { kind: 'none' },
          events: [
            resolved(ctx, entry, 'user', {
              outcome: 'passed_through',
              by: 'user',
              policyRuleId: null,
              message: null,
            }),
          ],
        },
      ],
    },
  );
}

/** Self-release just before the hook timeout. */
export function approvalHoldLimit(entry: HeldEntry, ctx: BrokerCtx): BrokerEffects {
  return effects({
    releases: [
      {
        holdId: entry.holdId,
        reply: { kind: 'none' },
        events: [
          resolved(ctx, entry, 'huddle', { outcome: 'expired', by: 'timeout', policyRuleId: null, message: null }),
        ],
      },
    ],
  });
}

/** The hold ended without the broker answering: Claude Code closed it, or the server released it on shutdown. */
export function approvalClosed(
  entry: HeldEntry,
  why: 'closed_by_claude_code' | 'shutdown',
  ctx: BrokerCtx,
): BrokerEffects {
  if (why === 'shutdown') {
    return effects({
      events: [
        resolved(ctx, entry, 'huddle', {
          outcome: 'passed_through',
          by: 'shutdown',
          policyRuleId: null,
          message: null,
        }),
      ],
    });
  }
  const expired = closedAtTimeout(entry, ctx.now);
  return effects({
    events: [
      resolved(ctx, entry, 'huddle', {
        outcome: expired ? 'expired' : 'answered_elsewhere',
        by: expired ? 'timeout' : 'claude_code',
        policyRuleId: null,
        message: null,
      }),
    ],
  });
}

/** Evidence, from a hook, that a terminal prompt is over. */
export type PromptOver =
  /** This agent's tool call ended. */
  | { kind: 'call_ended'; agentKey: AgentKey; call: ToolCallKey }
  /** This agent's turn is over. */
  | { kind: 'turn_over'; agentKey: AgentKey }
  /** The session ended. */
  | { kind: 'session_over'; sessionId: string };

/**
 * The same tool call: same tool name, and the same input digest or (when both say more than the tool name) the same
 * summary. A parallel call of the same agent with another input never matches.
 */
export function sameCall(a: ToolCallKey, b: ToolCallKey): boolean {
  if (a.toolName !== b.toolName) return false;
  if (a.digest === b.digest) return true;
  return a.summary !== null && a.summary === b.summary;
}

function isOverBy(entry: HeldEntry, over: PromptOver): boolean {
  if (entry.kind !== 'approval') return false;
  switch (over.kind) {
    case 'call_ended':
      return entry.agentKey === over.agentKey && entry.call !== null && sameCall(entry.call, over.call);
    case 'turn_over':
      return entry.agentKey === over.agentKey;
    case 'session_over':
      return entry.sessionId === over.sessionId;
  }
}

/**
 * Ending 3 without a close: the terminal prompt behind these held approvals is over, but Claude Code kept the request
 * open (2.1.325, SPIKES S1). Each is answered with no decision, which Claude Code ignores by now, and recorded as
 * answered elsewhere by Claude Code. For a call that ended, only the oldest matching hold ends (one PostToolUse is one
 * call). Pure.
 */
export function approvalsAnsweredElsewhere(view: BrokerView, over: PromptOver, ctx: BrokerCtx): Release[] {
  const matching = view.held.filter((h) => isOverBy(h, over));
  // One PostToolUse is one call: end one hold, preferring an exact digest match over a summary match (two long commands
  // can share a clipped summary; security review 2026-11-14).
  const exact =
    over.kind === 'call_ended'
      ? matching.find((h) => h.call !== null && h.call.digest === over.call.digest)
      : undefined;
  const ending = over.kind === 'call_ended' ? (exact !== undefined ? [exact] : matching.slice(0, 1)) : matching;
  return ending.map((entry) => ({
    holdId: entry.holdId,
    reply: { kind: 'none' },
    events: [
      resolved(ctx, entry, 'huddle', {
        outcome: 'answered_elsewhere',
        by: 'claude_code',
        policyRuleId: null,
        message: null,
      }),
    ],
  }));
}

/** Ending 4, from the broker's own shutdown: answer with no decision. */
export function approvalShutdown(entry: HeldEntry, ctx: BrokerCtx): BrokerEffects {
  return effects({
    releases: [
      {
        holdId: entry.holdId,
        reply: { kind: 'none' },
        events: [
          resolved(ctx, entry, 'huddle', {
            outcome: 'passed_through',
            by: 'shutdown',
            policyRuleId: null,
            message: null,
          }),
        ],
      },
    ],
  });
}

/** The server would not hold it and answered with no decision: Claude Code's own prompt handles it. */
export function approvalRefused(entry: HeldEntry, why: 'cap' | 'closing', ctx: BrokerCtx): BrokerEffects {
  return effects({
    events: [
      resolved(ctx, entry, 'huddle', {
        outcome: 'passed_through',
        by: why === 'closing' ? 'shutdown' : 'claude_code',
        policyRuleId: null,
        message: null,
      }),
    ],
  });
}
