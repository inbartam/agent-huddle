/**
 * zod schemas for the orchestrator contracts (F28 skills, F29 tasks): the `huddle_task.*` events, the commands and the
 * read-only queries. Same rules as the M3-M6 schema files: `z.looseObject` keeps unknown fields, a wrong shape fails
 * `safeParse` (the `parse*` helpers return null, never throw); desktop main joins the command and query schemas into
 * its unions (`validate.ts`).
 *
 * Paths are checked for shape here only (a non-empty string up to CLIP_LIMITS.path). Whether a path is a known project,
 * local, and what it resolves to on disk is checked by the core when it acts (runtime/skills.ts, huddle-core.ts),
 * because that depends on the state and the file system at that moment.
 */
import { z } from 'zod';
import {
  CLIP_LIMITS,
  HUDDLE_TASK_DETAILS_MAX,
  HUDDLE_TASK_TITLE_MAX,
  SKILL_DESCRIPTION_MAX,
  SKILL_INSTRUCTIONS_MAX,
  SKILL_NAME_PATTERN,
  type HuddleCommand,
  type HuddleEvent,
  type HuddleQuery,
} from '@huddle/shared';
import { clipped, command, epochMs, event, idText } from './schema-parts.js';

const pathText = z.string().min(1).max(CLIP_LIMITS.path);
const skillName = z.string().regex(SKILL_NAME_PATTERN);
/** Task ids are made by the core (`task-<ts>-<n>`); anything id-shaped is accepted from the log. */
const taskId = idText;
const title = z.string().max(HUDDLE_TASK_TITLE_MAX);
const details = z.string().max(HUDDLE_TASK_DETAILS_MAX);

// --- events -------------------------------------------------------------------------------------------------------

export const huddleTaskCreatedSchema = event('huddle_task.created', {
  taskId,
  title: clipped(HUDDLE_TASK_TITLE_MAX),
  details: clipped(HUDDLE_TASK_DETAILS_MAX),
  projectPath: clipped(CLIP_LIMITS.path).nullable(),
  templateId: idText.nullable(),
});

export const huddleTaskUpdatedSchema = event('huddle_task.updated', {
  taskId,
  title: clipped(HUDDLE_TASK_TITLE_MAX).optional(),
  details: clipped(HUDDLE_TASK_DETAILS_MAX).optional(),
  projectPath: clipped(CLIP_LIMITS.path).nullable().optional(),
  templateId: idText.nullable().optional(),
  status: z.enum(['todo', 'running', 'done', 'failed']).optional(),
  runId: idText.nullable().optional(),
  launchedAt: epochMs.nullable().optional(),
});

export const huddleTaskDeletedSchema = event('huddle_task.deleted', { taskId });

export const huddleTaskEventSchema = z.discriminatedUnion('type', [
  huddleTaskCreatedSchema,
  huddleTaskUpdatedSchema,
  huddleTaskDeletedSchema,
]);

export type HuddleTaskEvent = Extract<
  HuddleEvent,
  { type: 'huddle_task.created' | 'huddle_task.updated' | 'huddle_task.deleted' }
>;

/** Parse an untrusted `huddle_task.*` event (a stored record, a fixture). Returns null instead of throwing. */
export function parseHuddleTaskEvent(input: unknown): HuddleTaskEvent | null {
  const result = huddleTaskEventSchema.safeParse(input);
  if (!result.success) return null;
  const parsed: HuddleTaskEvent = result.data;
  return parsed;
}

// --- commands -----------------------------------------------------------------------------------------------------

export const orchCommandSchemas = [
  command('skill.save', {
    projectPath: pathText,
    name: skillName,
    description: z.string().min(1).max(SKILL_DESCRIPTION_MAX),
    instructions: z.string().min(1).max(SKILL_INSTRUCTIONS_MAX),
    overwrite: z.boolean(),
  }),
  command('huddle_task.create', {
    title: title.min(1),
    details,
    projectPath: pathText.nullable(),
    templateId: idText.nullable(),
  }),
  command('huddle_task.update', {
    taskId,
    title: title.min(1).optional(),
    details: details.optional(),
    projectPath: pathText.nullable().optional(),
    templateId: idText.nullable().optional(),
    status: z.enum(['todo', 'done']).optional(),
  }),
  command('huddle_task.delete', { taskId }),
  command('huddle_task.launch', { taskId }),
] as const;

export const ORCH_COMMAND_TYPES = [
  'skill.save',
  'huddle_task.create',
  'huddle_task.update',
  'huddle_task.delete',
  'huddle_task.launch',
] as const satisfies readonly HuddleCommand['type'][];

export type OrchCommandType = (typeof ORCH_COMMAND_TYPES)[number];
export type OrchCommand = Extract<HuddleCommand, { type: OrchCommandType }>;

const orchCommandSchema = z.discriminatedUnion('type', [...orchCommandSchemas]);

/** Parse an untrusted orchestrator command. Returns null instead of throwing. */
export function parseOrchCommand(input: unknown): OrchCommand | null {
  const result = orchCommandSchema.safeParse(input);
  if (!result.success) return null;
  const parsed: OrchCommand = result.data;
  return parsed;
}

const ORCH_COMMAND_TYPE_SET: ReadonlySet<string> = new Set(ORCH_COMMAND_TYPES);

export function isOrchCommand(cmd: { type: string }): cmd is OrchCommand {
  return ORCH_COMMAND_TYPE_SET.has(cmd.type);
}

// --- queries ------------------------------------------------------------------------------------------------------

export const orchQuerySchemas = [
  command('skills.list', {}),
  command('skill.read', { projectPath: pathText, name: skillName }),
] as const;

export type OrchQuery = Extract<HuddleQuery, { type: 'skills.list' | 'skill.read' }>;

export function isOrchQuery(q: { type: string }): q is OrchQuery {
  return q.type === 'skills.list' || q.type === 'skill.read';
}

const orchQuerySchema = z.discriminatedUnion('type', [...orchQuerySchemas]);

/** Parse an untrusted orchestrator query. Returns null instead of throwing. */
export function parseOrchQuery(input: unknown): OrchQuery | null {
  const result = orchQuerySchema.safeParse(input);
  if (!result.success) return null;
  const parsed: OrchQuery = result.data;
  return parsed;
}
