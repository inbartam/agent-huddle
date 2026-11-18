/**
 * Ask the Huddle (M5, F25): runs one read-only `claude -p` and reads its answer. Side effects live here (spawn, temp
 * folder, timer); what to send is report/ask-context.ts, the argv and the result shape are ingest/ask-cli.ts.
 *
 *  - claude is found the way managed runs find it (claude-path.ts, security review M2): an absolute `.com`/`.exe`
 *    from absolute PATH entries of the env the child gets, once, and kept; never a bare name, never a `.cmd` shim.
 *  - Spawned with an args array and `shell: false`, so `--tools ""` is one empty argv element (S18 a).
 *  - cwd is a fresh empty folder under the OS temp folder, removed afterwards, never a project folder (a parent
 *    CLAUDE.md would load; S18 ran the same way).
 *  - env: the managed-run env (`managedRunEnv`: the nested Claude Code session markers removed) with the telemetry-off
 *    variables of ASK_TELEMETRY_OFF_ENV on top (the same four as the inline `--settings` env; unproven beyond the
 *    endpoint until S18 h). When it holds ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN the ask is refused
 *    (`api_key_set`) rather than the variable silently dropped, so the user knows `claude -p` would bill that
 *    credential (S18 b: `apiKeySource` "none" only without them). When it names another provider
 *    (ANTHROPIC_BASE_URL, CLAUDE_CODE_USE_BEDROCK/VERTEX/FOUNDRY set and not "0") it is refused (`other_provider`).
 *  - Claude Code's user settings.json (M5 security review L1): claude applies its `env` block on top of the process
 *    env, so the same names there refuse too, and so does an `apiKeyHelper`. Only key names are read
 *    (`readClaudeSettingsKeys`, the installer's reader), read-only, again before every ask; values are never read
 *    into the result or logged. Known gap: managed (enterprise) settings are not read.
 *  - stdin: the context text, then closed. stdout is capped (STDOUT_MAX_BYTES); the answer is clipped to
 *    CLIP_LIMITS.result.
 *  - One at a time (`busy`); a timeout (ASK_TIMEOUT_MS) or `cancel()` ends the process tree.
 *  - Never stores or logs the question, the context or the answer: the log line has the outcome kind, the wall time
 *    and the token counts only.
 */
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ASK_TIMEOUT_MS, CLIP_LIMITS, type AskErrorKind } from '@huddle/shared';
import { ASK_TELEMETRY_OFF_ENV, buildAskArgs, looksNotLoggedIn, parseAskResult } from '../ingest/ask-cli.js';
import { killProcessTree, type KillFn, type SpawnFn } from '../ingest/stream-driver.js';
import { clip } from '../text.js';
import { cleanText } from '../report/ask-context.js';
import { resolveClaudeExecutable } from './claude-path.js';
import type { HuddleLogger } from './huddle-core.js';
import { managedRunEnv } from './runs.js';

/** Most stdout bytes read; a json result is a few KB. More is a broken run: it is ended and reported as an error. */
export const ASK_STDOUT_MAX_BYTES = 1024 * 1024;
/** After a kill, how long to wait for the process to close before giving up on it. */
const CLOSE_AFTER_KILL_MS = 5000;
const STDERR_TAIL = 4096;

/** DESIGN "Words for remembering (M5)", Ask errors. */
export const ASK_WORDS = {
  disabled: 'Ask the Huddle is off. Turn it on in Settings.',
  switchedOff: 'Stopped: Ask the Huddle was turned off.',
  apiKeySet:
    "ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN is set in Huddle's environment, so claude -p would use it instead of your Claude Code login. Remove it, restart Huddle, then ask again.",
  otherProvider:
    "ANTHROPIC_BASE_URL or a Bedrock, Vertex or Foundry switch is set in Huddle's environment, so the summary would not go to Anthropic. Huddle won't send it. Remove it, restart Huddle, then ask again.",
  claudeNotFound: "Huddle couldn't find the `claude` command. Install Claude Code, or add it to PATH, then ask again.",
  notLoggedIn: "Claude Code isn't logged in. Run `claude` in a terminal, log in, then ask again.",
  timeout: (seconds: number) => `No answer within ${String(seconds)} seconds. Ask again, or ask something shorter.`,
  modelError: (message: string) => `Claude Code couldn't answer: ${message}.`,
  cancelled: 'Stopped.',
  busy: 'An ask is already running. Wait for its answer or cancel it.',
} as const;

export interface AskRunnerOptions {
  now: () => number;
  logger: HuddleLogger;
  /** The env the child's env is made from (default `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Tests only: the executable, spawned as given (the fake claude). Default: claude resolved on the env's PATH. */
  claudeCommand?: string;
  spawn?: SpawnFn;
  kill?: KillFn;
  /** Default ASK_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Where the per-ask folder is made (default `os.tmpdir()`). */
  tempRoot?: string;
  /** Default ASK_STDOUT_MAX_BYTES. */
  stdoutMaxBytes?: number;
  /**
   * Reads the key names of Claude Code's user settings.json (L1). Null: unknown (unreadable or not JSON), then only the
   * env is checked. Absent: settings.json is not checked (tests).
   */
  readClaudeSettingsKeys?: () => Promise<ClaudeSettingsKeys | null>;
}

export interface AskRunAnswer {
  ok: true;
  /** Clipped to CLIP_LIMITS.result; plain text. */
  text: string;
  model: string | null;
  apiMs: number | null;
  costUsd: number | null;
  tokens: { input: number; output: number } | null;
  wallMs: number;
  sessionId: string | null;
}

export interface AskRunFailure {
  ok: false;
  error: AskErrorKind;
  /** In the UI's words. */
  message: string;
  wallMs: number;
  sessionId: string | null;
}

export type AskRunResult = AskRunAnswer | AskRunFailure;

export interface AskRunHooks {
  /** The ask's folder exists and the process is about to start (the core's ask guard watches for it). */
  onFolder?: (folder: string) => void;
}

/** Variables that move `claude -p` off the subscription login onto a billed credential. */
export const ASK_REFUSED_ENV_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] as const;
const REFUSED: ReadonlySet<string> = new Set(ASK_REFUSED_ENV_VARS);

/**
 * Variables that send `claude -p` somewhere other than Anthropic's API (M5 security review L1): another endpoint, or
 * Amazon Bedrock, Google Vertex AI or Microsoft Foundry. The summary would then leave for a provider the consent text
 * does not name.
 */
export const ASK_OTHER_PROVIDER_ENV_VARS = [
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
] as const;
const OTHER_PROVIDER: ReadonlySet<string> = new Set(ASK_OTHER_PROVIDER_ENV_VARS);

/**
 * True when the env holds a non-empty ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN (any case of the name: Windows env
 * names are). Claude Code's own settings.json is checked separately (`ClaudeSettingsKeys`).
 */
export function hasApiKey(env: NodeJS.ProcessEnv): boolean {
  for (const [name, value] of Object.entries(env)) {
    if (REFUSED.has(name.toUpperCase()) && value !== undefined && value.trim().length > 0) return true;
  }
  return false;
}

/** True when the env names another provider: one of ASK_OTHER_PROVIDER_ENV_VARS set, non-empty and not "0". */
export function usesOtherProvider(env: NodeJS.ProcessEnv): boolean {
  for (const [name, value] of Object.entries(env)) {
    if (!OTHER_PROVIDER.has(name.toUpperCase()) || value === undefined) continue;
    const v = value.trim();
    if (v.length > 0 && v !== '0') return true;
  }
  return false;
}

/**
 * What the ask needs from Claude Code's user settings.json (`HookInstaller.readAskRelevantKeys`): the key names of its
 * `env` block and whether `apiKeyHelper` is set. Never a value: the env block can hold a key or a token.
 */
export interface ClaudeSettingsKeys {
  envKeys: readonly string[];
  apiKeyHelper: boolean;
}

/** Why an ask is refused before it starts, and where the cause was found. */
export interface AskRefusal {
  kind: 'api_key_set' | 'other_provider';
  where: 'environment' | 'claude_settings';
}

/**
 * Pure. The refusal for this child env and these settings keys, or null. A billed credential is named first. In
 * settings.json only key names are known, so a key that is present counts (even with an empty value or "0"):
 * conservative, the user can remove it.
 */
export function askRefusal(env: NodeJS.ProcessEnv, settings: ClaudeSettingsKeys | null): AskRefusal | null {
  const keys = new Set((settings?.envKeys ?? []).map((k) => k.toUpperCase()));
  const inSettings = (names: ReadonlySet<string>): boolean => [...names].some((n) => keys.has(n));
  if (hasApiKey(env)) return { kind: 'api_key_set', where: 'environment' };
  if (settings?.apiKeyHelper === true || inSettings(REFUSED)) return { kind: 'api_key_set', where: 'claude_settings' };
  if (usesOtherProvider(env)) return { kind: 'other_provider', where: 'environment' };
  if (inSettings(OTHER_PROVIDER)) return { kind: 'other_provider', where: 'claude_settings' };
  return null;
}

/** The words for a refusal (DESIGN "Words for remembering (M5)", Ask errors). */
export function refusalWords(refusal: AskRefusal): string {
  if (refusal.kind === 'api_key_set') {
    return refusal.where === 'environment'
      ? ASK_WORDS.apiKeySet
      : "Claude Code's settings.json sets ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or apiKeyHelper, so claude -p would use it instead of your Claude Code login. Remove it from settings.json, then ask again.";
  }
  return refusal.where === 'environment'
    ? ASK_WORDS.otherProvider
    : "Claude Code's settings.json sends requests to another provider (ANTHROPIC_BASE_URL, Bedrock, Vertex or Foundry), so the summary would not go to Anthropic. Huddle won't send it. Remove the setting, then ask again.";
}

/** `base` with ASK_TELEMETRY_OFF_ENV on top; a same-named variable in any case is replaced. Pure. */
export function withTelemetryOff(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const names = new Set(Object.keys(ASK_TELEMETRY_OFF_ENV));
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) if (!names.has(name.toUpperCase())) env[name] = value;
  return { ...env, ...ASK_TELEMETRY_OFF_ENV };
}

type StopReason = 'timeout' | 'cancelled' | 'disabled' | 'overflow';

interface Current {
  stop: (reason: Exclude<StopReason, 'timeout' | 'overflow'>) => void;
}

export class AskRunner {
  private readonly options: AskRunnerOptions;
  private resolvedClaude: string | null = null;
  private current: Current | null = null;
  /** The last read of settings.json's key names (`refreshClaudeSettings`); null until read or when unknown. */
  private settingsKeys: ClaudeSettingsKeys | null = null;

  constructor(options: AskRunnerOptions) {
    this.options = options;
  }

  /**
   * Reads settings.json's key names again (read-only, never a value). True when the refusal changed. Never rejects:
   * a failed read keeps nothing (unknown), and the log line carries no file content.
   */
  async refreshClaudeSettings(): Promise<boolean> {
    const read = this.options.readClaudeSettingsKeys;
    if (read === undefined) return false;
    const before = JSON.stringify(this.refusal());
    try {
      this.settingsKeys = await read();
    } catch (error) {
      this.settingsKeys = null;
      this.options.logger.warn('could not read Claude Code settings for ask', {
        error: error instanceof Error ? error.name : 'unknown',
      });
    }
    return JSON.stringify(this.refusal()) !== before;
  }

  /** Why an ask would be refused now (env and the last settings read), or null. */
  refusal(): AskRefusal | null {
    return askRefusal(this.childEnv(), this.settingsKeys);
  }

  /** The summary would go to another provider (ANTHROPIC_BASE_URL, Bedrock, Vertex, Foundry), so an ask is refused. */
  otherProvider(): boolean {
    return this.refusal()?.kind === 'other_provider';
  }

  get busy(): boolean {
    return this.current !== null;
  }

  /** The env the child would get now: the managed-run env with telemetry off. */
  childEnv(): NodeJS.ProcessEnv {
    return withTelemetryOff(managedRunEnv(this.options.env ?? process.env));
  }

  /**
   * ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN is in the env claude would get (the process env, or the `env` block of
   * Claude Code's settings.json, which claude applies on top), or settings.json has an `apiKeyHelper`: an ask is refused.
   */
  apiKeySet(): boolean {
    return this.refusal()?.kind === 'api_key_set';
  }

  /** Stops the ask in flight. False when none runs. */
  cancel(reason: 'cancelled' | 'disabled' = 'cancelled'): boolean {
    const current = this.current;
    if (current === null) return false;
    current.stop(reason);
    return true;
  }

  /** Runs one ask with `stdin` as its input. Never rejects. */
  async run(stdin: string, hooks: AskRunHooks = {}): Promise<AskRunResult> {
    const started = this.options.now();
    const wall = (): number => Math.max(0, this.options.now() - started);
    if (this.current !== null) return { ok: false, error: 'busy', message: ASK_WORDS.busy, wallMs: 0, sessionId: null };

    // Claimed synchronously, before the first await, so a second ask at once is `busy`.
    let stopped: StopReason | null = null;
    let onStop: ((reason: StopReason) => void) | null = null;
    const current: Current = {
      stop: (reason) => {
        stopped ??= reason;
        onStop?.(reason);
      },
    };
    this.current = current;
    const made: { folder: string | null } = { folder: null };
    let result: AskRunResult;
    try {
      result = await this.runInner(stdin, hooks, wall, {
        stopped: () => stopped,
        onStop: (fn) => {
          onStop = fn;
        },
        setFolder: (dir) => {
          made.folder = dir;
        },
      });
    } catch (error) {
      this.options.logger.error('ask failed', { error: error instanceof Error ? error.name : 'unknown' });
      result = {
        ok: false,
        error: 'model_error',
        message: ASK_WORDS.modelError('the run failed'),
        wallMs: wall(),
        sessionId: null,
      };
    } finally {
      this.current = null;
      if (made.folder !== null) await this.removeFolder(made.folder);
    }
    this.options.logger.info('ask finished', {
      outcome: result.ok ? 'answer' : result.error,
      wallMs: result.wallMs,
      inputTokens: result.ok ? (result.tokens?.input ?? null) : null,
      outputTokens: result.ok ? (result.tokens?.output ?? null) : null,
    });
    return result;
  }

  private async runInner(
    stdin: string,
    hooks: AskRunHooks,
    wall: () => number,
    ctl: {
      stopped: () => StopReason | null;
      onStop: (fn: (reason: StopReason) => void) => void;
      setFolder: (dir: string) => void;
    },
  ): Promise<AskRunResult> {
    const fail = (error: AskErrorKind, message: string, sessionId: string | null = null): AskRunFailure => ({
      ok: false,
      error,
      message,
      wallMs: wall(),
      sessionId,
    });
    const stoppedEarly = (): AskRunFailure | null => {
      const s = ctl.stopped();
      if (s === 'cancelled') return fail('cancelled', ASK_WORDS.cancelled);
      if (s === 'disabled') return fail('disabled', ASK_WORDS.switchedOff);
      return null;
    };

    const env = this.childEnv();
    await this.refreshClaudeSettings();
    const refusal = askRefusal(env, this.settingsKeys);
    if (refusal !== null) return fail(refusal.kind, refusalWords(refusal));
    const command = await this.claudeCommand(env);
    if (command === null) return fail('claude_not_found', ASK_WORDS.claudeNotFound);
    const early = stoppedEarly();
    if (early !== null) return early;

    // The canonical path (8.3 short names like RUNNER~1 expanded, junctions resolved), so the guard and Claude Code's
    // hooks see one spelling of the ask's folder.
    const folder = await fsp.realpath(
      await fsp.mkdtemp(path.join(this.options.tempRoot ?? os.tmpdir(), 'huddle-ask-')),
    );
    ctl.setFolder(folder);
    const early2 = stoppedEarly();
    if (early2 !== null) return early2;
    hooks.onFolder?.(folder);

    const spawnFn = this.options.spawn ?? nodeSpawn;
    const kill = this.options.kill ?? killProcessTree;
    const timeoutMs = Math.max(1, this.options.timeoutMs ?? ASK_TIMEOUT_MS);
    const stdoutMax = Math.max(1, this.options.stdoutMaxBytes ?? ASK_STDOUT_MAX_BYTES);

    let child: ChildProcess;
    try {
      child = spawnFn(command, buildAskArgs(), {
        cwd: folder,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
    } catch (error) {
      return this.spawnError(error, fail);
    }

    return new Promise<AskRunResult>((resolve) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      let stderr = '';
      let spawned = false;
      let settled = false;
      let reason: StopReason | null = null;
      let afterKill: NodeJS.Timeout | null = null;

      const settle = (value: AskRunResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (afterKill !== null) clearTimeout(afterKill);
        resolve(value);
      };
      const stopFor = (why: StopReason): AskRunFailure => {
        if (why === 'timeout') return fail('timeout', ASK_WORDS.timeout(Math.round(timeoutMs / 1000)));
        if (why === 'cancelled') return fail('cancelled', ASK_WORDS.cancelled);
        if (why === 'disabled') return fail('disabled', ASK_WORDS.switchedOff);
        return fail('model_error', ASK_WORDS.modelError('its output was too long'));
      };
      const end = (why: StopReason): void => {
        if (reason !== null || settled) return;
        reason = why;
        const pid = child.pid;
        if (pid !== undefined) {
          try {
            kill(pid);
          } catch {
            // Already gone; 'close' follows.
          }
        }
        // If the process never closes (a kill that failed), answer anyway.
        afterKill = setTimeout(() => {
          settle(stopFor(why));
        }, CLOSE_AFTER_KILL_MS);
        afterKill.unref();
        if (!spawned) settle(stopFor(why));
      };

      const timer = setTimeout(() => {
        end('timeout');
      }, timeoutMs);
      timer.unref();
      ctl.onStop((why) => {
        end(why);
      });
      // A stop asked for between the checks above and here.
      const already = ctl.stopped();
      if (already !== null) end(already);

      child.once('spawn', () => {
        spawned = true;
        const input = child.stdin;
        if (input !== null) {
          input.on('error', () => undefined); // EPIPE when claude exits before reading everything
          input.end(stdin, 'utf8');
        }
      });
      child.on('error', (error) => {
        if (!spawned) settle(this.spawnError(error, fail));
        // After 'spawn': a kill or pipe error; 'close' still reports the end.
      });
      child.stdout?.on('data', (chunk: Buffer) => {
        if (reason !== null) return;
        bytes += chunk.length;
        if (bytes > stdoutMax) {
          end('overflow');
          return;
        }
        chunks.push(chunk);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_TAIL);
      });
      child.once('close', (code) => {
        if (reason !== null) {
          settle(stopFor(reason));
          return;
        }
        const facts = parseAskResult(Buffer.concat(chunks).toString('utf8'));
        if (facts?.success === true) {
          settle({
            ok: true,
            text: clip(facts.text.trim(), CLIP_LIMITS.result),
            model: facts.model === null ? null : clip(facts.model, CLIP_LIMITS.id),
            apiMs: facts.apiMs,
            costUsd: facts.costUsd,
            tokens: facts.tokens,
            wallMs: wall(),
            sessionId: facts.sessionId,
          });
          return;
        }
        const text = facts?.text ?? '';
        if (looksNotLoggedIn(text, facts?.apiErrorStatus ?? null) || (facts === null && looksNotLoggedIn(stderr))) {
          settle(fail('not_logged_in', ASK_WORDS.notLoggedIn, facts?.sessionId ?? null));
          return;
        }
        const why =
          text.trim().length > 0
            ? cleanText(text, [], CLIP_LIMITS.error)
            : facts !== null
              ? `the run ended with ${facts.subtype ?? 'an error'}`
              : code === 0
                ? 'no result came back'
                : `claude exited with code ${String(code)}`;
        settle(fail('model_error', ASK_WORDS.modelError(why), facts?.sessionId ?? null));
      });
    });
  }

  private spawnError(error: unknown, fail: (e: AskErrorKind, m: string) => AskRunFailure): AskRunFailure {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
    if (code === 'ENOENT' || code === 'EACCES') {
      // Maybe uninstalled since it was found: look again next time.
      this.resolvedClaude = null;
      return fail('claude_not_found', ASK_WORDS.claudeNotFound);
    }
    return fail('model_error', ASK_WORDS.modelError('claude could not be started'));
  }

  /** The claude to spawn, or null when none is found (a `.cmd` shim alone counts as not found: shell:false can't run it). */
  private async claudeCommand(env: NodeJS.ProcessEnv): Promise<string | null> {
    if (this.options.claudeCommand !== undefined) return this.options.claudeCommand;
    if (this.resolvedClaude !== null) return this.resolvedClaude;
    const found = await resolveClaudeExecutable({ env });
    if (!found.ok) {
      this.options.logger.warn('claude not found for ask', { reason: found.reason });
      return null;
    }
    this.resolvedClaude = found.path;
    return found.path;
  }

  private async removeFolder(folder: string): Promise<void> {
    try {
      await fsp.rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
      this.options.logger.warn('could not remove the ask folder', {
        error: error instanceof Error ? error.message : 'unknown',
      });
    }
  }
}
