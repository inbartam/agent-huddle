/**
 * The launch dialog and the template editor (M4: F16 launch, F17 templates, F19 budgets) as form drafts, checks and
 * commands. Pure: ids are passed in. The checks mirror core's `teamTemplateSchema` (contracts/m4-schemas.ts) so a
 * mistake is shown under its field before main refuses the command; main still validates every command.
 *
 * Permission modes (INTEGRATION.md section 3, spike S16): PermissionRequest fires only in `default` and
 * `acceptEdits`, so in `plan`, `auto` and `dontAsk` Huddle approvals and rules do not apply, and the picker says so.
 * `bypassPermissions` is left out of the picker on purpose (owner's call, 2026-11-14).
 */
import {
  CLIP_LIMITS,
  type Budget,
  type HuddleCommand,
  type PermissionMode,
  type TeamTemplate,
  type TemplateAgent,
} from '@huddle/shared';

/** Longest first prompt or agent prompt (core's PROMPT_MAX). */
export const PROMPT_MAX = 20_000;
export const NAME_MAX = 200;
/** How many agents a template may define in this editor. */
export const MAX_TEMPLATE_AGENTS = 10;
/** Budgets made here warn at 80% of the cap. */
export const BUDGET_WARN_AT = 0.8;

export interface PermissionModeOption {
  mode: PermissionMode;
  label: string;
  /** What the mode does, from Claude Code's permission-modes page. */
  hint: string;
  /** A few words for the template list, so it does not show the raw mode name ("acceptEdits"). */
  short: string;
  /** Claude Code never sends a PermissionRequest in this mode (S16). */
  bypassesHuddle: boolean;
}

export const PERMISSION_MODE_OPTIONS: readonly PermissionModeOption[] = [
  {
    mode: 'default',
    label: 'default',
    hint: 'Reads run unasked; edits and commands ask.',
    short: 'asks before edits',
    bypassesHuddle: false,
  },
  {
    mode: 'acceptEdits',
    label: 'acceptEdits',
    hint: 'Reads, file edits and simple file commands run unasked; other commands ask.',
    short: 'edits without asking',
    bypassesHuddle: false,
  },
  {
    mode: 'plan',
    label: 'plan',
    hint: 'Explores and writes a plan; no source edits.',
    short: 'plans only',
    bypassesHuddle: true,
  },
  {
    mode: 'auto',
    label: 'auto',
    hint: 'A classifier model reviews each action.',
    short: 'a model reviews each action',
    bypassesHuddle: true,
  },
  {
    mode: 'dontAsk',
    label: 'dontAsk',
    hint: 'Refuses every action that would ask.',
    short: 'never asks, refuses instead',
    bypassesHuddle: true,
  },
];

export const LAUNCH_WORDS = {
  hooksNote: "This loads the folder's .claude/ hooks and CLAUDE.md.",
  worktreeNote: 'Runs in a separate git worktree; files git ignores, such as node_modules and .env, are not copied.',
  modeBypasses: 'In this mode Claude Code does not ask, so Huddle approvals and rules do not apply.',
  budgetNote: 'An estimate; a run can overshoot by about one tool call. Warns at 80%.',
  selfReportLabel: 'Agents report their progress',
  selfReportNote:
    'Gives the agents a small tool to say how far along they are; the progress bar shows it as an estimate.',
  selfReportGlobalOff: 'Off for every run while Settings, Self-reported progress is off.',
} as const;

export function modeOption(mode: PermissionMode): PermissionModeOption | undefined {
  return PERMISSION_MODE_OPTIONS.find((o) => o.mode === mode);
}

export interface AgentDraft {
  name: string;
  description: string;
  prompt: string;
  /** Tool names separated by commas; empty: every tool. */
  tools: string;
  /** Empty: inherit. */
  model: string;
}

export interface LaunchDraft {
  name: string;
  description: string;
  cwd: string;
  prompt: string;
  mainAgent: string;
  model: string;
  permissionMode: PermissionMode;
  worktree: boolean;
  /** F27: agents report their own progress (default on). Off writes `selfReport: false` into the template. */
  selfReport: boolean;
  maxTokens: string;
  maxCostUsd: string;
  maxMinutes: string;
  onExceed: Budget['onExceed'];
  agents: AgentDraft[];
}

export const EMPTY_AGENT: AgentDraft = { name: '', description: '', prompt: '', tools: '', model: '' };

export const EMPTY_DRAFT: LaunchDraft = {
  name: '',
  description: '',
  cwd: '',
  prompt: '',
  mainAgent: '',
  model: '',
  permissionMode: 'default',
  worktree: true,
  selfReport: true,
  maxTokens: '',
  maxCostUsd: '',
  maxMinutes: '',
  onExceed: 'pause',
  agents: [],
};

/** Field keys an error can sit under: top-level fields, or `agents.<i>.<field>`. */
export type DraftErrors = Record<string, string>;

const UNSAFE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

export function numberField(raw: string, whole: boolean): { value: number | undefined } | { error: string } {
  const text = raw.trim();
  if (text === '') return { value: undefined };
  const ok = whole ? /^\d+$/.test(text) : /^\d+(\.\d+)?$/.test(text);
  const value = Number(text);
  if (!ok || !Number.isFinite(value) || value <= 0) {
    return {
      error: whole ? 'Enter a whole number above 0, or leave it empty.' : 'Enter a number above 0, or leave it empty.',
    };
  }
  return { value };
}

function idField(raw: string, what: string): string | null {
  const text = raw.trim();
  if (text.length > CLIP_LIMITS.id) return `${what} is too long.`;
  if (/\s/.test(text)) return `${what} has no spaces.`;
  return null;
}

/** The tool list as Claude Code takes it; empty means every tool. */
export function parseTools(raw: string): string[] {
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t !== '');
}

/**
 * Check a draft. `requireName`: a template needs a name; the launch dialog makes one from the folder when empty.
 * Returns the problems by field; an empty object means the draft can be sent.
 */
export function validateDraft(draft: LaunchDraft, requireName: boolean): DraftErrors {
  const e: DraftErrors = {};
  if (requireName && draft.name.trim() === '') e['name'] = 'Give the template a name.';
  if (draft.name.trim().length > NAME_MAX) e['name'] = `Keep the name under ${String(NAME_MAX)} characters.`;
  if (draft.cwd.trim() === '') e['cwd'] = 'Choose the folder the run works in.';
  else if (draft.cwd.length > CLIP_LIMITS.path) e['cwd'] = 'That path is too long.';
  if (draft.prompt.trim() === '') e['prompt'] = 'Write the first prompt.';
  else if (draft.prompt.length > PROMPT_MAX) e['prompt'] = `Keep the prompt under ${String(PROMPT_MAX)} characters.`;
  const mainAgent = idField(draft.mainAgent, 'An agent name');
  if (mainAgent) e['mainAgent'] = mainAgent;
  const model = idField(draft.model, 'A model id');
  if (model) e['model'] = model;
  if (modeOption(draft.permissionMode) === undefined) e['permissionMode'] = 'Pick a permission mode.';
  const tokens = numberField(draft.maxTokens, true);
  if ('error' in tokens) e['maxTokens'] = tokens.error;
  const cost = numberField(draft.maxCostUsd, false);
  if ('error' in cost) e['maxCostUsd'] = cost.error;
  const minutes = numberField(draft.maxMinutes, true);
  if ('error' in minutes) e['maxMinutes'] = minutes.error;

  if (draft.agents.length > MAX_TEMPLATE_AGENTS) {
    e['agents'] = `A template can define up to ${String(MAX_TEMPLATE_AGENTS)} agents.`;
  }
  const seen = new Set<string>();
  draft.agents.forEach((a, i) => {
    const at = (field: string) => `agents.${String(i)}.${field}`;
    const name = a.name.trim();
    if (name === '') e[at('name')] = 'Name this agent.';
    else if (name.startsWith('-')) e[at('name')] = 'An agent name cannot start with "-".';
    else if (UNSAFE_KEYS.has(name)) e[at('name')] = 'Pick another name.';
    else if (name.length > 128) e[at('name')] = 'Keep the name under 128 characters.';
    else if (/\s/.test(name)) e[at('name')] = 'An agent name has no spaces.';
    else if (seen.has(name)) e[at('name')] = 'Two agents have this name.';
    seen.add(name);
    if (a.description.trim() === '') e[at('description')] = 'Say when to use this agent.';
    else if (a.description.length > CLIP_LIMITS.description) e[at('description')] = 'Keep it shorter.';
    if (a.prompt.trim() === '') e[at('prompt')] = "Write this agent's instructions.";
    else if (a.prompt.length > PROMPT_MAX) e[at('prompt')] = `Keep it under ${String(PROMPT_MAX)} characters.`;
    const badTool = parseTools(a.tools).find((t) => t.length > CLIP_LIMITS.id || /\s/.test(t));
    if (badTool !== undefined) e[at('tools')] = 'Separate tool names with commas.';
    const m = idField(a.model, 'A model id');
    if (m) e[at('model')] = m;
  });
  return e;
}

function budgetFrom(draft: LaunchDraft): Budget | null {
  const n = (raw: string) => {
    const t = raw.trim();
    return t === '' ? undefined : Number(t);
  };
  const maxTokens = n(draft.maxTokens);
  const maxEstimatedCostUsd = n(draft.maxCostUsd);
  const maxMinutes = n(draft.maxMinutes);
  if (maxTokens === undefined && maxEstimatedCostUsd === undefined && maxMinutes === undefined) return null;
  const budget: Budget = { scope: 'session', warnAtFraction: BUDGET_WARN_AT, onExceed: draft.onExceed };
  if (maxTokens !== undefined) budget.maxTokens = maxTokens;
  if (maxEstimatedCostUsd !== undefined) budget.maxEstimatedCostUsd = maxEstimatedCostUsd;
  if (maxMinutes !== undefined) budget.maxMinutes = maxMinutes;
  return budget;
}

/** The last folder of a path, for a default name. */
function lastFolder(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** A checked draft as a template. Call only when `validateDraft` found nothing. */
export function templateFromDraft(draft: LaunchDraft, id: string, keepRuleIds?: string[]): TeamTemplate {
  const name = draft.name.trim() || `Run in ${lastFolder(draft.cwd.trim())}`;
  const t: TeamTemplate = {
    id,
    name,
    prompt: draft.prompt,
    cwd: draft.cwd.trim(),
    mainAgent: draft.mainAgent.trim() || null,
    model: draft.model.trim() || null,
    permissionMode: draft.permissionMode,
    worktree: draft.worktree,
  };
  // Absent means on (ADR-025): only an explicit off is written.
  if (!draft.selfReport) t.selfReport = false;
  if (draft.description.trim() !== '') t.description = draft.description.trim();
  if (draft.agents.length > 0) {
    const agents: Record<string, TemplateAgent> = {};
    for (const a of draft.agents) {
      const agent: TemplateAgent = { description: a.description.trim(), prompt: a.prompt };
      const tools = parseTools(a.tools);
      if (tools.length > 0) agent.tools = tools;
      if (a.model.trim() !== '') agent.model = a.model.trim();
      agents[a.name.trim()] = agent;
    }
    t.agents = agents;
  }
  const budget = budgetFrom(draft);
  if (budget) t.budgets = [budget];
  if (keepRuleIds && keepRuleIds.length > 0) t.ruleIds = keepRuleIds;
  return t;
}

function numText(n: number | undefined): string {
  return n === undefined ? '' : String(n);
}

/** A stored template as a draft for the editor (or to start the launch dialog from). */
export function draftFromTemplate(t: TeamTemplate): LaunchDraft {
  const budget = t.budgets?.find((b) => b.scope === 'session') ?? t.budgets?.[0];
  return {
    name: t.name,
    description: t.description ?? '',
    cwd: t.cwd,
    prompt: t.prompt,
    mainAgent: t.mainAgent ?? '',
    model: t.model ?? '',
    permissionMode: modeOption(t.permissionMode) ? t.permissionMode : 'default',
    worktree: t.worktree,
    selfReport: t.selfReport !== false,
    maxTokens: numText(budget?.maxTokens),
    maxCostUsd: numText(budget?.maxEstimatedCostUsd),
    maxMinutes: numText(budget?.maxMinutes),
    onExceed: budget?.onExceed ?? 'pause',
    agents: Object.entries(t.agents ?? {}).map(([name, a]) => ({
      name,
      description: a.description,
      prompt: a.prompt,
      tools: (a.tools ?? []).join(', '),
      model: a.model ?? '',
    })),
  };
}

export function launchCommand(template: TeamTemplate): HuddleCommand {
  return { type: 'run.launch', template };
}

export function launchTemplateCommand(templateId: string, promptOverride?: string): HuddleCommand {
  return promptOverride === undefined
    ? { type: 'run.launch', templateId }
    : { type: 'run.launch', templateId, promptOverride };
}

/**
 * The core refuses to launch a template with rules of its own (`ruleIds`) in this build, and the editor offers no rule
 * picker. Shown on such a template and as the reason its Launch is off.
 */
export const TEMPLATE_RULES_REASON =
  'This template has rules of its own, which this build cannot apply yet, so it cannot be launched.';

export function hasOwnRules(t: TeamTemplate | null | undefined): boolean {
  return (t?.ruleIds?.length ?? 0) > 0;
}

/** Launch for a template: off with TEMPLATE_RULES_REASON when it has rules, else as `base` (the connection). */
export function templateLaunchControl(
  t: TeamTemplate | null | undefined,
  base: { enabled: boolean; reason: string | null },
): { enabled: boolean; reason: string | null } {
  return hasOwnRules(t) ? { enabled: false, reason: TEMPLATE_RULES_REASON } : base;
}

function sameExceptPrompt(a: LaunchDraft, b: LaunchDraft): boolean {
  return JSON.stringify({ ...a, prompt: '' }) === JSON.stringify({ ...b, prompt: '' });
}

/**
 * The launch dialog's command. Started from a stored template (`base`) and only the prompt changed (or nothing):
 * `{ templateId, promptOverride? }`, so the run keeps what the dialog does not show (every budget, the template's
 * rules). Anything else changed, or a template whose permission mode the dialog does not offer: an inline template.
 * Call only when `validateDraft` found nothing.
 */
export function launchCommandFor(draft: LaunchDraft, base: TeamTemplate | null, inlineId: string): HuddleCommand {
  if (base !== null && modeOption(base.permissionMode) !== undefined) {
    const stored = draftFromTemplate(base);
    if (sameExceptPrompt(draft, stored)) {
      return launchTemplateCommand(base.id, draft.prompt === base.prompt ? undefined : draft.prompt);
    }
  }
  return launchCommand(templateFromDraft(draft, inlineId));
}

/** A copy with a new id and "(copy)" after the name. */
export function duplicateTemplate(t: TeamTemplate, id: string): TeamTemplate {
  const name = `${t.name} (copy)`;
  return { ...t, id, name: name.length > NAME_MAX ? name.slice(0, NAME_MAX) : name };
}

/** A fresh id for a template (the renderer's own clock and randomness, kept out of the pure helpers above). */
export function newTemplateId(prefix = 'tpl'): string {
  const rand =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${String(Date.now())}-${String(Math.random()).slice(2, 10)}`;
  return `${prefix}-${rand}`;
}

/** One line for the template list: folder, mode, agents, worktree. */
export function templateSummary(t: TeamTemplate): string {
  const agents = Object.keys(t.agents ?? {}).length;
  const parts = [lastFolder(t.cwd), modeOption(t.permissionMode)?.short ?? t.permissionMode];
  if (agents > 0) parts.push(`${String(agents)} agent${agents === 1 ? '' : 's'}`);
  parts.push(t.worktree ? 'own worktree' : 'in place');
  if (t.selfReport === false) parts.push('no progress reports');
  // Commas, not middle dots: DESIGN.md keeps middle dots for the role line.
  return parts.join(', ');
}

// --- secrets in template prompts (M5, F17; core runtime/templates.ts) -----------------------------------------------
//
// The state shows every template prompt with its secrets masked as `<redacted>`. Sent back untouched, the core puts the
// stored secret back; edited around the mark, the core refuses the save or launch (`invalid`), because the secret
// itself would be replaced by the word. A save of a prompt that looks like it holds a secret succeeds with `warning`.

/** The mark the core's `maskSecrets` leaves where it hid a secret. */
export const MASK_MARK = '<redacted>';

export const SECRET_WORDS = {
  /** Under a prompt field that shows the mark: the masked part is marked, not silently editable. */
  masked: `Huddle hid a secret here: it shows as ${MASK_MARK}. Leave it untouched to keep the secret, or delete ${MASK_MARK} and type the secret again.`,
  /** The core refused a prompt edited around the mark. */
  refused: 'Huddle hides secrets in prompts. Delete the hidden part and type it again, or leave it untouched.',
  saved: 'Template saved.',
} as const;

export function showsMask(text: string): boolean {
  return text.includes(MASK_MARK);
}

/** Does any prompt of the draft (first prompt or an agent's instructions) still show the mark? */
export function draftShowsMask(draft: LaunchDraft): boolean {
  return showsMask(draft.prompt) || draft.agents.some((a) => showsMask(a.prompt));
}

/**
 * What a `template.upsert` (or `run.launch`) answer means for the form.
 *   done:    saved, nothing to say; the editor closes
 *   warning: saved, but the core has a note (a prompt that looks like it holds a secret); the editor stays open with it
 *   error:   refused; an `invalid` answer for a draft that shows the mark gets the plain words
 */
export type SaveOutcome = { kind: 'done' } | { kind: 'warning'; warning: string } | { kind: 'error'; error: string };

export function saveOutcome(
  result: { ok: true; warning?: string } | { ok: false; code: string; message: string },
  draft: LaunchDraft,
): SaveOutcome {
  if (result.ok) return result.warning ? { kind: 'warning', warning: result.warning } : { kind: 'done' };
  if (result.code === 'invalid' && draftShowsMask(draft)) return { kind: 'error', error: SECRET_WORDS.refused };
  return { kind: 'error', error: result.message };
}
