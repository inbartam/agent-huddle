/**
 * Approval rules (M4, F18) as the renderer shows and edits them: words for actions and match fields, the editor's
 * draft and checks (mirroring core's `policyRuleSchema`), the commands, and the words for the preview and the
 * decision log. Pure.
 */
import {
  CLIP_LIMITS,
  isDefaultRule,
  type HuddleCommand,
  type PolicyDecision,
  type PolicyPreview,
  type PolicyRule,
} from '@huddle/shared';

export const RULE_WORDS = {
  onlyLaunched: 'Rules apply only to sessions the Huddle launched.',
  appliesToAll: 'Rules apply to every session, including ones you started in a terminal.',
  editorNote: 'Rules decide only requests Claude Code would ask you about.',
  precedence: 'When rules disagree, deny wins over ask, and ask over allow.',
  emptyMatch: 'With no match fields, this rule matches every request.',
  allowEverything: 'An allow rule with no match fields would allow every request Claude Code asks about.',
  commandExact: 'Exactly this command, with no arguments',
  previewApprox:
    'Approximate: checked against recent requests as Huddle stored them (clipped summaries), so the real rule can match a little differently.',
  previewNone: 'No recent request would have matched.',
  saveNeedsName: 'Give the rule a name to save it. The preview works without one.',
  noDecisions: 'No rule has decided anything yet.',
  defaultMark: 'default',
  defaultHint: 'Ships with Huddle. You can turn it off, not delete it.',
  huddleClosed: 'With the Huddle closed, no rule applies.',
  allowChangesTool:
    'This allows a tool that can change files or reach the network, wherever it points. Add a file path pattern, or choose ask me.',
  allowChangesFiles:
    'This allows a command that can change files. The Huddle refuses compound commands and protected paths, but checking shell commands is never complete.',
} as const;

/**
 * Command prefixes known to only read (owner list, M4): listing, printing the folder, printing a file, read-only git
 * (the same three as the defaults; `git show` is left out, since a repo's own diff drivers can run programs), and
 * `<tool> --version`. Compared without case and with runs of spaces as one, since Windows commands ignore case.
 */
const READ_ONLY_PREFIXES: readonly string[] = [
  'ls',
  'dir',
  'get-childitem',
  'pwd',
  'get-location',
  'cat',
  'type',
  'get-content',
  'git status',
  'git diff',
  'git log',
];
const VERSION_FORM = /^[a-z0-9][a-z0-9._-]* --version$/;
const SHELL_TOOLS = new Set(['bash', 'powershell']);

function normalisePrefix(prefix: string): string {
  return prefix.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Pure: is this command prefix one of the known read-only commands? */
export function isReadOnlyCommandPrefix(prefix: string): boolean {
  const p = normalisePrefix(prefix);
  return READ_ONLY_PREFIXES.includes(p) || VERSION_FORM.test(p);
}

/**
 * Pure: is this a `<tool> --version` prefix? Read-only only as the whole command: a tool may not stop at `--version`
 * and carry on with what follows, so an allow on it must match exactly, as the default version rules do.
 */
export function isVersionPrefix(prefix: string): boolean {
  return VERSION_FORM.test(normalisePrefix(prefix));
}

/**
 * Pure: should the editor warn that an allow rule lets through commands that can change files? Yes for an allow
 * whose command prefix is not a known read-only command, and for an allow on Bash or PowerShell with no prefix at all
 * (every command). An allow with no match fields has its own, stronger warning.
 */
export function allowsChangingCommands(draft: RuleDraft): boolean {
  if (draft.action !== 'allow') return false;
  const prefix = draft.match.commandPrefix.trim();
  if (prefix !== '' && isVersionPrefix(prefix)) return !draft.commandExact;
  if (prefix !== '') return !isReadOnlyCommandPrefix(prefix);
  return SHELL_TOOLS.has(draft.match.tool.trim().toLowerCase());
}

/** Tools that only read; an allow on one of them needs no path pattern to be safe. */
const READ_ONLY_TOOLS = new Set(['read', 'glob', 'grep', 'ls']);

/**
 * Pure: should the editor warn that an allow rule lets a tool change files or reach out, wherever it points? Yes for
 * an allow on a tool that is not a shell (those have their own check) and not a read-only tool, with no file path
 * pattern to narrow it: Write, Edit, NotebookEdit, WebFetch, WebSearch, any mcp__ tool.
 */
export function allowsChangingTool(draft: RuleDraft): boolean {
  if (draft.action !== 'allow') return false;
  const tool = draft.match.tool.trim().toLowerCase();
  if (tool === '' || SHELL_TOOLS.has(tool) || READ_ONLY_TOOLS.has(tool)) return false;
  return draft.match.pathGlob.trim() === '';
}
export const ACTION_WORDS: Record<PolicyRule['action'], { label: string; hint: string }> = {
  allow: { label: 'allow', hint: 'Answers Allow without asking you.' },
  ask: { label: 'ask me', hint: 'Waits for you, as without rules.' },
  deny: { label: 'deny', hint: 'Answers Deny with a message that names the rule.' },
};

/** The text match fields (`commandExact` is a switch next to the command prefix). */
export type MatchField = 'tool' | 'commandPrefix' | 'pathGlob' | 'role' | 'folder';

export const MATCH_FIELDS: readonly { key: MatchField; label: string; placeholder: string; code: boolean }[] = [
  { key: 'tool', label: 'Tool', placeholder: 'Bash', code: true },
  { key: 'commandPrefix', label: 'Command starts with', placeholder: 'git status', code: true },
  { key: 'pathGlob', label: 'File path matches', placeholder: 'src/**/*.ts', code: true },
  { key: 'role', label: 'Agent role', placeholder: 'Explore', code: true },
  { key: 'folder', label: 'Session folder is or is inside', placeholder: 'C:\\projects\\example', code: true },
];

/**
 * The match as label and value pairs, so the list can show the words in the UI face and only the values (a tool, a
 * command, a path) in the code face: [{ label: 'tool', value: 'Bash' }, { label: 'command starts with', value: 'ls' }].
 */
export function matchParts(rule: PolicyRule): { label: string; value: string }[] {
  const parts: { label: string; value: string }[] = [];
  for (const f of MATCH_FIELDS) {
    const v = rule.match[f.key];
    if (v === undefined || v === '') continue;
    parts.push({
      label:
        f.key === 'commandPrefix' && rule.match.commandExact === true ? 'command is exactly' : f.label.toLowerCase(),
      value: v,
    });
  }
  return parts;
}

/** "Bash, command starts with git status" for the list. Empty match: "every request". */
export function matchWords(rule: PolicyRule): string {
  const parts: string[] = [];
  for (const f of MATCH_FIELDS) {
    const v = rule.match[f.key];
    if (v === undefined || v === '') continue;
    parts.push(
      f.key === 'commandPrefix' && rule.match.commandExact === true
        ? `command is exactly ${v}`
        : `${f.label.toLowerCase()} ${v}`,
    );
  }
  return parts.length === 0 ? 'every request' : parts.join(', ');
}

/** Defaults first (as shipped), then the user's rules by name. */
export function sortedRules(rules: readonly PolicyRule[]): PolicyRule[] {
  return [...rules].sort(
    (a, b) => Number(isDefaultRule(b)) - Number(isDefaultRule(a)) || a.name.localeCompare(b.name, 'en'),
  );
}

export interface RuleDraft {
  id: string;
  name: string;
  enabled: boolean;
  action: PolicyRule['action'];
  match: Record<MatchField, string>;
  /** With a command prefix: the command must be exactly it, with no arguments. */
  commandExact: boolean;
  note: string;
}

export function draftFromRule(rule: PolicyRule): RuleDraft {
  return {
    id: rule.id,
    name: rule.name,
    enabled: rule.enabled,
    action: rule.action,
    match: {
      tool: rule.match.tool ?? '',
      commandPrefix: rule.match.commandPrefix ?? '',
      pathGlob: rule.match.pathGlob ?? '',
      role: rule.match.role ?? '',
      folder: rule.match.folder ?? '',
    },
    commandExact: rule.match.commandExact === true,
    note: rule.note ?? '',
  };
}

export function emptyRuleDraft(id: string): RuleDraft {
  return {
    id,
    name: '',
    enabled: true,
    action: 'ask',
    match: { tool: '', commandPrefix: '', pathGlob: '', role: '', folder: '' },
    commandExact: false,
    note: '',
  };
}

const LIMITS: Record<MatchField, number> = {
  tool: CLIP_LIMITS.id,
  commandPrefix: 1000,
  pathGlob: 1000,
  role: CLIP_LIMITS.id,
  folder: CLIP_LIMITS.path,
};

/**
 * The words core uses when it refuses an allow rule. A copy of `POLICY_RULE_PROBLEMS` in
 * packages/core/src/runtime/policy-store.ts: the renderer may not import core (ADR-016) and `shared` has no such
 * check, so the minimal check is duplicated here. Keep the two in step; core's check is the one that counts.
 */
export const ALLOW_RULE_PROBLEMS = {
  namesNothing: 'An allow rule must name a tool, a command or a path.',
  shellNeedsCommand: 'An allow rule for Bash or PowerShell must name a command; without one it allows every command.',
  singleWord:
    'An allow rule on one command word allows every use of that program. Add the subcommand (for example "git status", not "git"). Only ls, dir, pwd, Get-ChildItem and Get-Location may stand alone.',
  nonAscii: "An allow rule's command may use plain ASCII characters only.",
  // AX-05, copies of core's save-time refusals (`policyRuleSaveProblem`).
  launcher:
    'An allow rule may not start a shell or an interpreter (bash, cmd, powershell, node, python, npx…): it would allow any command passed to it.',
  install: 'An allow rule may not install packages (npm install, pip install…).',
  push: 'An allow rule may not push (git push).',
  discard: 'An allow rule may not throw work away (git clean, git reset).',
  deletes: 'An allow rule may not delete files (rm, del, Remove-Item…).',
} as const;

/** Copy of core's `SINGLE_WORD_ALLOWS`: the single-word command prefixes an allow may use (lower case). */
const SINGLE_WORD_ALLOWS: readonly string[] = ['ls', 'dir', 'pwd', 'get-childitem', 'get-location'];

type SaveRefusal = 'launcher' | 'install' | 'push' | 'discard' | 'deletes';

/** Copy of core's `SAVE_REFUSED_FIRST_WORDS` (AX-05). */
const REFUSED_FIRST_WORDS: ReadonlyMap<string, SaveRefusal> = new Map([
  ...[
    'bash',
    'sh',
    'zsh',
    'cmd',
    'powershell',
    'pwsh',
    'node',
    'python',
    'python3',
    'py',
    'npx',
    'deno',
    'bun',
    'bunx',
    'wsl',
    'env',
    'start',
    'invoke-expression',
    'iex',
  ].map((w) => [w, 'launcher'] as const),
  ...['rm', 'rmdir', 'rd', 'del', 'erase', 'remove-item', 'ri', 'unlink', 'shred', 'rimraf'].map(
    (w) => [w, 'deletes'] as const,
  ),
  ...['install-module', 'install-package', 'install-script'].map((w) => [w, 'install'] as const),
]);

/** Copy of core's `SAVE_REFUSED_TWO_WORDS` (AX-05). */
const REFUSED_TWO_WORDS: ReadonlyMap<string, SaveRefusal> = new Map([
  ['git -c', 'launcher'],
  ['git push', 'push'],
  ['git clean', 'discard'],
  ['git reset', 'discard'],
  ['git rm', 'deletes'],
  ...[
    'npm install',
    'npm i',
    'npm add',
    'npm ci',
    'npm update',
    'npm exec',
    'pnpm install',
    'pnpm i',
    'pnpm add',
    'pnpm dlx',
    'yarn add',
    'yarn install',
    'yarn dlx',
    'pip install',
    'pip3 install',
    'cargo install',
    'go install',
    'go get',
    'gem install',
    'winget install',
    'choco install',
    'scoop install',
    'dotnet add',
  ].map((w) => [w, 'install'] as const),
]);

/** Copy of core's `policyRuleSaveProblem` word check: the refusal for a command prefix, or null. */
function saveRefusal(prefix: string): SaveRefusal | null {
  const words = prefix
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w !== '');
  const first = (words[0] ?? '')
    .replace(/["']/g, '')
    .replace(/^.*[\\/]/, '')
    .replace(/\.exe$/, '');
  return REFUSED_FIRST_WORDS.get(first) ?? REFUSED_TWO_WORDS.get(`${first} ${words[1] ?? ''}`) ?? null;
}

/**
 * Pure: why core will refuse this draft as an allow rule, and which field to mark; null when it accepts it (or the
 * draft is not an allow). Mirrors core's `policyRuleProblem` for allows.
 */
export function allowRuleProblem(draft: RuleDraft): { field: MatchField; message: string } | null {
  if (draft.action !== 'allow') return null;
  const tool = draft.match.tool.trim();
  const prefix = draft.match.commandPrefix.trim();
  if (tool === '' && prefix === '' && draft.match.pathGlob.trim() === '') {
    return { field: 'tool', message: ALLOW_RULE_PROBLEMS.namesNothing };
  }
  if ((tool === 'Bash' || tool === 'PowerShell') && prefix === '') {
    return { field: 'commandPrefix', message: ALLOW_RULE_PROBLEMS.shellNeedsCommand };
  }
  if (prefix !== '') {
    if (!/^[\x20-\x7e]*$/.test(prefix)) return { field: 'commandPrefix', message: ALLOW_RULE_PROBLEMS.nonAscii };
    const words = prefix.split(/\s+/);
    if (words.length === 1 && !SINGLE_WORD_ALLOWS.includes(prefix.toLowerCase())) {
      return { field: 'commandPrefix', message: ALLOW_RULE_PROBLEMS.singleWord };
    }
    // As core (R-04): a rule saved switched off is never refused this way, so a risky rule can always be turned off.
    const refusal = draft.enabled ? saveRefusal(prefix) : null;
    if (refusal !== null) return { field: 'commandPrefix', message: ALLOW_RULE_PROBLEMS[refusal] };
  }
  return null;
}

export function validateRule(draft: RuleDraft): Record<string, string> {
  const e: Record<string, string> = {};
  const refused = allowRuleProblem(draft);
  if (refused !== null) e[refused.field] = refused.message;
  if (draft.name.trim() === '') e['name'] = 'Give the rule a name.';
  else if (draft.name.length > 200) e['name'] = 'Keep the name under 200 characters.';
  for (const f of MATCH_FIELDS) {
    const v = draft.match[f.key].trim();
    if (v.length > LIMITS[f.key]) e[f.key] = 'That is too long.';
    else if ((f.key === 'tool' || f.key === 'role') && /\s/.test(v)) e[f.key] = 'No spaces in a tool or role name.';
  }
  if (draft.note.length > 1000) e['note'] = 'Keep the note under 1000 characters.';
  return e;
}

/** A checked draft as a rule. Empty match fields are left out. */
export function ruleFromDraft(draft: RuleDraft): PolicyRule {
  const match: PolicyRule['match'] = {};
  for (const f of MATCH_FIELDS) {
    const v = draft.match[f.key].trim();
    if (v !== '') match[f.key] = v;
  }
  if (draft.commandExact && match.commandPrefix !== undefined) match.commandExact = true;
  const rule: PolicyRule = {
    id: draft.id,
    name: draft.name.trim(),
    enabled: draft.enabled,
    action: draft.action,
    match,
  };
  if (draft.note.trim() !== '') rule.note = draft.note.trim();
  return rule;
}

export function upsertRuleCommand(rule: PolicyRule): HuddleCommand {
  return { type: 'policy.upsertRule', rule };
}

export function removeRuleCommand(ruleId: string): HuddleCommand {
  return { type: 'policy.removeRule', ruleId };
}

export function toggleRuleCommand(rule: PolicyRule, enabled: boolean): HuddleCommand {
  return upsertRuleCommand({ ...rule, enabled });
}

/** "Would have matched 3 of the last 40 requests." */
export function previewWords(p: PolicyPreview): string {
  if (p.examined === 0) return 'Huddle has no recent requests to check against yet.';
  if (p.matched === 0) return `${RULE_WORDS.previewNone} (looked at ${String(p.examined)}).`;
  return `Would have matched ${String(p.matched)} of the last ${String(p.examined)} requests.`;
}

export const OUTCOME_WORDS: Record<PolicyDecision['outcome'], string> = {
  allowed: 'allowed',
  denied: 'denied',
  passed_through: 'asked you',
  expired: 'expired',
  answered_elsewhere: 'answered elsewhere',
};

/** The rule a decision names: its current name, else its id with a note that it is gone. */
export function decisionRule(d: PolicyDecision): string {
  if (d.ruleName !== null) return d.ruleName;
  return d.ruleId === null ? 'a rule' : `${d.ruleId} (no longer in the list)`;
}

/** Rules that appear in the log, for the filter. */
export function decisionRuleIds(decisions: readonly PolicyDecision[]): { id: string; label: string }[] {
  const out = new Map<string, string>();
  for (const d of decisions) if (d.ruleId !== null && !out.has(d.ruleId)) out.set(d.ruleId, decisionRule(d));
  return [...out].map(([id, label]) => ({ id, label }));
}

export function filterDecisions(decisions: readonly PolicyDecision[], ruleId: string | null): PolicyDecision[] {
  return ruleId === null ? [...decisions] : decisions.filter((d) => d.ruleId === ruleId);
}
