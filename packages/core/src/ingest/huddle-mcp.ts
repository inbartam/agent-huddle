/**
 * The per-run pieces a managed launch needs so its agents can report their own progress (F27, spike S19). Pure: no
 * file is written and nothing is spawned here; the launcher (M6 P4) writes the JSON to a temp file and passes
 * `--mcp-config <file>`, adds the allow entry to its per-run `--settings`, and appends the prompt line.
 *
 * Facts (docs/INTEGRATION.md "MCP progress tool, run-checked (S19)"):
 *   - The tool is named `mcp__<server key in --mcp-config>__<tool>`, so the key `huddle` gives
 *     `mcp__huddle__report_progress`; the normalizer matches exactly that name.
 *   - Under the default permission mode the first call raises a PermissionRequest; `permissions.allow` with the tool
 *     name removes it, subagent calls included.
 *   - Server instructions and the tool description alone gave 0-2 main-agent calls on a three-step task; one line in
 *     the prompt gave 3-5. Hence `HUDDLE_PROGRESS_PROMPT_LINE`.
 *   - Windows: `command: "node"` with a forward-slash path, and a backslash path with spaces, both worked.
 */
import path from 'node:path';
import { z } from 'zod';
import type { TemplateAgent } from '@huddle/shared';

/** The server key in the `--mcp-config` file. It becomes the middle part of the tool name. */
export const HUDDLE_MCP_SERVER_KEY = 'huddle';
/** The tool's own name in `scripts/huddle-mcp.mjs` (`TOOL_NAME`). */
export const HUDDLE_PROGRESS_TOOL_SHORT_NAME = 'report_progress';
/** The tool name Claude Code uses in hooks and permission rules. */
export const HUDDLE_PROGRESS_TOOL = `mcp__${HUDDLE_MCP_SERVER_KEY}__${HUDDLE_PROGRESS_TOOL_SHORT_NAME}`;
/** The lead's answer about an idle teammate (M6 P5b, ADR-027): `TEAMMATE_TOOL_NAME` in `scripts/huddle-mcp.mjs`. */
export const HUDDLE_TEAMMATE_TOOL_SHORT_NAME = 'report_teammate';
/** Same naming rule as the progress tool (S19 a): `mcp__<server key>__<tool>`. */
export const HUDDLE_TEAMMATE_TOOL = `mcp__${HUDDLE_MCP_SERVER_KEY}__${HUDDLE_TEAMMATE_TOOL_SHORT_NAME}`;

/**
 * The prompt line a managed run appends (S19 (e): server text alone is not enough). Names the tool by its short name,
 * as the S19 prompt did, and asks for the three moments the server instructions name.
 */
export const HUDDLE_PROGRESS_PROMPT_LINE =
  'Report your progress with the report_progress tool at the start, after each major step and just before you finish ' +
  '(fraction from 0 to 1, minutesLeft, and a short note).';

/** One stdio MCP server entry, in the documented `--mcp-config` shape. */
export interface McpStdioServer {
  type: 'stdio';
  command: string;
  args: string[];
}

export interface HuddleMcpConfig {
  mcpServers: Record<typeof HUDDLE_MCP_SERVER_KEY, McpStdioServer>;
}

export interface HuddleMcpConfigInput {
  /** Absolute path to `scripts/huddle-mcp.mjs` (or the packaged copy). Forward or back slashes both work (S19). */
  serverScript: string;
  /** The Node executable: `node` from PATH (default) or an absolute path to `node.exe`. */
  nodeCommand?: string;
}

const MAX_PATH = 1024;

/** Non-empty, bounded, no control characters, and not something a shell or argv reader would take for a flag. */
function checkedValue(name: string, value: string): string {
  // eslint-disable-next-line no-control-regex
  if (value.length === 0 || value.length > MAX_PATH || value.startsWith('-') || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`invalid ${name}`);
  }
  return value;
}

function isAbsolutePath(value: string): boolean {
  return path.win32.isAbsolute(value) || path.posix.isAbsolute(value);
}

/** The `--mcp-config` object for the huddle server. Pure. Throws on a path that must not reach the config. */
export function huddleMcpConfig(input: HuddleMcpConfigInput): HuddleMcpConfig {
  const script = checkedValue('server script', input.serverScript);
  if (!isAbsolutePath(script)) throw new Error('invalid server script: expected an absolute path');
  if (!/\.m?js$/i.test(script)) throw new Error('invalid server script: expected a .mjs or .js file');
  const command = checkedValue('node command', input.nodeCommand ?? 'node');
  if (command !== 'node' && !isAbsolutePath(command)) {
    throw new Error('invalid node command: expected "node" or an absolute path');
  }
  return { mcpServers: { [HUDDLE_MCP_SERVER_KEY]: { type: 'stdio', command, args: [script] } } };
}

/** `huddleMcpConfig` as the JSON text of the file passed to `--mcp-config`. */
export function huddleMcpConfigJson(input: HuddleMcpConfigInput): string {
  return `${JSON.stringify(huddleMcpConfig(input), null, 2)}\n`;
}

/**
 * The `permissions.allow` entries the per-run `--settings` adds, so reporting never raises an approval: the progress
 * tool and the lead's teammate answer (M6 P5b). Both tools only answer `ok`; neither reads or writes anything.
 */
export function huddleMcpPermissionsAllow(): string[] {
  return [HUDDLE_PROGRESS_TOOL, HUDDLE_TEAMMATE_TOOL];
}

/** The prompt with the progress line appended on its own paragraph (once: a prompt that has it already is kept). */
export function withProgressPromptLine(prompt: string): string {
  if (prompt.includes(HUDDLE_PROGRESS_PROMPT_LINE)) return prompt;
  const trimmed = prompt.replace(/\s+$/, '');
  return trimmed === '' ? HUDDLE_PROGRESS_PROMPT_LINE : `${trimmed}\n\n${HUDDLE_PROGRESS_PROMPT_LINE}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// M6 P4: what the launcher and the attached-session installer need (ADR-025). Pure.
// ---------------------------------------------------------------------------------------------------------------------

/** The server script's file name, in the app (scripts/ in dev, resources when packaged) and in every copy. */
export const HUDDLE_MCP_FILENAME = 'huddle-mcp.mjs';

/**
 * The template's `--agents` with the progress tool added to every agent that has a `tools:` list (S19 c: such an agent
 * gets an MCP tool only when its list names it). An agent without a list has every tool already. Every agent's own
 * prompt also gets the progress line: a subagent works from its own prompt, not the main agent's, and the M6 exit run
 * showed a subagent with the tool but no line never called it (server text alone is not enough, S19 e).
 * Returns new objects; never mutates the argument.
 */
export function withProgressTool(agents: Readonly<Record<string, TemplateAgent>>): Record<string, TemplateAgent> {
  const out: Record<string, TemplateAgent> = {};
  for (const [name, agent] of Object.entries(agents)) {
    const copy: TemplateAgent = { ...agent, prompt: withProgressPromptLine(agent.prompt) };
    if (agent.tools !== undefined) {
      copy.tools = agent.tools.includes(HUDDLE_PROGRESS_TOOL)
        ? [...agent.tools]
        : [...agent.tools, HUDDLE_PROGRESS_TOOL];
    }
    out[name] = copy;
  }
  return out;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The per-run `--settings` text for a managed run with self-report on: `base` (the exit harness's own settings file,
 * parsed; null for the product, which passes no other settings) with `huddleMcpPermissionsAllow()` added to
 * `permissions.allow` once (S19 d: no PermissionRequest for the tool, subagent calls included). Everything else in
 * `base` is kept as it is. The product's file holds only this permission, never hooks (ADR-020 §1, ADR-025).
 * Throws when `base` is given and is not a JSON object.
 */
export function progressRunSettingsJson(base: unknown): string {
  if (base !== null && !isObject(base)) throw new Error('the base settings are not a JSON object');
  const settings: Record<string, unknown> = base === null ? {} : { ...base };
  const permissions: Record<string, unknown> = isObject(settings.permissions) ? { ...settings.permissions } : {};
  const allow = Array.isArray(permissions.allow) ? [...(permissions.allow as unknown[])] : [];
  for (const entry of huddleMcpPermissionsAllow()) if (!allow.includes(entry)) allow.push(entry);
  permissions.allow = allow;
  settings.permissions = permissions;
  return `${JSON.stringify(settings, null, 2)}\n`;
}

// --- attached sessions: `claude mcp add --scope user` (S19 g) -------------------------------------------------------

/**
 * `claude mcp add --scope user huddle -- <node> <script>` as an argv array (never a shell string). Everything after
 * `--` is the server's command line, so a path is never read as a claude flag. Throws on a value that must not reach it.
 */
export function mcpAddArgs(input: HuddleMcpConfigInput): string[] {
  const server = huddleMcpConfig(input).mcpServers[HUDDLE_MCP_SERVER_KEY];
  return ['mcp', 'add', '--scope', 'user', HUDDLE_MCP_SERVER_KEY, '--', server.command, ...server.args];
}

/** `claude mcp remove --scope user huddle`. */
export function mcpRemoveArgs(): string[] {
  return ['mcp', 'remove', '--scope', 'user', HUDDLE_MCP_SERVER_KEY];
}

/** The user-scope part of `.claude.json` the installer reads: only `mcpServers.huddle`, unknown fields kept. */
const claudeJsonSchema = z.looseObject({ mcpServers: z.record(z.string(), z.unknown()).optional() });

/**
 * The user-scope `huddle` server in a parsed `.claude.json` (top-level `mcpServers`, where `claude mcp add --scope user`
 * writes; S19 g), or undefined when there is none. Nothing else of the file is looked at or kept.
 */
export function userScopeHuddleServer(claudeJson: unknown): unknown {
  const parsed = claudeJsonSchema.safeParse(claudeJson);
  if (!parsed.success) return undefined;
  const servers = parsed.data.mcpServers;
  return servers !== undefined && Object.hasOwn(servers, HUDDLE_MCP_SERVER_KEY)
    ? servers[HUDDLE_MCP_SERVER_KEY]
    : undefined;
}

const serverEntrySchema = z.looseObject({
  type: z.literal('stdio').optional(),
  command: z.string(),
  args: z.array(z.string()),
});

/** Same file, Windows-insensitive to case and slash direction. */
function samePathText(a: string, b: string): boolean {
  const norm = (p: string) => path.win32.normalize(p.replace(/\//g, '\\')).toLowerCase();
  return path.win32.isAbsolute(a) || path.win32.isAbsolute(b) ? norm(a) === norm(b) : a === b;
}

/**
 * True when `entry` is the server the Huddle registers: a stdio server whose only argument is `serverScript` (our copy
 * in `<config dir>/agent-huddle/`). Anything else under the name `huddle` is the user's and is never replaced or removed.
 */
export function isHuddleServerEntry(entry: unknown, serverScript: string): boolean {
  const parsed = serverEntrySchema.safeParse(entry);
  if (!parsed.success) return false;
  const [only, ...rest] = parsed.data.args;
  return only !== undefined && rest.length === 0 && samePathText(only, serverScript);
}
