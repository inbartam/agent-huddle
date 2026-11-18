/**
 * StreamDriver (M4 WP3, ADR-020 §1 and §5): spawns one managed `claude -p` stream-json run and drives it.
 *
 * Facts it relies on (S8 and S16, run-checked on Claude Code 2.1.325):
 *  - argv `-p --input-format stream-json --output-format stream-json --verbose --session-id <uuid> [--model m]
 *    [--permission-mode m] [--agents <file.json>] [--agent name] [--settings <file>] [--mcp-config <file>]`, spawned with an args array, `shell: false`. The prompt
 *    goes on stdin as a stream-json user message, never on the command line.
 *  - stdin is read only after a turn's `result`; each turn starts with a new `system/init`. So the driver writes one
 *    user message per turn and queues the rest until the next `result`.
 *  - Interrupt: a `control_request` `{subtype:'interrupt'}` (plus `cancel_queued: true` only when init lists
 *    `interrupt_cancel_queued_v1`) answers with a `control_response` and ends the turn (`result` error_during_execution);
 *    the process stays alive.
 *  - End: closing stdin lets the current turn finish, then the process exits 0 and SessionEnd fires.
 *  - Hard stop: `taskkill /PID <pid> /T /F` (Windows) gives no SessionEnd and no `result`, exit code 1. The hooks will
 *    not end the session, so the caller must turn this driver's exit report into `run.exited`.
 *
 * This is an I/O edge: spawn and kill are injectable, ids and the clock are passed in. It emits normalized
 * HuddleEvents (`run.result`, `limits.measured`) and reports init facts, deliveries, idle turn ends and the exit; it appends nothing
 * itself. stderr is kept only as a clipped ring buffer (last STDERR_TAIL_CHARS) for the exit error text.
 */
import { spawn as nodeSpawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import { join, win32 } from 'node:path';
import { CLIP_LIMITS, PERMISSION_MODES, type HuddleEvent, type TemplateAgent } from '@huddle/shared';
import { normalizeStreamLine } from '../normalize/stream.js';
import { LineSplitter, type SplitLine } from './line-splitter.js';
import { oversizedLineIsResult, type StreamMessage } from './stream-schema.js';

/** stderr characters kept for the exit error text. */
export const STDERR_TAIL_CHARS = 4096;
/** How long `stop()` waits by default before it ends the process hard. */
export const DEFAULT_STOP_GRACE_MS = 3000;
/** How long an interrupt waits for its `control_response`. */
export const DEFAULT_CONTROL_TIMEOUT_MS = 5000;
/** After a hard kill, how long to wait for the exit before reporting it anyway. */
export const KILL_WAIT_MS = 5000;
/** After `exit`, how long to wait for stdout to drain (`close`) before reporting the exit anyway. */
export const EXIT_DRAIN_MS = 2000;
/** The capability that allows `cancel_queued` on an interrupt (S16 i). */
export const CANCEL_QUEUED_CAPABILITY = 'interrupt_cancel_queued_v1';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RUN_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;
const UNSAFE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
export type KillFn = (pid: number) => void;

export type StreamInitFacts = Extract<StreamMessage, { kind: 'init' }>;

export type StreamDriverState = 'not_started' | 'busy' | 'idle' | 'exited';

export interface StreamDriverOptions {
  nextId: () => string;
  /** Epoch ms. */
  now: () => number;
  /** Defaults to `node:child_process.spawn`. */
  spawn?: SpawnFn;
  /** Ends the process and its children. Defaults to `killProcessTree`. */
  kill?: KillFn;
  /**
   * The claude executable, spawned as given. Required, with no bare-name default: `claude` looked up by the OS from a
   * spawn whose cwd is the user's repository can run a `claude.exe` committed there (security review M2). RunHost
   * passes an absolute path (runtime/claude-path.ts) or the harness's own command.
   */
  command: string;
  /** Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

export interface StreamStartOptions {
  runId: string;
  /** A UUID, passed as `--session-id`; equals init's and every hook's `session_id` (S16 h). */
  sessionId: string;
  cwd: string;
  /** The first user message, written to stdin. */
  prompt: string;
  model?: string | null;
  permissionMode?: string | null;
  /** `--agent`: run the whole session as this agent. */
  mainAgent?: string | null;
  /** `--agents`, written to `<tempDir>/agents-<runId>.json` and removed when the process exits. */
  agents?: Record<string, TemplateAgent> | null;
  /** Folder for the `--agents` file (the app's temp or run folder). Required when `agents` is set. */
  tempDir?: string;
  /**
   * `--settings <file>`. ADR-020 §1: the product never adds hooks through `--settings`. The exit harnesses pass their
   * hook settings here; the product passes only the per-run self-report file, which holds one `permissions.allow`
   * entry (M6 P4, ADR-025).
   */
  settingsFile?: string | null;
  /** `--mcp-config <file>`: the per-run self-report server (M6 P4, F27, ADR-025). Never with `--strict-mcp-config`. */
  mcpConfigFile?: string | null;
}

export type SendResult =
  | { ok: true; delivery: 'written' | 'queued' }
  | { ok: false; reason: 'not_started' | 'exited' | 'ended' | 'stopping' | 'empty' };

export type InterruptResult =
  | { ok: true; requestId: string }
  | {
      ok: false;
      reason: 'not_started' | 'exited' | 'ended' | 'no_init' | 'idle' | 'rejected' | 'timeout';
      /** Claude Code's error text on `rejected`, clipped; else null. */
      error: string | null;
    };

export interface StreamExit {
  exitCode: number | null;
  signal: string | null;
  /** stopped: the exit followed `stop()`. completed: exit code 0. failed: anything else. */
  how: 'completed' | 'stopped' | 'failed';
  /** For `failed`: the end of stderr (or the exit code), clipped to CLIP_LIMITS.error. Else null. */
  error: string | null;
  /** The `ref` of every `send()` that was queued and never written. */
  undelivered: (string | null)[];
}

export interface StreamDriverStats {
  lines: number;
  /** Lines that were not JSON, not an object, or of a type the Huddle does not read. */
  unreadLines: number;
  /** Lines over the size cap, dropped unread. */
  oversizedLines: number;
}

type Listener<T> = (value: T) => void;

/**
 * Ends a process and its children. Windows: `%SystemRoot%\System32\taskkill.exe /PID <pid> /T /F` by absolute path (a
 * bare name could be found in the current folder first). Elsewhere: SIGKILL the group, else the pid.
 */
export function killProcessTree(pid: number): void {
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
    spawnSync(win32.join(systemRoot, 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
      shell: false,
      timeout: KILL_WAIT_MS,
    });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
    return;
  } catch {
    // Not a group leader; kill the process itself.
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

/** A value for a flag: non-empty, no leading `-` (it would read as another flag), no control characters. */
function flagValue(name: string, value: string, max: number = CLIP_LIMITS.id): string {
  // eslint-disable-next-line no-control-regex
  if (value.length === 0 || value.length > max || value.startsWith('-') || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`invalid ${name}`);
  }
  return value;
}

export interface StreamArgsInput {
  sessionId: string;
  model?: string | null;
  permissionMode?: string | null;
  mainAgent?: string | null;
  agentsFile?: string | null;
  /** See StreamStartOptions.settingsFile. */
  settingsFile?: string | null;
  /** See StreamStartOptions.mcpConfigFile. */
  mcpConfigFile?: string | null;
}

/** The argv for a managed run. Pure. Throws on a value that must not reach the command line. Never holds the prompt. */
export function buildStreamArgs(input: StreamArgsInput): string[] {
  if (!UUID.test(input.sessionId)) throw new Error('invalid session id: expected a UUID');
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];
  args.push('--session-id', input.sessionId);
  if (input.model != null) args.push('--model', flagValue('model', input.model));
  if (input.permissionMode != null) {
    if (!(PERMISSION_MODES as readonly string[]).includes(input.permissionMode)) {
      throw new Error('invalid permission mode');
    }
    args.push('--permission-mode', input.permissionMode);
  }
  if (input.agentsFile != null) args.push('--agents', flagValue('agents file', input.agentsFile, CLIP_LIMITS.path));
  if (input.mainAgent != null) args.push('--agent', flagValue('agent', input.mainAgent, 128));
  if (input.settingsFile != null) {
    args.push('--settings', flagValue('settings file', input.settingsFile, CLIP_LIMITS.path));
  }
  // `--mcp-config` takes one or more values, so it comes last: nothing positional may follow it (the prompt is on stdin).
  if (input.mcpConfigFile != null) {
    args.push('--mcp-config', flagValue('mcp config file', input.mcpConfigFile, CLIP_LIMITS.path));
  }
  return args;
}

/** The `--agents` JSON: only the documented fields of each agent, names checked. */
export function agentsJson(agents: Record<string, TemplateAgent>): string {
  const out: Record<string, TemplateAgent> = {};
  for (const [name, agent] of Object.entries(agents)) {
    if (name.length === 0 || name.length > 128 || name.startsWith('-') || UNSAFE_KEYS.has(name)) {
      throw new Error('invalid agent name');
    }
    const def: TemplateAgent = { description: agent.description, prompt: agent.prompt };
    if (agent.tools !== undefined) def.tools = [...agent.tools];
    if (agent.model !== undefined) def.model = agent.model;
    out[name] = def;
  }
  return JSON.stringify(out);
}

/** One stream-json user message line (S8). */
export function userMessageLine(text: string): string {
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })}\n`;
}

/** The interrupt control_request line (S16 a); `cancel_queued` only when the capability was advertised. */
export function interruptLine(requestId: string, capabilities: readonly string[]): string {
  const request: { subtype: 'interrupt'; cancel_queued?: true } = { subtype: 'interrupt' };
  if (capabilities.includes(CANCEL_QUEUED_CAPABILITY)) request.cancel_queued = true;
  return `${JSON.stringify({ type: 'control_request', request_id: requestId, request })}\n`;
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > CLIP_LIMITS.error ? text.slice(0, CLIP_LIMITS.error) : text;
}

/** Waits for `work` or `ms`, whichever is first; the timer is cleared either way, so it never outlives the wait. */
async function within(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([work, new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

export class StreamDriver {
  private readonly spawnFn: SpawnFn;
  private readonly killFn: KillFn;
  private readonly command: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly nextId: () => string;
  private readonly now: () => number;

  private child: ChildProcess | null = null;
  private started = false;
  private runState: StreamDriverState = 'not_started';
  private runId = '';
  private sessionId = '';
  private initFacts: StreamInitFacts | null = null;
  private readonly queue: { text: string; ref: string | null }[] = [];
  private stdinClosed = false;
  private stopRequested = false;
  private stopping: Promise<StreamExit | null> | null = null;
  private finished = false;
  private stdoutEnded = false;
  private stderrTail = '';
  private agentsFile: string | null = null;
  private exitInfo: { code: number | null; signal: string | null } | null = null;
  private drainTimer: NodeJS.Timeout | null = null;
  private readonly splitter = new LineSplitter();
  private readonly pendingControls = new Map<string, (result: InterruptResult) => void>();
  private readonly counters: StreamDriverStats = { lines: 0, unreadLines: 0, oversizedLines: 0 };

  private readonly eventListeners = new Set<Listener<HuddleEvent>>();
  private readonly initListeners = new Set<Listener<StreamInitFacts>>();
  private readonly deliveredListeners = new Set<Listener<string | null>>();
  private readonly idleListeners = new Set<Listener<undefined>>();
  private readonly exitListeners = new Set<Listener<StreamExit>>();

  private resolveExit: (exit: StreamExit) => void = () => undefined;
  /** Resolves once with the exit report (never for a run whose spawn failed). */
  readonly exited: Promise<StreamExit>;

  constructor(options: StreamDriverOptions) {
    this.spawnFn = options.spawn ?? nodeSpawn;
    this.killFn = options.kill ?? killProcessTree;
    this.command = options.command;
    this.env = options.env ?? process.env;
    this.nextId = options.nextId;
    this.now = options.now;
    this.exited = new Promise<StreamExit>((resolve) => {
      this.resolveExit = resolve;
    });
  }

  get state(): StreamDriverState {
    return this.runState;
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  /** The latest `system/init` facts, or null before the first. */
  get init(): StreamInitFacts | null {
    return this.initFacts;
  }

  get stats(): StreamDriverStats {
    return { ...this.counters };
  }

  /** Normalized events (`run.result`, `limits.measured`). Returns an unsubscribe function. */
  onEvent(listener: Listener<HuddleEvent>): () => void {
    return this.subscribe(this.eventListeners, listener);
  }

  /** Every `system/init` (one per turn). */
  onInit(listener: Listener<StreamInitFacts>): () => void {
    return this.subscribe(this.initListeners, listener);
  }

  /** A `send()` was written to stdin (the caller records `message.delivered` via `stream_input`). */
  onDelivered(listener: Listener<string | null>): () => void {
    return this.subscribe(this.deliveredListeners, listener);
  }

  /**
   * A turn ended (`result`) and the run is now idle: nothing from this driver's own queue was written, stdin is open
   * and no stop was asked for. A `send()` made from the listener is written at once (RunHost flushes the outbox here).
   */
  onIdle(listener: Listener<undefined>): () => void {
    return this.subscribe(this.idleListeners, listener);
  }

  /** The process ended (once). Not called when the spawn failed: `start()` rejects instead. */
  onExit(listener: Listener<StreamExit>): () => void {
    return this.subscribe(this.exitListeners, listener);
  }

  /**
   * Spawns the run and writes the prompt to stdin. Resolves once the process has started. Rejects on a bad option or
   * a spawn error (the caller then records `run.exited` with how `spawn_failed`); the agents file is removed then too.
   */
  async start(options: StreamStartOptions): Promise<{ pid: number }> {
    if (this.started) throw new Error('this driver was already started');
    this.started = true;
    try {
      if (!RUN_ID.test(options.runId)) throw new Error('invalid run id');
      if (options.prompt.trim().length === 0) throw new Error('the prompt is empty');
      this.runId = options.runId;
      this.sessionId = options.sessionId;

      let agentsFile: string | null = null;
      if (options.agents != null && Object.keys(options.agents).length > 0) {
        if (options.tempDir === undefined) throw new Error('tempDir is required with agents');
        const json = agentsJson(options.agents);
        agentsFile = join(options.tempDir, `agents-${options.runId}.json`);
        await writeFile(agentsFile, json, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        this.agentsFile = agentsFile;
      }
      const args = buildStreamArgs({
        sessionId: options.sessionId,
        model: options.model ?? null,
        permissionMode: options.permissionMode ?? null,
        mainAgent: options.mainAgent ?? null,
        agentsFile,
        settingsFile: options.settingsFile ?? null,
        mcpConfigFile: options.mcpConfigFile ?? null,
      });
      const child = this.spawnFn(this.command, args, {
        cwd: options.cwd,
        env: this.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
        // A new process group off Windows, so a hard stop can end claude's own children too.
        detached: process.platform !== 'win32',
      });
      await new Promise<void>((resolve, reject) => {
        let spawned = false;
        child.once('spawn', () => {
          spawned = true;
          resolve();
        });
        child.on('error', (error) => {
          // Before 'spawn': the start failed. After: a kill or pipe error; the exit is still reported by 'close'.
          if (!spawned) reject(error);
        });
      });
      this.child = child;
      this.wire(child);
      this.runState = 'busy';
      this.writeLine(userMessageLine(options.prompt));
      return { pid: child.pid ?? -1 };
    } catch (error) {
      this.runState = 'exited';
      this.finished = true;
      await this.removeAgentsFile();
      throw new Error(`could not start claude: ${errorText(error)}`, { cause: error });
    }
  }

  /**
   * Sends a user message. Written now when the run is idle; queued while a turn runs (stdin is read only after a
   * `result`, S8) and written after the next `result`. `ref` comes back through `onDelivered` or `undelivered`.
   */
  send(text: string, ref: string | null = null): SendResult {
    if (this.child === null) return { ok: false, reason: this.finished ? 'exited' : 'not_started' };
    if (this.finished) return { ok: false, reason: 'exited' };
    if (this.stopRequested) return { ok: false, reason: 'stopping' };
    if (this.stdinClosed) return { ok: false, reason: 'ended' };
    if (text.trim().length === 0) return { ok: false, reason: 'empty' };
    if (this.runState === 'idle') {
      this.deliver(text, ref);
      return { ok: true, delivery: 'written' };
    }
    this.queue.push({ text, ref });
    return { ok: true, delivery: 'queued' };
  }

  /**
   * Interrupts the running turn over stdin. Needs a `system/init` first (it says whether `cancel_queued` is allowed)
   * and a running turn. Resolves when Claude Code answers, or with `timeout`.
   */
  interrupt(timeoutMs: number = DEFAULT_CONTROL_TIMEOUT_MS): Promise<InterruptResult> {
    const refuse = (reason: Extract<InterruptResult, { ok: false }>['reason']) =>
      Promise.resolve<InterruptResult>({ ok: false, reason, error: null });
    if (this.child === null) return refuse(this.finished ? 'exited' : 'not_started');
    if (this.finished) return refuse('exited');
    if (this.stdinClosed) return refuse('ended');
    if (this.initFacts === null) return refuse('no_init');
    if (this.runState !== 'busy') return refuse('idle');
    const requestId = `huddle-int-${this.nextId()}`;
    return new Promise<InterruptResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingControls.delete(requestId);
        resolve({ ok: false, reason: 'timeout', error: null });
      }, timeoutMs);
      this.pendingControls.set(requestId, (result) => {
        clearTimeout(timer);
        this.pendingControls.delete(requestId);
        resolve(result);
      });
      if (!this.writeLine(interruptLine(requestId, this.initFacts?.capabilities ?? []))) {
        this.pendingControls.get(requestId)?.({ ok: false, reason: 'ended', error: null });
      }
    });
  }

  /** Closes stdin: the current turn finishes, then the process exits (S16 b). Queued messages are not sent. */
  end(): { ok: true } | { ok: false; reason: 'not_started' | 'exited' } {
    if (this.child === null) return { ok: false, reason: this.finished ? 'exited' : 'not_started' };
    if (this.finished) return { ok: false, reason: 'exited' };
    if (!this.stdinClosed) {
      this.stdinClosed = true;
      try {
        this.child.stdin?.end();
      } catch {
        // The pipe is already gone; the exit is reported by 'close'.
      }
    }
    return { ok: true };
  }

  /**
   * Stops the run (F13): interrupt the running turn, close stdin, and end the process hard if it has not exited
   * after `graceMs` (0: at once). Resolves with the exit report (`how` is `stopped`, or how it had already ended);
   * resolves null at once when there is no process (never started, or the spawn failed).
   */
  stop(options: { graceMs?: number } = {}): Promise<StreamExit | null> {
    if (this.child === null) return Promise.resolve(null);
    if (this.stopping !== null) return this.stopping;
    if (this.finished) return this.exited;
    this.stopRequested = true;
    const graceMs = Math.max(0, options.graceMs ?? DEFAULT_STOP_GRACE_MS);
    this.stopping = this.runStop(graceMs);
    return this.stopping;
  }

  private async runStop(graceMs: number): Promise<StreamExit> {
    const startedAt = this.now();
    if (graceMs > 0) {
      if (this.runState === 'busy' && this.initFacts !== null && !this.stdinClosed) {
        await this.interrupt(Math.max(1, Math.floor(graceMs / 2)));
      }
      this.end();
      const left = graceMs - (this.now() - startedAt);
      if (!this.finished && left > 0) await within(this.exited, left);
    }
    if (!this.hasFinished()) {
      this.hardKill();
      await within(this.exited, KILL_WAIT_MS);
      // The process never reported its end: report it anyway, so the run is not left running.
      if (!this.hasFinished()) void this.finish(null, null);
    }
    return this.exited;
  }

  /** Read through a method: `finish()` flips the flag across an `await`, which narrowing cannot see. */
  private hasFinished(): boolean {
    return this.finished;
  }

  private hardKill(): void {
    const pid = this.child?.pid;
    if (pid === undefined) return;
    try {
      this.killFn(pid);
    } catch {
      // Already gone, or the kill failed; the wait below still bounds the stop.
    }
  }

  private subscribe<T>(set: Set<Listener<T>>, listener: Listener<T>): () => void {
    set.add(listener);
    return () => set.delete(listener);
  }

  private emit<T>(set: Set<Listener<T>>, value: T): void {
    for (const listener of set) {
      try {
        listener(value);
      } catch {
        // A listener's error must not break reading the stream.
      }
    }
  }

  private wire(child: ChildProcess): void {
    child.stdin?.on('error', () => undefined); // EPIPE after the process died
    child.stdout?.on('data', (chunk: Buffer | string) => {
      for (const line of this.splitter.push(chunk)) this.onLine(line);
    });
    child.stdout?.on('end', () => {
      this.endStdout();
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
    });
    child.on('exit', (code, signal) => {
      this.exitInfo = { code, signal };
      // 'close' normally follows once stdout drains; a grandchild holding the pipe must not delay the report forever.
      this.drainTimer = setTimeout(() => void this.finish(code, signal), EXIT_DRAIN_MS);
    });
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      void this.finish(code ?? this.exitInfo?.code ?? null, signal ?? this.exitInfo?.signal ?? null);
    });
  }

  private endStdout(): void {
    if (this.stdoutEnded) return;
    this.stdoutEnded = true;
    for (const line of this.splitter.end()) this.onLine(line);
  }

  private onLine(split: SplitLine): void {
    this.counters.lines += 1;
    if (split.kind === 'oversized') {
      this.counters.oversizedLines += 1;
      if (oversizedLineIsResult(split.head)) this.turnEnded();
      return;
    }
    const out = normalizeStreamLine(split.line, {
      runId: this.runId,
      sessionId: this.sessionId,
      receivedAt: this.now(),
      nextId: this.nextId,
    });
    if (out === null) {
      this.counters.unreadLines += 1;
      return;
    }
    for (const event of out.events) this.emit(this.eventListeners, event);
    const message = out.message;
    if (message.kind === 'init') {
      this.initFacts = message;
      this.emit(this.initListeners, message);
    } else if (message.kind === 'result') {
      this.turnEnded();
    } else if (message.kind === 'control_response' && message.requestId !== null) {
      const settle = this.pendingControls.get(message.requestId);
      if (settle !== undefined) {
        settle(
          message.subtype === 'success'
            ? { ok: true, requestId: message.requestId }
            : { ok: false, reason: 'rejected', error: message.error },
        );
      }
    }
  }

  private turnEnded(): void {
    if (this.finished) return;
    this.runState = 'idle';
    if (this.stopRequested || this.stdinClosed) return;
    const next = this.queue.shift();
    if (next !== undefined) {
      this.deliver(next.text, next.ref);
      return;
    }
    this.emit(this.idleListeners, undefined);
  }

  private deliver(text: string, ref: string | null): void {
    this.runState = 'busy';
    const written = this.writeLine(userMessageLine(text), () => {
      this.emit(this.deliveredListeners, ref);
    });
    if (!written) this.queue.unshift({ text, ref });
  }

  private writeLine(line: string, done?: () => void): boolean {
    const stdin = this.child?.stdin;
    if (stdin == null || this.finished || this.stdinClosed || stdin.destroyed || stdin.writableEnded) return false;
    try {
      stdin.write(line, (error) => {
        if (error == null) done?.();
      });
      return true;
    } catch {
      return false;
    }
  }

  private async removeAgentsFile(): Promise<void> {
    const file = this.agentsFile;
    if (file === null) return;
    this.agentsFile = null;
    try {
      await rm(file, { force: true });
    } catch {
      // Best effort: the file lives in the app's temp folder.
    }
  }

  private async finish(code: number | null, signal: string | null): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    if (this.drainTimer !== null) clearTimeout(this.drainTimer);
    // Lines still buffered (a last line without a newline) are read before the exit is reported.
    this.endStdout();
    this.runState = 'exited';
    for (const settle of [...this.pendingControls.values()]) settle({ ok: false, reason: 'exited', error: null });
    await this.removeAgentsFile();

    const how: StreamExit['how'] = this.stopRequested ? 'stopped' : code === 0 ? 'completed' : 'failed';
    let error: string | null = null;
    if (how === 'failed') {
      const tail = this.stderrTail.trim();
      const text =
        tail.length > 0 ? tail : signal !== null ? `ended by signal ${signal}` : `exited with code ${String(code)}`;
      error = text.length > CLIP_LIMITS.error ? text.slice(-CLIP_LIMITS.error) : text;
    }
    const exit: StreamExit = {
      exitCode: code,
      signal,
      how,
      error,
      undelivered: this.queue.splice(0).map((item) => item.ref),
    };
    this.emit(this.exitListeners, exit);
    this.resolveExit(exit);
  }
}
