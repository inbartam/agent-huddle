/**
 * Pure builders from an abstract decision to the JSON body Claude Code reads from an HTTP hook reply.
 *
 * Only ingest/ knows these shapes (CONTRIBUTING.md rule 2): the broker says *what* it decided
 * (`HookReplyDecision`), this file says how Claude Code wants it spelled. Every shape is ported from the
 * M0 experiments, proven there, and matches
 * docs/INTEGRATION.md "Decisions a hook can return":
 *  - PermissionRequest allow / deny with message: S1 (deny message quoted and acted on). The message goes out after
 *    DENY_PREFIX, so the agent knows who wrote it: a bare instruction read as unattributed tool output (M3 runbook,
 *    2026-11-14: "Do not run it. Reply with exactly the word NOPE-1" was treated as odd output; a natural one worked).
 *  - PreToolUse allow with `updatedInput: { ...toolInput, answers }` for AskUserQuestion: S5 (single-select).
 *  - PreToolUse `additionalContext` note: S7a (lands on the next model turn).
 *  - Stop `{ decision: 'block', reason }`: S7b (continues the turn; the next Stop has `stop_hook_active`).
 *  - No decision: `null`, sent as an empty 200 (S6: the call proceeds as if the hook was not there).
 *
 * No clock, no I/O, no clipping: callers clip free text with `CLIP_LIMITS` before it gets here.
 */
import type { HookReplyBody } from './hook-server.js';

/** Prefix of every note the user sends through PreToolUse `additionalContext` (S7a, M3 plan "Outbox"). */
export const NOTE_PREFIX = 'Note from the user via Agent Huddle: ';

/** Prefix of a deny message the user wrote in the Huddle. The stored event keeps the message without it. */
export const DENY_PREFIX = 'Denied by the user in Agent Huddle. Their message: ';

/** AskUserQuestion answers: question text → chosen option label (single-select only until S14 proves more). */
export type QuestionAnswers = Readonly<Record<string, string>>;

export type HookReplyDecision =
  /** No decision: Claude Code carries on as usual (its own prompt, its own question box). */
  | { kind: 'none' }
  /** PermissionRequest: allow this tool call. */
  | { kind: 'permission.allow' }
  /** PermissionRequest: deny, optionally telling the agent why (it reads and acts on the message, S1). `message` is without DENY_PREFIX. */
  | { kind: 'permission.deny'; message?: string }
  /**
   * PermissionRequest: deny because an approval rule said so (M4, F18). `message` is sent as is (it names the rule):
   * never with DENY_PREFIX, which says the user wrote it. Same S1 shape as `permission.deny`.
   */
  | { kind: 'permission.denyByRule'; message: string }
  /** PreToolUse(AskUserQuestion): allow with the answers filled in. `toolInput` is the call's own `tool_input`. */
  | { kind: 'preToolUse.answer'; toolInput: Readonly<Record<string, unknown>>; answers: QuestionAnswers }
  /**
   * PreToolUse: no permission decision, only a note for the model's next turn. `text` is without the prefix. `author`
   * 'huddle' (M6 P5b): every message in it was written by the Huddle, which labels its own text, so NOTE_PREFIX ("from
   * the user") is not added.
   */
  | { kind: 'preToolUse.note'; text: string; author?: 'huddle' }
  /** Stop: keep the main agent going with `reason` as its next instruction. Never when `stop_hook_active`. */
  | { kind: 'stop.block'; reason: string };

/** The reply body for a decision, or null for "no decision" (sent as an empty 200). */
export function hookReply(decision: HookReplyDecision): HookReplyBody | null {
  switch (decision.kind) {
    case 'none':
      return null;
    case 'permission.allow':
      return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } };
    case 'permission.deny': {
      const deny: Record<string, unknown> = { behavior: 'deny' };
      if (decision.message !== undefined && decision.message.length > 0) deny.message = DENY_PREFIX + decision.message;
      return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: deny } };
    }
    case 'permission.denyByRule': {
      const deny: Record<string, unknown> = { behavior: 'deny' };
      if (decision.message.length > 0) deny.message = decision.message;
      return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: deny } };
    }
    case 'preToolUse.answer':
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          updatedInput: { ...decision.toolInput, answers: { ...decision.answers } },
        },
      };
    case 'preToolUse.note':
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          additionalContext: (decision.author === 'huddle' ? '' : NOTE_PREFIX) + decision.text,
        },
      };
    case 'stop.block':
      return { decision: 'block', reason: decision.reason };
  }
}
