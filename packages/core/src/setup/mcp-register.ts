/**
 * Opt-in registration of the Huddle's self-report MCP server for attached sessions (M6 P4, F27, ADR-025).
 *
 * User-scope MCP servers live in `.claude.json` (`~/.claude.json`, or `<CLAUDE_CONFIG_DIR>/.claude.json` when that
 * variable is set: S19 g). The owner's rule (2026-11-16) puts that file under the same rule as `~/.claude/**`: the
 * Huddle never writes it. Claude Code's own CLI does, after the user saw the exact command and agreed:
 *   register:   copy the server script to `<config dir>/agent-huddle/huddle-mcp.mjs` (next to the hook forwarder), then
 *               `claude mcp add --scope user huddle -- <node> <that copy>`
 *   unregister: `claude mcp remove --scope user huddle`, then remove the copy
 * Both run as argv arrays (`shell: false`), with `claude` and `node` as absolute paths found on PATH (M2).
 *
 * Safety:
 *   - dry by default: `prepare` reads and plans only; `apply` needs `{ consent: true }` and the same plan again
 *     (fingerprint), else `stale` with the new plan;
 *   - a `huddle` server that is not the Huddle's (`isHuddleServerEntry`) is never replaced or removed: refused;
 *   - `.claude.json` is read, never written; only `mcpServers.huddle` is looked at, nothing of it is kept or logged;
 *   - after the command, the file is read again and the result checked; a mismatch is an error.
 * Attached sessions get the tool but not the prompt line managed runs get, so their agents report less (S19 e).
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  SelfReportDiffLine,
  SelfReportRegistrationMode,
  SelfReportRegistrationPreview,
  SelfReportRegistrationState,
} from '@huddle/shared';
import {
  HUDDLE_MCP_FILENAME,
  HUDDLE_MCP_SERVER_KEY,
  huddleMcpConfig,
  isHuddleServerEntry,
  mcpAddArgs,
  mcpRemoveArgs,
  userScopeHuddleServer,
} from '../ingest/huddle-mcp.js';
import { resolveClaudeExecutable, resolveNodeExecutable } from '../runtime/claude-path.js';
import { managedRunEnv } from '../runtime/runs.js';
import { canonicalJson, diffSettings, formatDiff, HUDDLE_DIRNAME, stripBom, toPosixPath } from './install-hooks.js';

export interface ClaudeRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs `command args` without a shell. Tests replace it with the fake claude. */
export type ClaudeRunner = (
  command: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; cwd: string; timeoutMs: number },
) => Promise<ClaudeRunResult>;

/** How long one `claude mcp` command may take. */
export const MCP_COMMAND_TIMEOUT_MS = 30_000;
const OUTPUT_MAX = 64 * 1024;
const ERROR_TEXT_MAX = 300;
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export const defaultClaudeRunner: ClaudeRunner = (command, args, options) =>
  new Promise((resolve) => {
    execFile(
      command,
      [...args],
      {
        env: options.env,
        cwd: options.cwd,
        timeout: options.timeoutMs,
        windowsHide: true,
        shell: false,
        maxBuffer: OUTPUT_MAX,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : null;
        resolve({ code, stdout, stderr });
      },
    );
  });

export interface McpRegistrarDeps {
  /** Claude Code's config folder (CLAUDE_CONFIG_DIR or ~/.claude), as the hook installer gets it. */
  configDir: string;
  /** The user's home folder (`os.homedir()`); `.claude.json` sits there when CLAUDE_CONFIG_DIR is not set. */
  homeDir: string;
  /** The env `claude` runs with (default `process.env`, minus the nested-session variables). */
  env?: NodeJS.ProcessEnv;
  /** The server script shipped with the app (scripts/huddle-mcp.mjs in dev). */
  serverSource: string;
  /** Tests: the runner (default: execFile, no shell). */
  runClaude?: ClaudeRunner;
  /** Tests: the claude and node paths (default: found on the env's PATH). */
  claudeCommand?: string;
  nodeCommand?: string;
}

export interface McpRegistrationPlan {
  preview: SelfReportRegistrationPreview;
  /** The argv after the claude path, or null when nothing runs. */
  args: string[] | null;
  claudeCommand: string | null;
  childEnv: NodeJS.ProcessEnv;
}

export type McpApplyResult =
  | { status: 'written'; preview: SelfReportRegistrationPreview }
  | { status: 'unchanged'; preview: SelfReportRegistrationPreview }
  | { status: 'needs-consent' }
  | { status: 'stale'; preview: SelfReportRegistrationPreview }
  | { status: 'refused'; preview: SelfReportRegistrationPreview }
  | { status: 'error'; error: string };

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  for (const [key, value] of Object.entries(env)) if (key.toUpperCase() === name) return value;
  return undefined;
}

function withoutVar(env: NodeJS.ProcessEnv, name: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) if (key.toUpperCase() !== name) out[key] = value;
  return out;
}

function samePath(a: string, b: string): boolean {
  const ra = path.resolve(a);
  const rb = path.resolve(b);
  return process.platform === 'win32' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

/**
 * Pure: which `.claude.json` a `claude` child with `env` reads and writes, and the env to give it so that it is the
 * one under `configDir`. CLAUDE_CONFIG_DIR set (to `configDir`): `<configDir>/.claude.json`. Not set and `configDir` is
 * `~/.claude`: `~/.claude.json` (setting the variable to `~/.claude` would move the file to `~/.claude/.claude.json`, a
 * different file). Any other `configDir` (tests): the variable is set to it for the child.
 */
export function claudeJsonLocation(
  configDir: string,
  homeDir: string,
  env: NodeJS.ProcessEnv,
): { file: string; childEnv: NodeJS.ProcessEnv } {
  const configured = envValue(env, 'CLAUDE_CONFIG_DIR')?.trim() ?? '';
  if (configured !== '' && samePath(configured, configDir)) {
    return { file: path.join(path.resolve(configDir), '.claude.json'), childEnv: env };
  }
  if (configured === '' && samePath(configDir, path.join(homeDir, '.claude'))) {
    return { file: path.join(path.resolve(homeDir), '.claude.json'), childEnv: withoutVar(env, 'CLAUDE_CONFIG_DIR') };
  }
  return {
    file: path.join(path.resolve(configDir), '.claude.json'),
    childEnv: { ...withoutVar(env, 'CLAUDE_CONFIG_DIR'), CLAUDE_CONFIG_DIR: path.resolve(configDir) },
  };
}

/** A command line as the user would type it in PowerShell or a terminal (display only; it is never run as text). */
export function displayCommand(command: string, args: readonly string[]): string {
  const quote = (s: string) => (/[\s"'`$&|;<>()]/.test(s) || s === '' ? `"${s.replace(/"/g, '\\"')}"` : s);
  return [command, ...args].map(quote).join(' ');
}

function clipText(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > ERROR_TEXT_MAX ? `${flat.slice(0, ERROR_TEXT_MAX)}…` : flat;
}

async function readClaudeJson(file: string): Promise<{ state: 'missing' | 'ok' | 'unreadable'; value: unknown }> {
  let text: string;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : '';
    if (code === 'ENOENT') return { state: 'missing', value: undefined };
    return { state: 'unreadable', value: undefined };
  }
  const body = stripBom(text);
  if (body.trim() === '') return { state: 'ok', value: {} };
  try {
    return { state: 'ok', value: JSON.parse(body) as unknown };
  } catch {
    return { state: 'unreadable', value: undefined };
  }
}

export class McpRegistrar {
  readonly huddleDir: string;
  readonly serverTarget: string;
  readonly claudeJsonPath: string;
  private readonly childEnv: NodeJS.ProcessEnv;
  private readonly deps: McpRegistrarDeps;
  private readonly run: ClaudeRunner;

  constructor(deps: McpRegistrarDeps) {
    this.deps = deps;
    this.run = deps.runClaude ?? defaultClaudeRunner;
    this.huddleDir = path.join(path.resolve(deps.configDir), HUDDLE_DIRNAME);
    this.serverTarget = path.join(this.huddleDir, HUDDLE_MCP_FILENAME);
    const where = claudeJsonLocation(deps.configDir, deps.homeDir, managedRunEnv(deps.env ?? process.env));
    this.claudeJsonPath = where.file;
    this.childEnv = where.childEnv;
  }

  /** The script path as it goes into the command and `.claude.json` (forward slashes, as S19 g ran it). */
  private scriptArg(): string {
    return toPosixPath(this.serverTarget);
  }

  /** Reads `.claude.json` and PATH and plans `mode`. Writes nothing, runs nothing. Never throws. */
  async prepare(mode: SelfReportRegistrationMode): Promise<McpRegistrationPlan> {
    const read = await readClaudeJson(this.claudeJsonPath);
    const entry = read.state === 'ok' ? userScopeHuddleServer(read.value) : undefined;
    const script = this.scriptArg();
    const state: SelfReportRegistrationState =
      read.state === 'unreadable'
        ? 'unreadable'
        : entry === undefined
          ? 'absent'
          : isHuddleServerEntry(entry, script)
            ? 'ours'
            : 'foreign';

    const claude =
      this.deps.claudeCommand !== undefined
        ? { ok: true as const, path: this.deps.claudeCommand }
        : await resolveClaudeExecutable({ env: this.childEnv });
    const node =
      mode === 'register' ? (this.deps.nodeCommand ?? (await resolveNodeExecutable({ env: this.childEnv }))) : null;
    const sourceThere =
      mode === 'register'
        ? await fsp.stat(this.deps.serverSource).then(
            (s) => s.isFile(),
            () => false,
          )
        : true;

    let refusal: string | null = null;
    if (state === 'unreadable') {
      refusal = `${this.claudeJsonPath} is not valid JSON, so the Huddle cannot check what is registered there. Fix the file first.`;
    } else if (state === 'foreign') {
      refusal =
        mode === 'register'
          ? 'An MCP server named "huddle" that is not Agent Huddle\'s is already registered for your user. The Huddle will not replace it; remove or rename it first (claude mcp remove --scope user huddle).'
          : 'The MCP server named "huddle" for your user is not Agent Huddle\'s, so the Huddle will not remove it.';
    } else if (!claude.ok) {
      refusal = `Claude Code could not be found (${claude.message}), so the registration cannot run.`;
    } else if (mode === 'register' && node === null) {
      refusal = 'node was not found on PATH, and the self-report server needs it.';
    } else if (!sourceThere) {
      refusal = 'The self-report server script is missing from this build of Agent Huddle.';
    }

    const changed = refusal === null && (mode === 'register' ? state === 'absent' : state === 'ours');
    let args: string[] | null = null;
    let after: unknown = entry;
    if (changed && mode === 'register' && node !== null) {
      args = mcpAddArgs({ serverScript: script, nodeCommand: node });
      after = huddleMcpConfig({ serverScript: script, nodeCommand: node }).mcpServers[HUDDLE_MCP_SERVER_KEY];
    } else if (changed && mode === 'unregister') {
      args = mcpRemoveArgs();
      after = undefined;
    }
    const claudePath = claude.ok ? claude.path : null;
    const shown = (e: unknown) => (e === undefined ? {} : { mcpServers: { [HUDDLE_MCP_SERVER_KEY]: e } });
    const diff: SelfReportDiffLine[] =
      state === 'foreign' || state === 'unreadable' ? [] : diffSettings(shown(entry), shown(after));
    const commands = args !== null && claudePath !== null ? [displayCommand(claudePath, args)] : [];

    const notes: string[] = [];
    if (changed && mode === 'register') {
      notes.push(`copy the self-report server to ${this.serverTarget}`);
      notes.push(`run the command above; Claude Code adds the "huddle" server to ${this.claudeJsonPath}`);
      notes.push(
        "every Claude Code session for your user then has the report_progress and report_teammate tools (progress, and a lead's answer about an idle teammate); the Huddle reads their calls from the hooks it already has",
      );
      notes.push(
        'attached sessions do not get the prompt line that asks for reports, so their agents report less often than runs the Huddle launches',
      );
      notes.push(
        'the first call of each tool in a session may ask for permission (mcp__huddle__report_progress, mcp__huddle__report_teammate), in the terminal or in the Huddle inbox',
      );
      notes.push(
        'Settings, Remove (or withdrawing consent, "Agent Huddle.exe" --remove-hooks, or install-hooks --uninstall) runs claude mcp remove again',
      );
    } else if (changed) {
      notes.push(`run the command above; Claude Code removes the "huddle" server from ${this.claudeJsonPath}`);
      notes.push(`remove ${this.serverTarget}`);
    } else if (refusal === null) {
      notes.push(mode === 'register' ? 'already registered: nothing to do' : 'not registered: nothing to do');
    }

    const fingerprint = createHash('sha256')
      .update(canonicalJson({ mode, state, file: this.claudeJsonPath, entry: entry ?? null, args, claudePath }))
      .digest('hex');
    return {
      preview: {
        mode,
        state,
        claudeJsonPath: this.claudeJsonPath,
        serverScriptPath: this.serverTarget,
        commands,
        diff,
        diffText: formatDiff(diff),
        notes,
        refusal,
        changed,
        fingerprint,
      },
      args,
      claudeCommand: claudePath,
      childEnv: this.childEnv,
    };
  }

  /** Is the Huddle's server registered now? Read-only. */
  async isRegistered(): Promise<boolean> {
    const read = await readClaudeJson(this.claudeJsonPath);
    return read.state === 'ok' && isHuddleServerEntry(userScopeHuddleServer(read.value), this.scriptArg());
  }

  /**
   * Runs the change `preview` showed. Only `{ consent: true }` counts. The plan is made again first: a different
   * fingerprint answers `stale` with the new preview, and nothing runs.
   */
  async apply(preview: Pick<SelfReportRegistrationPreview, 'mode' | 'fingerprint'>, consent: { consent: unknown }) {
    if (consent.consent !== true) return { status: 'needs-consent' } satisfies McpApplyResult;
    return this.applyPlan(await this.prepare(preview.mode), preview.fingerprint);
  }

  private async applyPlan(plan: McpRegistrationPlan, fingerprint: string): Promise<McpApplyResult> {
    const { preview } = plan;
    if (preview.fingerprint !== fingerprint) return { status: 'stale', preview };
    if (preview.refusal !== null) return { status: 'refused', preview };
    if (!preview.changed || plan.args === null || plan.claudeCommand === null) return { status: 'unchanged', preview };
    try {
      if (preview.mode === 'register') {
        await fsp.mkdir(this.huddleDir, { recursive: true, mode: PRIVATE_DIR_MODE });
        const source = await fsp.readFile(this.deps.serverSource);
        const tmp = `${this.serverTarget}.huddle-tmp-${String(process.pid)}`;
        await fsp.writeFile(tmp, source, { mode: PRIVATE_FILE_MODE });
        await fsp.rename(tmp, this.serverTarget).catch(async (error: unknown) => {
          await fsp.rm(tmp, { force: true });
          throw error;
        });
      }
      const result = await this.run(plan.claudeCommand, plan.args, {
        env: plan.childEnv,
        cwd: os.tmpdir(),
        timeoutMs: MCP_COMMAND_TIMEOUT_MS,
      });
      const registered = await this.isRegistered();
      if (preview.mode === 'register') {
        if (result.code !== 0 || !registered) {
          // The copy is ours and nothing names it: leave no file behind.
          if (!registered) await fsp.rm(this.serverTarget, { force: true });
          return { status: 'error', error: this.failure('claude mcp add', result) };
        }
      } else {
        if (result.code !== 0 || registered)
          return { status: 'error', error: this.failure('claude mcp remove', result) };
        await fsp.rm(this.serverTarget, { force: true });
      }
      return { status: 'written', preview };
    } catch (error) {
      return { status: 'error', error: error instanceof Error ? error.message : String(error) };
    }
  }

  private failure(what: string, result: ClaudeRunResult): string {
    const text = clipText(result.stderr !== '' ? result.stderr : result.stdout);
    const code = result.code === null ? 'did not finish' : `exited with ${String(result.code)}`;
    return `${what} ${code}${text !== '' ? `: ${text}` : ''}. ${this.claudeJsonPath} was checked again and is not as expected.`;
  }

  /** Removal on an uninstall path (withdraw consent): runs only when the Huddle's own server is registered. */
  async removeIfOurs(): Promise<McpApplyResult> {
    const plan = await this.prepare('unregister');
    if (plan.preview.state !== 'ours') return { status: 'unchanged', preview: plan.preview };
    return this.applyPlan(plan, plan.preview.fingerprint);
  }
}
