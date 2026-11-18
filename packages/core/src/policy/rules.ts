/**
 * Approval rules (F18, ADR-020 §3): `evaluate(rules, input)` says what the rules decide for one permission request.
 * Pure: no clock, no I/O, no `process` (paths use `node:path`'s win32 functions only in their pure forms).
 *
 * Precedence: any matching deny beats any matching ask beats any matching allow, whatever the order of the list.
 * Disabled rules are skipped. No match: null, and the request goes to the inbox as without rules.
 *
 * Every `match` field given must hold (AND):
 *   tool           exact, case-sensitive (Claude Code tool names).
 *   commandPrefix  Bash and PowerShell only: the trimmed command is the prefix or starts with it followed by a space
 *                  (`git status` matches `git status -s`, not `git statusx`). Words are split by `commandTokens`
 *                  (any whitespace, Unicode spaces included; smart quotes and dashes read as ASCII), the one
 *                  tokenizer every command check uses.
 *                  `commandExact`: the command must be the prefix and nothing more (no arguments).
 *   pathGlob       file tools: a glob (`*`, `**`, `?`) over the tool's path relative to the session cwd, compared
 *                  case-insensitively with win32 separators. An absolute glob is compared with the absolute path.
 *   role           exact.
 *   folder         the session cwd is this folder or inside it (case-insensitive, normalized).
 *
 * Allow is held to a stricter standard than deny and ask, so that every doubt sends the request to the user:
 *   - an allow never matches when the input could not be read, was clipped, or carries (masked) secrets;
 *   - for Bash and PowerShell, an allow never matches a command with a character outside printable ASCII (PowerShell
 *     reads Unicode spaces as word breaks and smart quotes as quotes), with compound, redirect, substitution,
 *     expansion or control syntax (see `UNSAFE_BASH` / `UNSAFE_POWERSHELL`), with an argument that writes or runs a
 *     configured program (`--output`, `--ext-diff` and their abbreviations), or with a token that, without its
 *     quotes, holds two separators in a row (`\\host`, `//host`, `'/'/host`, `\/host`, `\\.\`, `\\?\`) or `\??\`;
 *   - allows are contained in the trusted session folder (`sessionCwd`, not the payload's `cwd`, which follows the
 *     agent's own `cd`): with it unknown, no allow matches at all; when the request's cwd is outside it, no allow
 *     matches; folder rules test it; globs are relative to it;
 *   - every path a file tool names (Read, Write, Edit, MultiEdit, NotebookEdit, Glob, Grep, and any tool whose facts
 *     carry paths) must resolve inside the session folder for any allow, with or without a `pathGlob`; a device or UNC
 *     path, an alternate data stream, a `~` segment or a `%VAR%` / `$VAR` never matches an allow;
 *   - PowerShell tokens may name file system paths only: no `::` and no colon other than a one-letter drive;
 *   - a role, folder or command condition that cannot be checked (unknown value) fails for an allow;
 *   - an allow never approves a write to one of Claude Code's protected paths (`PROTECTED_PATHS`): not for a file
 *     write tool whose path is under a protected directory or is a protected file, and not for a shell command any of
 *     whose tokens names one. It is not documented whether a PermissionRequest allow overrides that protection, so
 *     the Huddle is never what approves it.
 * Deny and ask are fail safe: they match regardless of clipping or masking, an unknown value counts as a match, a
 * command prefix is also tried on every segment of a compound command, and paths are compared with Windows' own
 * equivalences removed (trailing dots and spaces, `::$DATA` stream suffixes).
 *
 * Known limits (best effort, Claude Code's own permission rules stay the floor): 8.3 short names, symlinks and
 * junctions are not resolved; a repository's git config can still make `git diff` or `git status` run programs.
 */
import path from 'node:path';
import type { AgentOrigin, PolicyRule } from '@huddle/shared';

/** What a rule decides. */
export type PolicyAction = PolicyRule['action'];

/** The raw facts of one permission request, in memory only. Never written to the log. */
export interface PolicyInput {
  /** The tool name exactly as Claude Code sent it. */
  toolName: string;
  /** Bash and PowerShell: the raw command. Null for other tools, or when the command could not be read. */
  command: string | null;
  /** The raw path(s) the call names (file tools, Glob and Grep `path`). Empty when the tool names none. */
  paths: readonly string[];
  /** The agent's role ("main", "Explore"), or null when unknown. */
  role: string | null;
  /**
   * The working folder as the request reports it (the payload's `cwd`, which follows the agent's own `cd`), or null
   * when it carried none. Untrusted: only deny and ask match on it.
   */
  cwd: string | null;
  /**
   * The trusted session folder (`AgentNode.sessionCwd` of the root: where the run was launched, or the first folder
   * the session reported), or null when unknown. Allow decisions are contained in it: an allow never matches when
   * `cwd` is outside it, folder rules test it, and path globs are relative to it.
   */
  sessionCwd: string | null;
  origin: AgentOrigin;
  /** The input as seen is cut short (stored text, or longer than the log keeps). An allow never matches. */
  clipped: boolean;
  /** The input as seen had secrets masked, or carries text that looks like a secret. An allow never matches. */
  masked: boolean;
  /** The tool input was present and of the expected shape. An allow never matches when false. */
  readable: boolean;
}

export interface PolicyVerdict {
  action: PolicyAction;
  ruleId: string;
  ruleName: string;
}

type Shell = 'bash' | 'powershell';

/** Claude Code's shell tools and the syntax their command is read with. */
export function shellOf(toolName: string): Shell | null {
  if (toolName === 'Bash') return 'bash';
  if (toolName === 'PowerShell') return 'powershell';
  return null;
}

/**
 * Bash syntax that makes a command more than one plain command, or lets its arguments change after it was read:
 * `&` (covers `&&` and a trailing `&`), `|` (covers `||`), `;`, backtick, `$` (substitution `$(`, variables, `$'…'`),
 * `<` and `>` (redirects, process substitution), braces (brace expansion), parentheses (subshells, extglob), glob
 * characters (a file named `--output=x` turns `*` into an option), every control character including tab and
 * newline, backslash (Bash unescapes `.g\it` to `.git`, while the win32 path check reads `\` as a separator) and tilde
 * (`~-`, `~+`, `~user` expand to other folders).
 */
// eslint-disable-next-line no-control-regex -- control characters are part of what is refused
const UNSAFE_BASH = /[&|;`$<>(){}*?[\]\\~\u0000-\u001f\u007f\u0085\u2028\u2029]/;

/**
 * PowerShell: `;`, `|`, `&` (call operator, `&&`), backtick (escape), `$` (subexpressions, variables), `@` (array
 * subexpression, splatting), `<` `>` (redirects), parentheses (a grouping expression runs a command), braces (script
 * blocks), wildcard characters (`*`, `?`, `[`, `]`: cmdlets expand them, so `.gi?\config` reaches `.git\config`), and
 * control characters.
 */
// eslint-disable-next-line no-control-regex -- control characters are part of what is refused
const UNSAFE_POWERSHELL = /[;|&`$@<>(){}*?[\]\u0000-\u001f\u007f\u0085\u2028\u2029]/;

/**
 * Argument prefixes that void any allow. git accepts unambiguous abbreviations of long options, so `--ou…` covers
 * `--output` (writes a file from `git diff` / `git log`), `--ext…` covers `--ext-diff` (runs a configured program) and
 * `--no-i…` covers `--no-index` (`git diff` then compares any two files on the machine, A2-01).
 */
const UNSAFE_ARG_PREFIXES: readonly string[] = ['--ou', '--ext', '--no-i'];
/**
 * git's `-O<file>` (git diff, git log) reads an order file glued to the option, also inside a bundle of short options
 * (`-pO<file>`, `-RO<file>`), so the path is never a token of its own (R-07). In a git command it voids any allow, and
 * the text after the `O` is a path candidate too (`tokenCandidates`). Case-sensitive: `-o` is another option.
 */
const GIT_ORDER_FILE = /^-[A-Za-z]*O(.*)$/;
/** The program word of a git command: `git`, `git.exe`, by path or in quotes. */
const GIT_PROGRAM = /^(?:.*[\\/])?git(?:\.exe)?$/i;

/**
 * PowerShell: a token may name only file system paths. Provider paths reach the environment (`Env:`,
 * `Microsoft.PowerShell.Core\Environment::`), variables, the registry or a share (`FileSystem::\\host\share`), so any
 * `::` and any colon that is not a one-letter drive (`C:` at the start of a `\`- or `/`-separated piece) voids an allow.
 * Quotes are removed first (`'x'+'Env:'`). This also refuses `-Path:C:\x` (the colon form of a parameter): it asks.
 */
function plainPowerShellToken(raw: string): boolean {
  const token = raw.replace(/["']/g, '');
  if (token.includes('::')) return false;
  for (const piece of token.split(/[\\/]/)) {
    for (let i = piece.indexOf(':'); i >= 0; i = piece.indexOf(':', i + 1)) {
      if (i !== 1 || !/^[A-Za-z]$/.test(piece.charAt(0))) return false;
    }
  }
  return true;
}

/** Dashes PowerShell reads as `-`. */
const DASHES = /[\u2013\u2014\u2015]/g;
/** Quotes PowerShell reads as `'` (`\u2018 \u2019 \u201a \u201b`) and as `"` (`\u201c \u201d \u201e \u201f`). */
const SINGLE_QUOTES = /[\u2018\u2019\u201a\u201b]/g;
const DOUBLE_QUOTES = /[\u201c\u201d\u201e\u201f]/g;
/**
 * What separates words: JS `\s` (ASCII space and tab, NBSP, the Unicode spaces U+2000\u2013U+200A, U+202F, U+205F,
 * U+3000, line and paragraph separators, BOM) plus NEL and the Mongolian vowel separator. PowerShell breaks words on
 * all of these; Bash only on ASCII ones, so splitting on more only over-splits (deny and ask match more).
 */
const WORD_BREAK = /[\s\u0085\u180e]+/;
/** An allow only ever matches a command made of printable ASCII (space to `~`). */
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

/**
 * The one tokenizer every command check uses (`isPlainCommand`, `commandMatches`, `namesProtectedPath`): dashes and
 * quotes PowerShell treats as `-`, `'` and `"` are replaced by those, then the text is split on any whitespace
 * (`WORD_BREAK`). Exported for tests.
 */
export function commandTokens(text: string): string[] {
  return text
    .replace(DASHES, '-')
    .replace(SINGLE_QUOTES, "'")
    .replace(DOUBLE_QUOTES, '"')
    .split(WORD_BREAK)
    .filter((t) => t !== '');
}

/**
 * A token (quotes already removed) that may reach a network share or a device: two separators in a row anywhere
 * (`\\host`, `//host`, `\/host`, `x=//host`, `-Path://host`, `\\.\pipe`, `\\?\C:`), or the NT object prefix `\??\`.
 * Windows opens SMB to the host for a UNC path, which leaks the user's NTLM hash.
 */
function namesNetworkPath(unquoted: string): boolean {
  return /[\\/]{2}/.test(unquoted) || /[\\/]\?\?[\\/]/.test(unquoted);
}

const ACTIONS: ReadonlySet<string> = new Set(['allow', 'ask', 'deny']);

/** The rules' verdict for one request, or null when none matches. Pure. */
export function evaluate(rules: readonly PolicyRule[], input: PolicyInput): PolicyVerdict | null {
  let ask: PolicyVerdict | null = null;
  let allow: PolicyVerdict | null = null;
  for (const rule of rules) {
    if (!rule.enabled) continue;
    // A stored file is checked with zod; this guards hand-built lists too.
    if (!ACTIONS.has(rule.action)) continue;
    if (!ruleMatches(rule, input)) continue;
    const verdict: PolicyVerdict = { action: rule.action, ruleId: rule.id, ruleName: rule.name };
    if (rule.action === 'deny') return verdict;
    if (rule.action === 'ask') ask ??= verdict;
    else allow ??= verdict;
  }
  return ask ?? allow;
}

/** Does this one rule match? Allow rules are checked strictly (see the file comment). Ignores `enabled`. */
export function ruleMatches(rule: PolicyRule, input: PolicyInput): boolean {
  const strict = rule.action === 'allow';
  const m = rule.match;
  if (strict && !allowSafe(input)) return false;
  if (m.tool !== undefined && m.tool !== input.toolName) return false;
  if (m.role !== undefined && (input.role === null ? strict : input.role !== m.role)) return false;
  if (m.folder !== undefined && !folderMatches(m.folder, input, strict)) return false;
  if (m.commandPrefix !== undefined && !commandMatches(m.commandPrefix, m.commandExact === true, input, strict)) {
    return false;
  }
  if (m.pathGlob !== undefined && !pathMatches(m.pathGlob, input, strict)) return false;
  return true;
}

/** The conditions every allow needs, whatever its match fields. */
function allowSafe(input: PolicyInput): boolean {
  if (!input.readable || input.clipped || input.masked) return false;
  // Allows are contained in the trusted session folder: with it unknown (an attached session never seen starting),
  // nothing is allowed automatically, whatever the tool.
  const trusted = input.sessionCwd;
  if (trusted === null || absoluteFolder(trusted) === null) return false;
  // The agent's own `cd` may have left the session folder: then nothing is allowed automatically.
  if (input.cwd !== null && !folderContains(trusted, input.cwd)) return false;
  // Every path a file tool names resolves inside the session folder, whatever the rule's match fields (a `{tool:
  // 'Edit'}` allow must not reach the Startup folder or ~/.ssh). Glob and Grep may name none: they search the cwd.
  if (FILE_TOOLS.has(input.toolName) || input.paths.length > 0) {
    if (input.paths.length === 0 && !PATH_OPTIONAL_TOOLS.has(input.toolName)) return false;
    if (!input.paths.every((p) => containedPath(p, input) !== null)) return false;
  }
  // One protected-path check (`touchesProtected`) for every path an allow could touch.
  if (WRITE_TOOLS.has(input.toolName) && input.paths.some((p) => touchesProtected(p, input))) return false;
  const shell = shellOf(input.toolName);
  if (shell === null) return true;
  // A shell runs where the agent is: inside a protected folder (`cd .git`), a bare `config` is a protected file.
  if ([input.cwd, input.sessionCwd].some((c) => c !== null && protectedForAllow(c))) return false;
  return (
    input.command !== null &&
    isPlainCommand(input.command, shell) &&
    !namesProtectedPath(input.command, input) &&
    namesOnlyContainedPaths(input.command, input)
  );
}

/**
 * A token reading that names a path: absolute (`/x`, `C:x`, `C:/x`, `\\host`), from the home folder (`~`), or with a
 * separator, or `..`. Plain words (`status`, `-la`, `NUL`) are not paths; `HEAD~1` is refused by the charset anyway.
 */
function pathLike(candidate: string): boolean {
  return /[\\/]/.test(candidate) || /^[A-Za-z]:/.test(candidate) || candidate.startsWith('~') || candidate === '..';
}

/**
 * Every path a shell command names resolves inside the trusted session folder (`containedPath`), so a default allow
 * such as `git diff` or `ls` never reads outside the project (A2-01). Over-matching only sends the request to the user.
 */
function namesOnlyContainedPaths(command: string, input: PolicyInput): boolean {
  return commandTokens(command).every((raw) =>
    tokenCandidates(raw).every((c) => !pathLike(c) || containedPath(c, input) !== null),
  );
}

// --- protected paths ----------------------------------------------------------------------------------------------

/**
 * Claude Code's protected paths, as docs/INTEGRATION.md §3 "Protected paths and read-only commands (docs-checked
 * 2026-11-14)" lists them (permission-modes.md "Protected paths"). Lower case; compared case-insensitively with either
 * separator, after Windows' equivalences are removed (trailing dots and spaces, stream suffixes).
 *   dirs:            a path with one of these as any segment is protected (`.config/git` is the pair below);
 *   dirPairs:        two consecutive segments;
 *   dirExceptions:   under a protected directory, these sub-folders are not (`.claude/worktrees/…`); a protected
 *                    segment further down still counts. The session's own plan files and memory Markdown are also
 *                    exempt in Claude Code, but the Huddle cannot tell them apart, so they stay protected here;
 *   files:           protected base names (shell rc files: the common ones for bash, zsh, sh, csh, ksh, fish and
 *                    PowerShell profiles);
 *   filePatterns:    protected base names by pattern (`.yarnrc*`, `lefthook.y*ml`, PowerShell `*profile.ps1`).
 * Not covered: a `--plugin-dir` folder and files passed to `--settings`, `--mcp-config` or `--agents` (not known here).
 */
export const PROTECTED_PATHS = Object.freeze({
  dirs: Object.freeze([
    '.git',
    '.vscode',
    '.idea',
    '.husky',
    '.cargo',
    '.devcontainer',
    '.yarn',
    '.mvn',
    '.claude',
    'dev-mods',
  ]),
  dirPairs: Object.freeze([Object.freeze(['.config', 'git'] as const)]),
  dirExceptions: Object.freeze([Object.freeze(['.claude', 'worktrees'] as const)]),
  files: Object.freeze([
    '.gitconfig',
    '.gitmodules',
    '.bashrc',
    '.bash_profile',
    '.bash_login',
    '.bash_logout',
    '.bash_aliases',
    '.zshrc',
    '.zshenv',
    '.zprofile',
    '.zlogin',
    '.zlogout',
    '.profile',
    '.envrc',
    '.cshrc',
    '.tcshrc',
    '.kshrc',
    '.inputrc',
    'config.fish',
    '.npmrc',
    '.pnpmfile.cjs',
    'bunfig.toml',
    '.bazelrc',
    '.pre-commit-config.yaml',
    '.ripgreprc',
    'pyrightconfig.json',
    '.mcp.json',
    '.claude.json',
  ]),
  filePatterns: Object.freeze([/^\.yarnrc/, /^lefthook\.y[a-z]*ml$/, /profile\.ps1$/]),
});

/** File tools that write: their path is checked against `PROTECTED_PATHS` (Read, Glob and Grep only read). */
const WRITE_TOOLS: ReadonlySet<string> = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

const PROTECTED_DIRS: ReadonlySet<string> = new Set(PROTECTED_PATHS.dirs);
const PROTECTED_FILES: ReadonlySet<string> = new Set(PROTECTED_PATHS.files);

/**
 * The path's segments for comparison: `win32.normalize` first (so `.` and `..` collapse where they can and
 * `.claude/worktrees/../settings.json` is `.claude/settings.json`), then `comparable` (lower case, `/`, trailing dots,
 * spaces and stream suffixes removed). A relative path may keep leading `..` segments.
 */
function segmentsOf(p: string): string[] {
  return comparable(win.normalize(p))
    .split('/')
    .filter((s) => s !== '' && s !== '.');
}

/**
 * Does this path name a protected directory (as any segment) or a protected file (as its base name)? Pure; any path
 * form (relative, absolute, either separator, any case), normalized first. Exported for tests and the preview.
 */
export function isProtectedPath(p: string): boolean {
  const segments = segmentsOf(p);
  if (segments.length === 0) return false;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i] ?? '';
    const next = segments[i + 1];
    const exempt = PROTECTED_PATHS.dirExceptions.some(
      ([dir, sub]) => seg === dir && next === sub && i + 2 < segments.length,
    );
    if (exempt) {
      i += 1; // skip the exempt sub-folder; anything protected further down still counts
      continue;
    }
    if (PROTECTED_DIRS.has(seg)) return true;
    if (PROTECTED_PATHS.dirPairs.some(([a, b]) => seg === a && next === b)) return true;
  }
  const base = segments[segments.length - 1] ?? '';
  return PROTECTED_FILES.has(base) || PROTECTED_PATHS.filePatterns.some((re) => re.test(base));
}

/** A Windows 8.3 short name (`GIT~1`, `GITCON~1`): it may alias any protected name, and the Huddle cannot resolve it. */
const SHORT_NAME = /~\d/;

/**
 * For an allow, one path form is off limits when it is protected (`isProtectedPath`), or when the Huddle cannot pin
 * down what it names: a `..` segment left after normalizing (it climbs out of wherever it is resolved), or an 8.3
 * short-name segment. Exported for tests.
 */
export function protectedForAllow(p: string): boolean {
  if (isProtectedPath(p)) return true;
  return segmentsOf(p).some((s) => s === '..' || SHORT_NAME.test(s));
}

/** The folders a candidate path is resolved in: where the request says the agent is, and the session folder. */
interface Bases {
  cwd: string | null;
  sessionCwd: string | null;
}

/**
 * One check for every path an allow could touch: the candidate as written and as resolved against each base
 * (normalized, so `.`/`..` collapse); any form `protectedForAllow` refuses voids the allow.
 */
function touchesProtected(candidate: string, bases: Bases): boolean {
  if (protectedForAllow(candidate)) return true;
  return [bases.cwd, bases.sessionCwd].some((base) => {
    const resolved = resolveIn(base, candidate);
    return resolved !== null && protectedForAllow(resolved);
  });
}

/** The path-like readings of one shell token: without quotes, without a leading redirect, after `=` or `-Param:`. */
function tokenCandidates(raw: string): string[] {
  const token = raw.replace(DASHES, '-').replace(/["']/g, '');
  const candidates = [token, token.replace(/^[0-9]*[<>|&]+/, '')];
  const eq = token.lastIndexOf('=');
  if (eq >= 0) candidates.push(token.slice(eq + 1));
  const param = /^-[A-Za-z][A-Za-z0-9]*:(.+)$/.exec(token);
  if (param?.[1] !== undefined) candidates.push(param[1]);
  // git's `-O<file>`, alone or in a bundle (`-pO<file>`, R-07). Over-matching other programs only asks more.
  const order = GIT_ORDER_FILE.exec(token);
  if (order?.[1] !== undefined) candidates.push(order[1]);
  return candidates.filter((c) => c !== '');
}

/**
 * Does any token of this command name, or resolve to, a path an allow must not touch (`touchesProtected`)? With no
 * bases, only the tokens as written are checked. Over-matching only sends more requests to the user. Exported for
 * tests.
 */
export function namesProtectedPath(command: string, bases: Bases = { cwd: null, sessionCwd: null }): boolean {
  return commandTokens(command).some((raw) => tokenCandidates(raw).some((c) => touchesProtected(c, bases)));
}

/**
 * A single plain command an allow may match: printable ASCII only (PowerShell reads Unicode spaces as word breaks and
 * smart quotes as quotes, so a non-ASCII character can hide an argument), no compound, redirect, substitution or
 * expansion syntax, no argument that writes or runs something configured, no network or device path. Exported for
 * tests.
 */
export function isPlainCommand(command: string, shell: Shell): boolean {
  if (!PRINTABLE_ASCII.test(command)) return false;
  const unsafe = shell === 'bash' ? UNSAFE_BASH : UNSAFE_POWERSHELL;
  if (unsafe.test(command)) return false;
  const tokens = commandTokens(command);
  const git = GIT_PROGRAM.test((tokens[0] ?? '').replace(/["']/g, ''));
  for (const raw of tokens) {
    // Quotes join text in both shells (`--out""put`, `'/'/host`), so look at the token without them.
    const unquoted = raw.replace(/["']/g, '');
    // Escapes too, for the argument check (Bash `--out\put`; a backslash is refused in Bash anyway).
    const lower = unquoted.replace(/\\/g, '').toLowerCase();
    if (UNSAFE_ARG_PREFIXES.some((p) => lower.startsWith(p))) return false;
    if (git && GIT_ORDER_FILE.test(unquoted.replace(DASHES, '-'))) return false;
    if (namesNetworkPath(unquoted)) return false;
    if (shell === 'powershell' && !plainPowerShellToken(raw)) return false;
  }
  return true;
}

// --- commands -----------------------------------------------------------------------------------------------------

/** The command's words (`commandTokens`) joined by one space. */
function collapse(text: string): string {
  return commandTokens(text).join(' ');
}

function startsWithWord(command: string, prefix: string, exact: boolean): boolean {
  if (prefix === '') return false;
  if (exact) return command === prefix;
  return command === prefix || command.startsWith(`${prefix} `);
}

/** Splits a command on compound syntax, for deny and ask only (over-splitting only makes them match more). */
const SEGMENT_SPLIT = /&&|\|\||[;|&\n\r`]|\$\(|[()]/;

function commandMatches(prefix: string, exact: boolean, input: PolicyInput, strict: boolean): boolean {
  const shell = shellOf(input.toolName);
  if (shell === null) return false;
  if (input.command === null) return !strict;
  const fold = !strict || shell === 'powershell';
  const norm = (s: string) => (fold ? collapse(s).toLowerCase() : collapse(s));
  const p = norm(prefix);
  const whole = norm(input.command);
  if (startsWithWord(whole, p, exact)) return true;
  if (strict) return false;
  return input.command
    .split(SEGMENT_SPLIT)
    .map(norm)
    .some((segment) => startsWithWord(segment, p, exact));
}

// --- folders and paths --------------------------------------------------------------------------------------------

const win = path.win32;
/** `C:\…` or `C:/…`. */
const DRIVE_ABSOLUTE = /^[a-zA-Z]:[\\/]/;
/** `\\server\share`, `\\?\…`, `\\.\…`, `//server`. */
const UNC_OR_DEVICE = /^[\\/]{2}/;
/** `C:foo` (relative to drive C's own current folder: resolving it would read process state). */
const DRIVE_RELATIVE = /^[a-zA-Z]:(?![\\/])/;

/** An absolute folder with a drive letter or UNC root, normalized, without a trailing separator; else null. */
function absoluteFolder(folder: string): string | null {
  if (!DRIVE_ABSOLUTE.test(folder) && !UNC_OR_DEVICE.test(folder)) return null;
  const normalized = win.normalize(folder);
  return normalized.replace(/[\\]+$/, '');
}

/** Is `inner` the folder `outer` or inside it? Both must be absolute (drive or UNC); case-insensitive. */
function folderContains(outer: string, inner: string): boolean {
  const o = absoluteFolder(outer);
  const i = absoluteFolder(inner);
  if (o === null || i === null) return false;
  const ol = o.toLowerCase();
  const il = i.toLowerCase();
  return il === ol || il.startsWith(`${ol}\\`);
}

/**
 * Allow: the trusted session folder is the rule's folder or inside it. Deny and ask: either folder is (or both are
 * unknown, or not absolute: fail safe).
 */
function folderMatches(folder: string, input: PolicyInput, strict: boolean): boolean {
  if (absoluteFolder(folder) === null) return false;
  if (strict) return input.sessionCwd !== null && folderContains(folder, input.sessionCwd);
  const known = [input.cwd, input.sessionCwd].filter((c): c is string => c !== null && absoluteFolder(c) !== null);
  if (known.length === 0) return true;
  return known.some((c) => folderContains(folder, c));
}

/** The absolute, normalized path, resolved against the cwd when relative; null when that needs process state. */
function resolveIn(cwd: string | null, p: string): string | null {
  if (DRIVE_ABSOLUTE.test(p) || UNC_OR_DEVICE.test(p)) return win.normalize(p);
  if (DRIVE_RELATIVE.test(p)) return null;
  const base = cwd === null ? null : absoluteFolder(cwd);
  if (base === null) return null;
  // Pure here: `base` has a drive (or UNC root), so resolve never consults the process's current folder.
  return win.resolve(base, p);
}

/** The path relative to the cwd when it lies inside it ('' for the cwd itself); null when outside or unknown. */
function insideCwd(cwd: string | null, resolved: string): string | null {
  if (cwd === null) return null;
  const base = absoluteFolder(cwd);
  if (base === null) return null;
  const rel = win.relative(base, resolved);
  if (rel === '..' || rel.startsWith('..\\') || win.isAbsolute(rel) || DRIVE_RELATIVE.test(rel)) return null;
  return rel;
}

/**
 * Windows treats `a.txt.`, `a.txt ` and `a.txt::$DATA` as `a.txt`: compare without them, lower case, `/` separators.
 * The drive's colon is kept.
 */
function comparable(p: string): string {
  const slashed = p.replace(/\\/g, '/').toLowerCase();
  const drive = /^[a-z]:/.exec(slashed)?.[0] ?? '';
  const rest = slashed.slice(drive.length);
  const segments = rest.split('/').map((s) => {
    if (s === '.' || s === '..') return s;
    const noStream = s.split(':')[0] ?? s;
    return noStream.replace(/[. ]+$/, '');
  });
  return drive + segments.join('/');
}

/**
 * A path an allow may match at all: no device or UNC root, no stream or other colon, no control characters, nothing a
 * tool or shell might expand to another folder (a segment starting with `~` is the home folder or another user's,
 * `%VAR%` and `$VAR` are variables).
 */
function allowablePath(p: string): boolean {
  if (UNC_OR_DEVICE.test(p)) return false;
  if (p.lastIndexOf(':') > 1) return false;
  if (p.indexOf(':') === 0) return false;
  // eslint-disable-next-line no-control-regex -- control characters are what is refused here
  if (/[\u0000-\u001f\u007f]/.test(p)) return false;
  if (/(?:^|[\\/])~/.test(p) || /[%$]/.test(p)) return false;
  // A trailing dot or space changes what Windows opens; an allow never guesses.
  return !/[. ]$/.test(p.replace(/[\\/]+$/, ''));
}

/**
 * For an allow: the path resolved and relative to the trusted session folder when it is allowable and lies inside it;
 * else null. A relative path is resolved where the agent is (`allowSafe` has checked that is inside the trusted
 * folder), or in the trusted folder when the request named no cwd.
 */
function containedPath(p: string, input: PolicyInput): { resolved: string; rel: string } | null {
  const trusted = input.sessionCwd;
  if (trusted === null || !allowablePath(p)) return null;
  const resolved = resolveIn(input.cwd ?? trusted, p);
  if (resolved === null) return null;
  const rel = insideCwd(trusted, resolved);
  return rel === null ? null : { resolved, rel };
}

function isAbsoluteGlob(glob: string): boolean {
  return DRIVE_ABSOLUTE.test(glob) || UNC_OR_DEVICE.test(glob);
}

function pathMatches(glob: string, input: PolicyInput, strict: boolean): boolean {
  if (input.paths.length === 0) return !strict && !input.readable && fileToolLike(input);
  const absoluteGlob = isAbsoluteGlob(glob);
  const matcher = compileGlob(comparable(absoluteGlob ? win.normalize(glob) : glob.replace(/^(?:\.[\\/])+/, '')));
  if (strict) {
    // Contained in the trusted folder (`containedPath`); the glob is relative to the trusted folder.
    return input.paths.every((p) => {
      const contained = containedPath(p, input);
      return contained !== null && matcher(comparable(absoluteGlob ? contained.resolved : contained.rel));
    });
  }
  const bases = [input.cwd, input.sessionCwd];
  return input.paths.some((p) => {
    const candidates: string[] = [comparable(p)];
    for (const base of bases) {
      const resolved = resolveIn(base, p);
      if (resolved === null) continue;
      candidates.push(comparable(resolved));
      for (const inner of bases) {
        const rel = insideCwd(inner, resolved);
        if (rel !== null) candidates.push(comparable(rel));
      }
    }
    return candidates.some((c) => matcher(c));
  });
}

/** Without a readable input, a path rule cannot tell; only tools that take a path are counted as "maybe". */
function fileToolLike(input: PolicyInput): boolean {
  return FILE_TOOLS.has(input.toolName);
}

/** Tools whose input names a path (file tools, plus Glob and Grep's `path`). */
export const FILE_TOOLS: ReadonlySet<string> = new Set([
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Glob',
  'Grep',
]);

/** File tools that may name no path (they search the cwd); the others always name one (`normalize/hook-facts.ts`). */
const PATH_OPTIONAL_TOOLS: ReadonlySet<string> = new Set(['Glob', 'Grep']);

// --- glob -----------------------------------------------------------------------------------------------------------

type GlobToken =
  | { kind: 'lit'; ch: string }
  | { kind: 'one' } // ?  one character, not a separator
  | { kind: 'star' } // *  any run without a separator
  | { kind: 'globstar' } // ** any run, separators included
  | { kind: 'globstarDir' }; // **/ nothing, or any run ending with a separator

function tokenize(glob: string): GlobToken[] {
  const tokens: GlobToken[] = [];
  let i = 0;
  while (i < glob.length) {
    if (glob.startsWith('**/', i)) {
      tokens.push({ kind: 'globstarDir' });
      i += 3;
    } else if (glob.startsWith('**', i)) {
      tokens.push({ kind: 'globstar' });
      i += 2;
    } else if (glob[i] === '*') {
      tokens.push({ kind: 'star' });
      i += 1;
    } else if (glob[i] === '?') {
      tokens.push({ kind: 'one' });
      i += 1;
    } else {
      tokens.push({ kind: 'lit', ch: glob[i] ?? '' });
      i += 1;
    }
  }
  return tokens;
}

/**
 * A matcher for a glob already in comparable form (lower case, `/`). Dynamic programming over (token, position):
 * O(tokens × length), so no pattern can make it backtrack. Exported for tests.
 */
export function compileGlob(glob: string): (subject: string) => boolean {
  const tokens = tokenize(glob);
  return (s) => {
    const n = s.length;
    // next[j]: tokens t+1.. match s[j..]; built from the last token back.
    let next: boolean[] = Array.from({ length: n + 1 }, (_, j) => j === n);
    for (let t = tokens.length - 1; t >= 0; t--) {
      const token = tokens[t];
      const cur: boolean[] = new Array<boolean>(n + 1).fill(false);
      // inner[j] for globstarDir: some k >= j has s[k] === '/' and next[k + 1].
      let inner = false;
      for (let j = n; j >= 0; j--) {
        const ch = j < n ? s[j] : undefined;
        switch (token?.kind) {
          case 'lit':
            cur[j] = ch === token.ch && next[j + 1] === true;
            break;
          case 'one':
            cur[j] = ch !== undefined && ch !== '/' && next[j + 1] === true;
            break;
          case 'star':
            cur[j] = next[j] === true || (ch !== undefined && ch !== '/' && cur[j + 1] === true);
            break;
          case 'globstar':
            cur[j] = next[j] === true || (ch !== undefined && cur[j + 1] === true);
            break;
          case 'globstarDir':
            if (ch === '/' && next[j + 1] === true) inner = true;
            cur[j] = next[j] === true || inner;
            break;
          case undefined:
            break;
        }
      }
      next = cur;
    }
    return next[0] === true;
  };
}
