/**
 * zod schemas for the M4 contracts (WP1, ADR-020): run, worktree and budget events; the configuration types they carry
 * (budget, policy rule, team template); the commands M4 adds and the read-only `huddle:query` questions.
 *
 * Same rules as m3-schemas.ts: in core because `@huddle/shared` has no runtime dependencies; desktop main may import
 * them, the renderer never does. `z.looseObject` keeps unknown fields, a wrong shape fails `safeParse` (the `parse*`
 * helpers return null, never throw), and free text is clipped to CLIP_LIMITS rather than rejected.
 */
import { z } from 'zod';
import {
  CLIP_LIMITS,
  MAX_WORKTREE_FILES,
  type BudgetSet,
  type HuddleCommand,
  type HuddleQuery,
  type RunExited,
  type RunLaunched,
  type RunResultEvent,
  type WorktreeClosed,
  type WorktreeCreated,
  type WorktreeSummarized,
} from '@huddle/shared';
import { agentKeyText, clipped, command, event, idText } from './schema-parts.js';

/** A runId: the AgentKey charset (file-name safe), at most 128 characters. A UUID fits. */
export const RUN_ID_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;
const runId = z.string().regex(RUN_ID_PATTERN);

const count = z.number().int().nonnegative();
const pathText = z.string().min(1).max(CLIP_LIMITS.path);
const shortText = z.string().max(200);
/** Free text a person typed into a template (prompts can be long; the first prompt goes over stdin). */
const PROMPT_MAX = 20_000;
/** Keys that would reach an object's prototype; refused as record keys. */
const UNSAFE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * A permission mode. Any non-empty string up to CLIP_LIMITS.id is accepted, so a mode a newer Claude Code adds never
 * makes a stored template or event fail to load; the launcher checks against PERMISSION_MODES before using it.
 */
export const permissionModeSchema = z.string().min(1).max(CLIP_LIMITS.id);

// --- configuration types ----------------------------------------------------------------------------------------

export const budgetSchema = z.looseObject({
  scope: z.enum(['agent', 'session', 'overall', 'all']),
  maxTokens: z.number().nonnegative().optional(),
  maxEstimatedCostUsd: z.number().nonnegative().optional(),
  maxMinutes: z.number().nonnegative().optional(),
  warnAtFraction: z.number().min(0).max(1),
  onExceed: z.enum(['notify', 'pause', 'stop']),
});

export const policyRuleSchema = z.looseObject({
  id: idText,
  name: shortText,
  enabled: z.boolean(),
  action: z.enum(['allow', 'deny', 'ask']),
  match: z.looseObject({
    tool: idText.optional(),
    commandPrefix: z.string().min(1).max(1000).optional(),
    commandExact: z.boolean().optional(),
    pathGlob: z.string().min(1).max(1000).optional(),
    role: idText.optional(),
    folder: pathText.optional(),
  }),
  note: z.string().max(1000).optional(),
});

export const templateAgentSchema = z.looseObject({
  description: z.string().max(CLIP_LIMITS.description),
  prompt: z.string().max(PROMPT_MAX),
  tools: z.array(idText).max(200).optional(),
  model: idText.optional(),
});

/** An agent name for `--agents`: must not start with "-" (INTEGRATION.md section 3), no prototype keys. */
const agentName = z
  .string()
  .min(1)
  .max(128)
  .refine((name) => !name.startsWith('-') && !UNSAFE_KEYS.has(name), { message: 'not a usable agent name' });

export const teamTemplateSchema = z.looseObject({
  id: idText,
  name: shortText,
  description: z.string().max(2000).optional(),
  prompt: z.string().max(PROMPT_MAX),
  cwd: pathText,
  mainAgent: idText.nullable(),
  model: idText.nullable(),
  permissionMode: permissionModeSchema,
  agents: z.record(agentName, templateAgentSchema).optional(),
  budgets: z.array(budgetSchema).max(20).optional(),
  ruleIds: z.array(idText).max(200).optional(),
  worktree: z.boolean(),
  /** M6 (F27): false turns self-reported progress off for this template's runs. */
  selfReport: z.boolean().optional(),
});

// --- events -------------------------------------------------------------------------------------------------------

const clippedId = clipped(CLIP_LIMITS.id);
const clippedPath = clipped(CLIP_LIMITS.path);

export const runLaunchedSchema = event('run.launched', {
  runId,
  claudeSessionId: idText.nullable(),
  templateId: idText.nullable(),
  cwd: clippedPath,
  model: clippedId.nullable(),
  permissionMode: clippedId,
  mainAgent: clippedId.nullable(),
  agentNames: z.array(clippedId).max(200),
  worktree: z.looseObject({ path: clippedPath, branch: clippedPath }).nullable(),
});

export const runExitedSchema = event('run.exited', {
  runId,
  exitCode: z.number().int().nullable(),
  how: z.enum(['completed', 'stopped', 'failed', 'spawn_failed']),
  error: clipped(CLIP_LIMITS.error).nullable(),
});

export const runResultSchema = event('run.result', {
  runId,
  isError: z.boolean(),
  durationMs: z.number().nonnegative().nullable(),
  numTurns: count.nullable(),
  totalCostUsd: z.number().nonnegative().nullable(),
  permissionDenials: count,
});

export const worktreeCreatedSchema = event('worktree.created', {
  runId,
  path: clippedPath,
  branch: clippedPath,
  baseCommit: idText,
  repoRoot: clippedPath,
});

const worktreeFileStatus = z
  .enum(['added', 'modified', 'deleted', 'renamed', 'copied', 'type_changed', 'unmerged', 'untracked', 'unknown'])
  .catch('unknown');

export const worktreeSummarizedSchema = event('worktree.summarized', {
  runId,
  filesChanged: count,
  insertions: count,
  deletions: count,
  untracked: count,
  // Clipped, not rejected: a longer list keeps its first MAX_WORKTREE_FILES entries (filesChanged keeps the count).
  files: z
    .array(z.looseObject({ path: clippedPath, status: worktreeFileStatus }))
    .max(10_000)
    .transform((files) => files.slice(0, MAX_WORKTREE_FILES)),
});

export const worktreeClosedSchema = event('worktree.closed', {
  runId,
  outcome: z.enum(['kept', 'discarded']),
  error: clipped(CLIP_LIMITS.error).nullable(),
});

export const budgetSetSchema = event('budget.set', {
  scope: z.enum(['agent', 'session', 'overall']),
  targetKey: agentKeyText.nullable(),
  budget: budgetSchema,
});

/** The events M4 adds. Other event types are not covered here. */
export const runEventSchema = z.discriminatedUnion('type', [
  runLaunchedSchema,
  runExitedSchema,
  runResultSchema,
  worktreeCreatedSchema,
  worktreeSummarizedSchema,
  worktreeClosedSchema,
  budgetSetSchema,
]);

export type RunEvent =
  RunLaunched | RunExited | RunResultEvent | WorktreeCreated | WorktreeSummarized | WorktreeClosed | BudgetSet;

/** Parse an untrusted M4 event. Returns null instead of throwing. */
export function parseRunEvent(input: unknown): RunEvent | null {
  const result = runEventSchema.safeParse(input);
  const parsed: RunEvent | null = result.success ? result.data : null;
  return parsed;
}

// --- commands added in M4 -------------------------------------------------------------------------------------------

const runCmd = <T extends string>(type: T) => command(type, { runId });

export const runLaunchCommandSchema = command('run.launch', {
  templateId: idText.optional(),
  template: teamTemplateSchema.optional(),
  promptOverride: z.string().max(PROMPT_MAX).optional(),
}).refine((cmd) => (cmd.templateId === undefined) !== (cmd.template === undefined), {
  message: 'give exactly one of templateId and template',
});

/** The commands M4 adds; desktop's `validate.ts` joins them into its union. */
export const m4CommandSchemas = [
  command('template.upsert', { template: teamTemplateSchema }),
  command('template.remove', { templateId: idText }),
  runLaunchCommandSchema,
  runCmd('run.stop'),
  runCmd('run.end'),
  runCmd('run.keepWorktree'),
  runCmd('run.discardWorktree'),
  runCmd('run.openWorktree'),
  command('policy.upsertRule', { rule: policyRuleSchema }),
  command('policy.removeRule', { ruleId: idText }),
  command('budget.set', { agentKey: agentKeyText.nullable(), budget: budgetSchema }),
] as const;

/** Every command type M4 adds; HuddleCore handles each (WP2 rules, WP5 budgets, WP6 templates and runs). */
export const M4_COMMAND_TYPES = [
  'template.upsert',
  'template.remove',
  'run.launch',
  'run.stop',
  'run.end',
  'run.keepWorktree',
  'run.discardWorktree',
  'run.openWorktree',
  'policy.upsertRule',
  'policy.removeRule',
  'budget.set',
] as const satisfies readonly HuddleCommand['type'][];

export type M4CommandType = (typeof M4_COMMAND_TYPES)[number];
type M4Command = Extract<HuddleCommand, { type: M4CommandType }>;

/** Parse an untrusted M4 command. Returns null instead of throwing. */
export function parseM4Command(input: unknown): M4Command | null {
  const result = z.discriminatedUnion('type', [...m4CommandSchemas]).safeParse(input);
  const parsed: M4Command | null = result.success ? result.data : null;
  return parsed;
}

const M4_COMMAND_TYPE_SET: ReadonlySet<string> = new Set(M4_COMMAND_TYPES);

export function isM4Command(cmd: HuddleCommand): cmd is M4Command {
  return M4_COMMAND_TYPE_SET.has(cmd.type);
}

// --- read-only queries (huddle:query) -------------------------------------------------------------------------------

export const huddleQuerySchema = z.discriminatedUnion('type', [
  command('policy.preview', { rule: policyRuleSchema }),
  command('pick.folder', { defaultPath: pathText.optional() }),
]);

/** The questions M4 added (M5's are in m5-schemas.ts: `parseM5Query`). */
export type M4Query = Extract<HuddleQuery, { type: 'policy.preview' | 'pick.folder' }>;

/**
 * Parse an untrusted M4 query. Returns null instead of throwing, including for M5 questions: desktop main's
 * `parseQuery` (validate.ts) accepts both.
 */
export function parseHuddleQuery(input: unknown): M4Query | null {
  const result = huddleQuerySchema.safeParse(input);
  const parsed: M4Query | null = result.success ? result.data : null;
  return parsed;
}
