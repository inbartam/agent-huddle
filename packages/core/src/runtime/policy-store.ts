/**
 * The approval rules file (M4, F18): `<dataDir>/policy-rules.json`, next to huddle-settings.json. The Huddle's own
 * file, never Claude Code's.
 *
 * Format: `{ "version": 1, "rules": PolicyRule[] }`. A missing file means "first run": the default set
 * (policy/defaults.ts). Anything wrong with the file (not JSON, wrong shape, an invalid rule, two rules with one id)
 * also gives the default set, plus a warning (logged, and shown in the state as `policyWarning`): never an exception,
 * and never a partial list, because
 * dropping one bad rule could drop a deny the user relied on while keeping their allows. The defaults allow only
 * read-only commands, so falling back to them is always safe. Such a file is moved aside before the next save
 * (A2-02), never overwritten.
 *
 * Writes are atomic (temp file + rename, short retry on Windows' EPERM/EBUSY/EACCES) and owner-only, like the settings
 * writer. `upsertPolicyRule` and `removePolicyRule` are pure list edits; HuddleCore writes and then adopts the result.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { PolicyRule } from '@huddle/shared';
import { policyRuleSchema } from '../contracts/m4-schemas.js';
import { defaultPolicyRules } from '../policy/defaults.js';
import { errorCodeOf, preserveBadFile, writeTextAtomic } from './atomic-file.js';

export const POLICY_RULES_FILENAME = 'policy-rules.json';
export const POLICY_RULES_VERSION = 1;
/** More rules than anyone writes by hand; bounds the file and every evaluation. */
export const MAX_POLICY_RULES = 500;

const fileSchema = z.looseObject({
  version: z.number().int().positive(),
  rules: z.array(policyRuleSchema).max(MAX_POLICY_RULES),
});

export interface PolicyRulesLoad {
  rules: PolicyRule[];
  /** Why the file was not used (the defaults are in `rules`), or null. Never carries file contents. */
  warning: string | null;
  /**
   * The file exists but was not used (not JSON, invalid, newer, duplicate ids, a rule that may not be saved): it must
   * be moved aside (`preserveBadPolicyRulesFile`) before the next write, so the user's rules are never overwritten
   * (A2-02). False for a missing file.
   */
  bad: boolean;
  /** The file could not be read (EBUSY, EACCES…): no write until a later read succeeds (A2-02). */
  readFailed: boolean;
}

/** A rule with only the known fields: unknown ones from the renderer or the file are not kept or written. */
export function cleanPolicyRule(rule: PolicyRule): PolicyRule {
  const m = rule.match;
  const match: PolicyRule['match'] = {};
  if (m.tool !== undefined) match.tool = m.tool;
  if (m.commandPrefix !== undefined) match.commandPrefix = m.commandPrefix;
  if (m.commandExact !== undefined) match.commandExact = m.commandExact;
  if (m.pathGlob !== undefined) match.pathGlob = m.pathGlob;
  if (m.role !== undefined) match.role = m.role;
  if (m.folder !== undefined) match.folder = m.folder;
  return {
    id: rule.id,
    name: rule.name,
    enabled: rule.enabled,
    action: rule.action,
    match,
    ...(rule.note !== undefined ? { note: rule.note } : {}),
  };
}

/**
 * Why an allow rule may not be saved. The renderer's editor shows the same words (apps/desktop view/rules.ts keeps a
 * copy of this check, since the renderer may not import core): keep the two in step.
 */
export const POLICY_RULE_PROBLEMS = Object.freeze({
  namesNothing: 'An allow rule must name a tool, a command or a path.',
  shellNeedsCommand: 'An allow rule for Bash or PowerShell must name a command; without one it allows every command.',
  singleWord:
    'An allow rule on one command word allows every use of that program. Add the subcommand (for example "git status", not "git"). Only ls, dir, pwd, Get-ChildItem and Get-Location may stand alone.',
  nonAscii: "An allow rule's command may use plain ASCII characters only.",
  exactNeedsCommand: '"Exactly" needs a command.',
  // AX-05: checked when a rule is saved (`policyRuleSaveProblem`), never when the file is loaded.
  launcher:
    'An allow rule may not start a shell or an interpreter (bash, cmd, powershell, node, python, npx…): it would allow any command passed to it.',
  install: 'An allow rule may not install packages (npm install, pip install…).',
  push: 'An allow rule may not push (git push).',
  discard: 'An allow rule may not throw work away (git clean, git reset).',
  deletes: 'An allow rule may not delete files (rm, del, Remove-Item…).',
});

/**
 * First command words an allow rule may not start with (lower case, `.exe` removed), and what each refusal says
 * (AX-05). A rule's prefix matches with any argument after it, so `bash -c` would allow `bash -c 'rm -rf build'`.
 */
const SAVE_REFUSED_FIRST_WORDS: ReadonlyMap<string, keyof typeof POLICY_RULE_PROBLEMS> = new Map([
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

/** First two command words an allow rule may not start with (lower case), and what each refusal says (AX-05). */
const SAVE_REFUSED_TWO_WORDS: ReadonlyMap<string, keyof typeof POLICY_RULE_PROBLEMS> = new Map([
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

/** Shell tools: an allow on one of them must name a command. */
const SHELL_TOOLS: ReadonlySet<string> = new Set(['Bash', 'PowerShell']);

/**
 * The single-word command prefixes an allow may use (lower case; compared without case): commands that only list a
 * folder or print where the agent is. Any other single word (`git`, `npm`, `node`, `python`, `pwsh`, `cmd`, `bash`,
 * `npx`, `rm`…) would allow every use of that program, so it is refused, exact or not.
 */
export const SINGLE_WORD_ALLOWS: readonly string[] = Object.freeze([
  'ls',
  'dir',
  'pwd',
  'get-childitem',
  'get-location',
]);

/**
 * Why this rule may not be saved, or null. Deny and ask may be as broad as the user likes (fail safe). An allow:
 *   - must name a tool, a command or a path: an allow with only a role or folder (or nothing) would auto-approve every
 *     plain command and file call of those agents;
 *   - for Bash or PowerShell, must name a command;
 *   - with a command, must not be a single word other than `SINGLE_WORD_ALLOWS`, and must be plain ASCII (an allow
 *     never matches a non-ASCII command, policy/rules.ts).
 * A stored file with any such rule loads as the defaults (`parsePolicyRules`).
 */
export function policyRuleProblem(rule: PolicyRule): string | null {
  const m = rule.match;
  if (m.commandExact === true && m.commandPrefix === undefined) return POLICY_RULE_PROBLEMS.exactNeedsCommand;
  if (rule.action !== 'allow') return null;
  if (m.tool === undefined && m.commandPrefix === undefined && m.pathGlob === undefined) {
    return POLICY_RULE_PROBLEMS.namesNothing;
  }
  if (m.tool !== undefined && SHELL_TOOLS.has(m.tool) && m.commandPrefix === undefined) {
    return POLICY_RULE_PROBLEMS.shellNeedsCommand;
  }
  if (m.commandPrefix !== undefined) {
    if (!/^[\x20-\x7e]*$/.test(m.commandPrefix)) return POLICY_RULE_PROBLEMS.nonAscii;
    const words = m.commandPrefix
      .trim()
      .split(/\s+/)
      .filter((w) => w !== '');
    if (words.length === 1 && !SINGLE_WORD_ALLOWS.includes((words[0] ?? '').toLowerCase())) {
      return POLICY_RULE_PROBLEMS.singleWord;
    }
  }
  return null;
}

/**
 * Why this rule may not be SAVED, beyond `policyRuleProblem`, or null (AX-05): an allow whose command starts a shell or
 * an interpreter, installs a package, pushes, throws work away (git clean, git reset) or deletes. Used only when a
 * rule is saved (`policy.upsertRule`), never when the file is loaded, so a file that already holds such a rule keeps
 * loading as it is (A2-02). A rule saved switched off is not refused (R-04): turning a risky rule off must always be
 * possible. Switching it on again is a save like any other and is refused; an exemption for "only the switch changed"
 * would let a risky allow be saved off and then switched on. The renderer's editor keeps a copy (view/rules.ts). Pure.
 */
export function policyRuleSaveProblem(rule: PolicyRule): string | null {
  if (rule.action !== 'allow' || rule.match.commandPrefix === undefined || !rule.enabled) return null;
  const words = rule.match.commandPrefix
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w !== '');
  // A program named by its path or in quotes (`C:/Windows/System32/cmd.exe`, `"bash"`) is the same program.
  const first = (words[0] ?? '')
    .replace(/["']/g, '')
    .replace(/^.*[\\/]/, '')
    .replace(/\.exe$/, '');
  const kind = SAVE_REFUSED_FIRST_WORDS.get(first) ?? SAVE_REFUSED_TWO_WORDS.get(`${first} ${words[1] ?? ''}`);
  return kind === undefined ? null : POLICY_RULE_PROBLEMS[kind];
}

/** Pure: file text (null: no file) to rules. Never throws. */
export function parsePolicyRules(text: string | null): PolicyRulesLoad {
  if (text === null) return { rules: defaultPolicyRules(), warning: null, bad: false, readFailed: false };
  let raw: unknown;
  try {
    raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return {
      rules: defaultPolicyRules(),
      warning: `${POLICY_RULES_FILENAME} is not valid JSON; using the default rules`,
      bad: true,
      readFailed: false,
    };
  }
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      rules: defaultPolicyRules(),
      warning: `${POLICY_RULES_FILENAME} has an invalid rule; using the default rules`,
      bad: true,
      readFailed: false,
    };
  }
  if (parsed.data.version > POLICY_RULES_VERSION) {
    return {
      rules: defaultPolicyRules(),
      warning: `${POLICY_RULES_FILENAME} is from a newer version; using the default rules`,
      bad: true,
      readFailed: false,
    };
  }
  const rules = parsed.data.rules.map(cleanPolicyRule);
  const ids = new Set(rules.map((r) => r.id));
  if (ids.size !== rules.length) {
    return {
      rules: defaultPolicyRules(),
      warning: `${POLICY_RULES_FILENAME} has two rules with one id; using the default rules`,
      bad: true,
      readFailed: false,
    };
  }
  if (rules.some((r) => policyRuleProblem(r) !== null)) {
    return {
      rules: defaultPolicyRules(),
      warning: `${POLICY_RULES_FILENAME} has a rule that may not be saved; using the default rules`,
      bad: true,
      readFailed: false,
    };
  }
  return { rules, warning: null, bad: false, readFailed: false };
}

export function serializePolicyRules(rules: readonly PolicyRule[]): string {
  return `${JSON.stringify({ version: POLICY_RULES_VERSION, rules: rules.map(cleanPolicyRule) }, null, 2)}\n`;
}

/** Pure: the list with `rule` added, or replacing the rule with its id in place. */
export function upsertPolicyRule(rules: readonly PolicyRule[], rule: PolicyRule): PolicyRule[] {
  const clean = cleanPolicyRule(rule);
  const index = rules.findIndex((r) => r.id === clean.id);
  if (index < 0) return [...rules, clean];
  return rules.map((r, i) => (i === index ? clean : r));
}

/** Pure: the list without the rule with this id (the same list when there is none). */
export function removePolicyRule(rules: readonly PolicyRule[], ruleId: string): PolicyRule[] {
  return rules.filter((r) => r.id !== ruleId);
}

export function policyRulesPath(dataDir: string): string {
  return path.join(path.resolve(dataDir), POLICY_RULES_FILENAME);
}

/** Reads the rules file. A missing or unreadable file never throws. */
export async function readPolicyRules(dataDir: string): Promise<PolicyRulesLoad> {
  let text: string | null;
  try {
    text = await fsp.readFile(policyRulesPath(dataDir), 'utf8');
  } catch (error) {
    if (errorCodeOf(error) === 'ENOENT') return parsePolicyRules(null);
    return {
      rules: defaultPolicyRules(),
      warning: `${POLICY_RULES_FILENAME} could not be read; using the default rules`,
      bad: false,
      readFailed: true,
    };
  }
  return parsePolicyRules(text);
}

/**
 * Moves a rules file that was not used aside to `policy-rules.json.bad-<epoch ms>`, so the next write does not destroy
 * it (A2-02, as `preserveBadTemplatesFile`). Returns the new name, or null when there is no file.
 */
export async function preserveBadPolicyRulesFile(dataDir: string, now: number): Promise<string | null> {
  return preserveBadFile(policyRulesPath(dataDir), now);
}

export async function writePolicyRules(dataDir: string, rules: readonly PolicyRule[]): Promise<void> {
  await writeTextAtomic(policyRulesPath(dataDir), serializePolicyRules(rules));
}

/** Temp file + rename, owner-only, with a short retry (Windows refuses a rename while another process has the file). */
