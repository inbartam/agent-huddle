/**
 * The default approval rules (F18, ADR-020 §3). Read-only commands only: nothing here deletes, pushes, installs a
 * package or uses the network. Changing this list needs the owner's explicit approval.
 *
 * Every rule is an allow for a plain command; `rules.ts` refuses an allow for any compound or redirected command, for
 * `--output` / `--ext-diff` / `--no-index` (and their git abbreviations), for any path outside the session folder
 * (A2-01), for network paths, PowerShell provider drives such as
 * `Env:`, and for clipped or masked input, whatever the rule says. The version rules are exact (`commandExact`), so no
 * argument can ride along. A request no rule matches goes to the user: there is no deny-by-default rule, because
 * "unmatched" already means "ask".
 *
 * Ids are stable (`default:*`): stored events name them, and the rules file keeps them.
 */
import type { PolicyRule } from '@huddle/shared';

function allowCommand(
  id: string,
  prefix: string,
  note: string,
  options: { exact?: boolean; tool?: 'PowerShell' } = {},
): PolicyRule {
  const match: PolicyRule['match'] = { commandPrefix: prefix };
  if (options.exact === true) match.commandExact = true;
  if (options.tool !== undefined) match.tool = options.tool;
  return {
    id: `default:${id}`,
    name: options.exact === true ? prefix : `${prefix} …`,
    enabled: true,
    action: 'allow',
    match,
    note,
  };
}

const READ_ONLY_GIT =
  'Reads the repository inside the project; a path outside it, --no-index, --output (writes a file) or --ext-diff still asks you.';
const EXACT = 'exactly this command, no arguments.';
const LISTING =
  'Lists a folder inside the project. Paths outside it, network paths and provider drives such as Env: still ask you.';

/** The default rule set, in display order. */
export const DEFAULT_POLICY_RULES: readonly PolicyRule[] = Object.freeze([
  allowCommand('git-status', 'git status', READ_ONLY_GIT),
  allowCommand('git-diff', 'git diff', READ_ONLY_GIT),
  allowCommand('git-log', 'git log', READ_ONLY_GIT),
  allowCommand('ls', 'ls', LISTING),
  allowCommand('dir', 'dir', LISTING),
  allowCommand('get-childitem', 'Get-ChildItem', LISTING, { tool: 'PowerShell' }),
  allowCommand('pwd', 'pwd', 'Prints the working folder.'),
  allowCommand('get-location', 'Get-Location', 'Prints the working folder.', { tool: 'PowerShell' }),
  allowCommand('node-version', 'node --version', `Prints the Node.js version; ${EXACT}`, { exact: true }),
  allowCommand('npm-version', 'npm --version', `Prints the npm version; ${EXACT}`, { exact: true }),
  allowCommand('claude-version', 'claude --version', `Prints the Claude Code version; ${EXACT}`, { exact: true }),
]);

/** A fresh, mutable copy of the default rules. */
export function defaultPolicyRules(): PolicyRule[] {
  return DEFAULT_POLICY_RULES.map((rule) => ({ ...rule, match: { ...rule.match } }));
}
