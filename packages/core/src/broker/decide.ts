/**
 * The broker's pure decision function (M3 WP5): `decide(view, input, ctx) -> effects`. No I/O, no clock, no state of
 * its own: what is held comes in `view.held`, everything else is reducer state, and time is `ctx.now`.
 *
 * Hooks (only these are ever held; every other hook, and every non-held answer, is decided at once):
 *   PermissionRequest  -> approvals.ts (hold, or a rule decides).
 *   PreToolUse         -> AskUserQuestion: questions.ts (the question path wins over a pause);
 *                         an unknown agent: no decision;
 *                         a paused agent: hold (pause.ts);
 *                         else the queued notes, if any (outbox.ts).
 *   Stop               -> outbox.ts (one continuation with the queued follow-ups, never when Claude Code is continuing).
 * Evidence that a terminal prompt is over also ends the matching held approvals (approvals.ts; 2.1.325 keeps the request
 * open after the terminal answered it): PostToolUse / PostToolUseFailure / PermissionDenied of the same call, the
 * agent's Stop or SubagentStop, a UserPromptSubmit for the main agent, SessionEnd.
 * An agent the reducer does not know, or whose capabilities say no, gets no decision at once.
 */
import {
  allowHeldMatchingPolicy,
  approvalClosed,
  approvalHoldLimit,
  approvalRefused,
  approvalShutdown,
  approvalsAnsweredElsewhere,
  decideApproval,
  heldApproval,
  missingApproval,
  onPermissionRequest,
  passThroughApproval,
} from './approvals.js';
import { questionItemId } from '../state/reduce.js';
import {
  agentOf,
  commandResult,
  effects,
  type BrokerCommand,
  type BrokerCtx,
  type BrokerEffects,
  type BrokerInput,
  type BrokerView,
  type HeldEntry,
  type Release,
} from './model.js';
import { cancelMessage, onPreToolUseNotes, onStop, queueMessage } from './outbox.js';
import {
  holdForPause,
  isPaused,
  pauseAgent,
  pauseAll,
  pauseClosed,
  pauseHoldLimit,
  pauseShutdown,
  resumeAgent,
  resumeAll,
} from './pause.js';
import {
  answerQuestion,
  heldQuestion,
  onAskUserQuestion,
  passQuestionToTerminal,
  questionClosed,
  questionRefused,
  questionShutdown,
  questionWindowOver,
} from './questions.js';

export function decide(view: BrokerView, input: BrokerInput, ctx: BrokerCtx): BrokerEffects {
  switch (input.type) {
    case 'hook':
      return decideHook(view, input, ctx);
    case 'command':
      return decideCommand(view, input.command, ctx, input.via);
    case 'timer': {
      const entry = findHeld(view, input.holdId);
      if (entry === undefined) return effects();
      if (entry.kind === 'approval') return approvalHoldLimit(entry, ctx);
      if (entry.kind === 'question') return questionWindowOver(entry, ctx);
      return pauseHoldLimit(entry, ctx);
    }
    case 'closed': {
      const entry = findHeld(view, input.holdId);
      if (entry === undefined) return effects();
      if (entry.kind === 'approval') return approvalClosed(entry, input.why, ctx);
      if (entry.kind === 'question') return questionClosed(entry, input.why, ctx);
      return pauseClosed(entry, input.why, ctx);
    }
    case 'refused': {
      const entry = input.plan.entry;
      if (entry.kind === 'approval') return approvalRefused(entry, input.why, ctx);
      if (entry.kind === 'question') return questionRefused(entry, input.why, ctx);
      return effects();
    }
    case 'shutdown': {
      const all = view.held.map((entry) => shutdownOne(entry, ctx));
      return effects({ releases: all.flatMap((e) => e.releases) });
    }
  }
}

function findHeld(view: BrokerView, holdId: string): HeldEntry | undefined {
  return view.held.find((h) => h.holdId === holdId);
}

function shutdownOne(entry: HeldEntry, ctx: BrokerCtx): BrokerEffects {
  if (entry.kind === 'approval') return approvalShutdown(entry, ctx);
  if (entry.kind === 'question') return questionShutdown(entry, ctx);
  return pauseShutdown(entry, ctx);
}

function decideHook(view: BrokerView, input: Extract<BrokerInput, { type: 'hook' }>, ctx: BrokerCtx): BrokerEffects {
  const facts = input.facts;
  switch (facts.kind) {
    case 'permission_request':
      return onPermissionRequest(
        view,
        {
          sessionId: facts.sessionId,
          agentKey: facts.agentKey,
          receivedAt: input.receivedAt,
          requestId: input.approvalRequestId,
          call: facts.call,
          askUserQuestion: facts.askUserQuestion,
          policy: facts.policy,
        },
        ctx,
      );
    case 'tool_ended':
      return effects({
        releases: approvalsAnsweredElsewhere(
          view,
          { kind: 'call_ended', agentKey: facts.agentKey, call: facts.call },
          ctx,
        ),
      });
    case 'turn_over':
      return effects({
        releases: approvalsAnsweredElsewhere(view, { kind: 'turn_over', agentKey: facts.agentKey }, ctx),
      });
    case 'session_over':
      return effects({
        releases: approvalsAnsweredElsewhere(view, { kind: 'session_over', sessionId: facts.sessionId }, ctx),
      });
    case 'pre_tool_use': {
      if (facts.askUserQuestion) {
        return onAskUserQuestion(
          view,
          {
            sessionId: facts.sessionId,
            agentKey: facts.agentKey,
            receivedAt: input.receivedAt,
            toolUseId: facts.toolUseId,
            requestId: input.questionRequestId,
            question: facts.question,
          },
          ctx,
        );
      }
      const node = agentOf(view.state, facts.agentKey);
      if (node === undefined) return effects();
      if (isPaused(view, node)) {
        return holdForPause(
          view,
          {
            sessionId: facts.sessionId,
            agentKey: facts.agentKey,
            receivedAt: input.receivedAt,
            toolUseId: facts.toolUseId,
          },
          ctx,
        );
      }
      return onPreToolUseNotes(view, facts.agentKey, ctx);
    }
    case 'stop': {
      // The turn is over, so no terminal prompt of this agent is still open; then the queued follow-ups, if any.
      const ended = approvalsAnsweredElsewhere(view, { kind: 'turn_over', agentKey: facts.agentKey }, ctx);
      return withReleases(onStop(view, { agentKey: facts.agentKey, continuing: facts.continuing }, ctx), ended);
    }
    case 'other':
      return effects();
  }
}

function withReleases(fx: BrokerEffects, releases: Release[]): BrokerEffects {
  return releases.length === 0 ? fx : { ...fx, releases: [...releases, ...fx.releases] };
}

function decideCommand(view: BrokerView, cmd: BrokerCommand, ctx: BrokerCtx, via?: 'phone'): BrokerEffects {
  switch (cmd.type) {
    case 'approval.decide':
      return decideApproval(
        view,
        {
          requestId: cmd.requestId,
          decision: cmd.decision,
          ...(cmd.message !== undefined ? { message: cmd.message } : {}),
          ...(via !== undefined ? { via } : {}),
        },
        ctx,
      );
    case 'approval.passThrough': {
      // Also "answer in terminal" for a held question (its request id is the tool_use_id, an approval's a Huddle id).
      const approval = heldApproval(view, cmd.requestId);
      if (approval !== undefined) return passThroughApproval(approval, ctx);
      const question = heldQuestion(view, cmd.requestId);
      if (question !== undefined) return passQuestionToTerminal(question, ctx);
      if (view.state.inbox.some((i) => i.id === questionItemId(cmd.requestId))) {
        return commandResult({ ok: false, code: 'expired', message: 'This question was already answered or closed.' });
      }
      return missingApproval(view, cmd.requestId);
    }
    case 'approval.allowAllMatchingPolicy':
      return allowHeldMatchingPolicy(view, ctx);
    case 'question.answer':
      return answerQuestion(
        view,
        {
          requestId: cmd.requestId,
          answers: cmd.answers,
          ...(cmd.other !== undefined ? { other: cmd.other } : {}),
          ...(cmd.freeText !== undefined ? { freeText: cmd.freeText } : {}),
        },
        ctx,
        via,
      );
    case 'agent.message':
      return queueMessage(view, cmd, ctx, 'user', via);
    case 'message.cancel':
      return cancelMessage(view, cmd, ctx);
    case 'agent.pause':
      return pauseAgent(view, cmd.agentKey, ctx, via !== undefined ? { source: 'user', detail: null, via } : undefined);
    case 'agent.resume':
      return resumeAgent(view, cmd.agentKey, ctx, via);
    case 'all.pause':
      return pauseAll(view, ctx);
    case 'all.resume':
      return resumeAll(view, ctx);
  }
}
