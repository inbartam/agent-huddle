/**
 * zod schemas for everything the renderer sends over IPC. The renderer is not trusted: main parses
 * every invoke payload here before it reaches the core. Unknown extra fields are kept
 * (`z.looseObject`) per the code conventions; a wrong shape is rejected, never thrown. Main may import core (shared
 * <- core <- desktop main); the renderer never does, so the M3, M4 and M5 command schemas come from `@huddle/core`.
 *
 * M5 (F22-F25): the history, replay, report, scorecard and Ask questions ride the existing `huddle:query` channel
 * (`parseQuery`), and their commands the existing `huddle:command` one. Page sizes are clamped, not refused; a session
 * id must pass the stores' `isValidSessionId` (reused from core, not mirrored).
 */
import { z } from 'zod';
import {
  huddleAskCommandSchema,
  huddleQuerySchema as m4QuerySchema,
  m3CommandSchemas,
  m4CommandSchemas,
  m5CommandSchemas,
  m5QuerySchemas,
  m6CommandSchemas,
  m6QuerySchemas,
  orchCommandSchemas,
  orchQuerySchemas,
} from '@huddle/core';
import { ASK_HISTORY_ANSWER_MAX, CLIP_LIMITS, type HuddleCommand, type HuddleQuery } from '@huddle/shared';
import { ITEM_ID_MAX } from './toasts.js';

const id = z.string().min(1).max(200);
const agentKey = z.string().min(1).max(400);
const cmd = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) =>
  z.looseObject({ type: z.literal(type), ...shape });

export const huddleCommandSchema = z.discriminatedUnion('type', [
  cmd('approval.decide', {
    requestId: id,
    decision: z.enum(['allow', 'deny']),
    message: z.string().max(CLIP_LIMITS.message).optional(),
    remember: z.boolean().optional(),
  }),
  cmd('approval.passThrough', { requestId: id }),
  cmd('question.answer', {
    requestId: id,
    answers: z.record(z.string().max(2000), z.union([z.string().max(2000), z.array(z.string().max(2000)).max(50)])),
    other: z.record(z.string().max(2000), z.string().max(CLIP_LIMITS.message)).optional(),
    freeText: z.string().max(CLIP_LIMITS.message).optional(),
  }),
  // Detector item ids carry a cwd and a file path (`conflict:<cwd>:<path>`), so they can be longer than other ids.
  cmd('attention.dismiss', { itemId: z.string().min(1).max(ITEM_ID_MAX) }),
  cmd('agent.message', {
    agentKey,
    text: z.string().min(1).max(CLIP_LIMITS.message),
    delivery: z.enum(['auto', 'next_tool', 'turn_end']),
  }),
  cmd('agent.pause', { agentKey }),
  cmd('agent.resume', { agentKey }),
  cmd('agent.stop', { agentKey }),
  cmd('agent.setModel', { agentKey, model: z.string().min(1).max(200) }),
  cmd('agent.rename', { agentKey, name: z.string().min(1).max(200) }),
  cmd('all.pause', {}),
  cmd('all.resume', {}),
  cmd('all.stop', {}),
  cmd('approval.allowAllMatchingPolicy', {}),
  // M5 (F25): trimmed, 1..ASK_QUESTION_MAX (500) characters.
  huddleAskCommandSchema,
  // Copy answer: handled in main only (ipc.ts); the text is clipped there to ASK_HISTORY_ANSWER_MAX.
  cmd('ask.copyAnswer', {
    text: z
      .string()
      .min(1)
      .max(ASK_HISTORY_ANSWER_MAX * 4),
  }),
  // ADR-017: the user pressed Connect on the first-run screen. No fields: main applies the change it showed.
  cmd('setup.attach', {}),
  // M3 (WP1): message.cancel and settings.update, defined once in core next to the other M3 contracts.
  ...m3CommandSchemas,
  // M4 (WP1, ADR-020): templates, runs, worktrees, rules and budgets, defined once in core with the M4 event schemas.
  ...m4CommandSchemas,
  // M5 (F22-F25): ask.cancel, ask.setEnabled, history.setRetention, history.deleteAll, report.make/openFile/copyPath.
  ...m5CommandSchemas,
  // M6 (F26): phone.enable, phone.disable, phone.pair, phone.revoke, defined once in core (m6-schemas.ts).
  ...m6CommandSchemas,
  // F28/F29: skill.save, huddle_task.create/update/delete/launch, defined once in core (orch-schemas.ts).
  ...orchCommandSchemas,
]);

/** Every `huddle:query` question: the M4 ones (policy.preview, pick.folder) and M5's history, report, scorecards, Ask. */
export const huddleQuerySchema = z.discriminatedUnion('type', [
  ...m4QuerySchema.options,
  ...m5QuerySchemas,
  // M6 (F26): phone.addresses (read-only).
  ...m6QuerySchemas,
  // F28: skills.list, skill.read (read-only).
  ...orchQuerySchemas,
]);

/** Parse an untrusted query. Returns null instead of throwing. */
export function parseQuery(input: unknown): HuddleQuery | null {
  const result = huddleQuerySchema.safeParse(input);
  const query: HuddleQuery | null = result.success ? result.data : null;
  return query;
}

/** Arguments of `huddle:get-events`. */
export const getEventsArgsSchema = z.looseObject({
  agentKey,
  limit: z.int().min(1).max(500),
});

export type GetEventsArgs = z.infer<typeof getEventsArgsSchema>;

/** Parse an untrusted command. Returns null instead of throwing. */
export function parseCommand(input: unknown): HuddleCommand | null {
  const result = huddleCommandSchema.safeParse(input);
  // The parsed value has exactly the HuddleCommand shape (plus any kept unknown fields).
  const command: HuddleCommand | null = result.success ? result.data : null;
  return command;
}

/** Parse untrusted getEvents arguments. Returns null instead of throwing. */
export function parseGetEventsArgs(input: unknown): GetEventsArgs | null {
  const result = getEventsArgsSchema.safeParse(input);
  return result.success ? result.data : null;
}
