/**
 * zod schemas for the M3 contracts (WP1): the events the broker writes (holds, closed questions, the outbox) and the
 * two commands M3 adds (`message.cancel`, `settings.update`).
 *
 * They live in core, not next to the types in `@huddle/shared`, because shared has no runtime dependencies. Desktop
 * main may import them (dependency direction shared <- core <- desktop); the renderer never does.
 *
 * Same rules as every other boundary schema here: `z.looseObject` keeps unknown fields, a wrong shape fails
 * `safeParse` (the `parse*` helpers return null, never throw), and free text is clipped to CLIP_LIMITS rather than
 * rejected.
 */
import { z } from 'zod';
import {
  CLIP_LIMITS,
  type HoldEnded,
  type HoldStarted,
  type HuddleCommand,
  type MessageDropped,
  type MessageQueued,
  type MessageDelivered,
  type ApprovalResolved,
  type QuestionClosed,
} from '@huddle/shared';
import { userSettingsPatchSchema } from '../runtime/huddle-settings.js';
import { agentKeyText, clipped, epochMs, event, idText } from './schema-parts.js';

export const holdStartedSchema = event('hold.started', {
  toolUseId: idText.nullable(),
  limitAt: epochMs,
});

export const holdEndedSchema = event('hold.ended', {
  toolUseId: idText.nullable(),
  why: z.enum(['resumed', 'hold_limit', 'closed_by_claude_code', 'shutdown']),
});

export const questionClosedSchema = event('question.closed', {
  requestId: idText,
  outcome: z.enum(['passed_through', 'expired', 'answered_elsewhere', 'shutdown']),
});

export const messageQueuedSchema = event('message.queued', {
  messageId: idText,
  text: clipped(CLIP_LIMITS.message),
  delivery: z.enum(['next_tool', 'turn_end', 'auto', 'live']),
  // M6 (ADR-030): a paired phone sent it.
  via: z.enum(['desktop', 'phone']).optional(),
});

export const messageDeliveredSchema = event('message.delivered', {
  messageId: idText,
  via: z.enum(['pre_tool_context', 'stop_continuation', 'stream_input']),
});

export const messageDroppedSchema = event('message.dropped', {
  messageId: idText,
  reason: z.enum(['cancelled', 'agent_ended']),
});

export const approvalResolvedSchema = event('approval.resolved', {
  requestId: idText,
  outcome: z.enum(['allowed', 'denied', 'passed_through', 'expired', 'answered_elsewhere']),
  by: z.enum(['user', 'policy', 'timeout', 'claude_code', 'shutdown']),
  policyRuleId: idText.nullable(),
  message: clipped(CLIP_LIMITS.message).nullable(),
  askedByRuleId: idText.nullable().optional(),
});

/** The interaction events M3 writes or relies on. Other event types are not covered here. */
export const interactionEventSchema = z.discriminatedUnion('type', [
  holdStartedSchema,
  holdEndedSchema,
  questionClosedSchema,
  messageQueuedSchema,
  messageDeliveredSchema,
  messageDroppedSchema,
  approvalResolvedSchema,
]);

export type InteractionEvent =
  HoldStarted | HoldEnded | QuestionClosed | MessageQueued | MessageDelivered | MessageDropped | ApprovalResolved;

/** Parse an untrusted interaction event. Returns null instead of throwing. */
export function parseInteractionEvent(input: unknown): InteractionEvent | null {
  const result = interactionEventSchema.safeParse(input);
  const parsed: InteractionEvent | null = result.success ? result.data : null;
  return parsed;
}

// --- commands added in M3 -------------------------------------------------------------------------------------------

export const messageCancelCommandSchema = z.looseObject({
  type: z.literal('message.cancel'),
  agentKey: agentKeyText,
  messageId: idText,
});

export const settingsUpdateCommandSchema = z.looseObject({
  type: z.literal('settings.update'),
  patch: userSettingsPatchSchema,
});

/** The commands M3 adds; desktop's `validate.ts` joins them into its union (WP8). */
export const m3CommandSchemas = [messageCancelCommandSchema, settingsUpdateCommandSchema] as const;

type M3Command = Extract<HuddleCommand, { type: 'message.cancel' | 'settings.update' }>;

/** Parse an untrusted M3 command. Returns null instead of throwing. */
export function parseM3Command(input: unknown): M3Command | null {
  const result = z.discriminatedUnion('type', [...m3CommandSchemas]).safeParse(input);
  const parsed: M3Command | null = result.success ? result.data : null;
  return parsed;
}

// --- commands the broker answers (M3 WP5) ---------------------------------------------------------------------------
// The same limits as desktop's validate.ts; core checks again because HuddleCore may be hosted by something else.

const answerText = z.string().max(2000);
const brokerCmd = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) =>
  z.looseObject({ type: z.literal(type), ...shape });

export const brokerCommandSchemas = [
  brokerCmd('approval.decide', {
    requestId: idText,
    decision: z.enum(['allow', 'deny']),
    message: z.string().max(CLIP_LIMITS.message).optional(),
    remember: z.boolean().optional(),
  }),
  brokerCmd('approval.passThrough', { requestId: idText }),
  // M4 (F18): allow the held requests the rules now allow; managed sessions only until S15 (broker/approvals.ts).
  brokerCmd('approval.allowAllMatchingPolicy', {}),
  brokerCmd('question.answer', {
    requestId: idText,
    answers: z.record(answerText, z.union([answerText, z.array(answerText).max(50)])),
    other: z.record(answerText, z.string().max(CLIP_LIMITS.message)).optional(),
    freeText: z.string().max(CLIP_LIMITS.message).optional(),
  }),
  brokerCmd('agent.message', {
    agentKey: agentKeyText,
    text: z.string().min(1).max(CLIP_LIMITS.message),
    delivery: z.enum(['auto', 'next_tool', 'turn_end']),
  }),
  messageCancelCommandSchema,
  brokerCmd('agent.pause', { agentKey: agentKeyText }),
  brokerCmd('agent.resume', { agentKey: agentKeyText }),
  brokerCmd('all.pause', {}),
  brokerCmd('all.resume', {}),
] as const;

type BrokerCommandOf = Extract<
  HuddleCommand,
  {
    type:
      | 'approval.decide'
      | 'approval.passThrough'
      | 'approval.allowAllMatchingPolicy'
      | 'question.answer'
      | 'agent.message'
      | 'message.cancel'
      | 'agent.pause'
      | 'agent.resume'
      | 'all.pause'
      | 'all.resume';
  }
>;

/** Parse an untrusted broker command. Returns null instead of throwing. */
export function parseBrokerCommand(input: unknown): BrokerCommandOf | null {
  const result = z.discriminatedUnion('type', [...brokerCommandSchemas]).safeParse(input);
  const parsed: BrokerCommandOf | null = result.success ? result.data : null;
  return parsed;
}
