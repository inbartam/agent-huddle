/**
 * Managed runs (M4 WP6, F13 F16 F17 F20, ADR-020): launch a team template as a `claude -p` stream-json run, optionally in
 * its own git worktree, and drive it (stop, end, messages, keep or discard the worktree). The edge between HuddleCore and
 * the two I/O pieces built before it: `StreamDriver` (ingest/stream-driver.ts) and `WorktreeManager` (worktree.ts).
 *
 * Every fact becomes an event through the core's `accept` (CONTRIBUTING.md rule 1); this class keeps only the live handles
 * (one driver per run). One UUID is the runId, the `--session-id` and so the Claude Code session id (S16 h), so a run's
 * events, its hooks and its stream all file under one session and the runId placeholder never differs from it.
 *
 * Launch order (each step's failure stops there, and nothing after it happens):
 *   checks (attached, no template rules, prompt, permission mode, folder as a local path before any stat, flag values)
 *   -> claude resolved to an absolute path (M2; not found: run.launched + run.exited spawn_failed, no worktree)
 *   -> worktree.created (if asked) -> run.launched, budget.set per template budget -> spawn -> control.applied launch.
 *   run.launched comes before the spawn, so the reducer has the root managed, with its trusted `sessionCwd`, before the
 *   first hook of the run arrives. A spawn failure writes run.exited spawn_failed, raises an error item and removes the
 *   worktree it had just made (worktree.closed discarded).
 * Exit: run.exited (how from the driver), `message.dropped agent_ended` for every message still queued for the run,
 *   then worktree.summarized for a run with a worktree. A hard kill gives no SessionEnd (S16 c): run.exited is what ends
 *   the session in the reducer.
 * Crash recovery: each live run's pid is in `runs.json` (run-registry.ts) from the spawn to the exit; at the next start
 *   `reconcileOrphans` (rules in orphans.ts) stops what is verified to be ours and ends every open run in the log.
 * Turn end: messages still in the root's outbox when a turn ends go to stdin (`flushOutbox`).
 *
 * Env for the child (`managedRunEnv`): the Huddle's own env minus the variables Claude Code sets in the processes it
 * starts (NESTED_SESSION_ENV_VARS). In dev the Huddle is often started from a Claude Code terminal, and those variables
 * would tell the new `claude` it runs inside another session.
 */
import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import {
  agentKey,
  budgetScopeOf,
  CLIP_LIMITS,
  isTerminal,
  PERMISSION_MODES,
  selectRunControls,
  type AgentNode,
  type Budget,
  type CommandResult,
  type EventOfType,
  type HuddleEvent,
  type HuddleState,
  type RunControlName,
  type TeamTemplate,
} from '@huddle/shared';
import { droppedByEnd, OUTBOX_JOIN } from '../broker/outbox.js';
import {
  agentsJson,
  buildStreamArgs,
  killProcessTree,
  StreamDriver,
  type KillFn,
  type SpawnFn,
  type StreamExit,
} from '../ingest/stream-driver.js';
import { withProgressPromptLine, withProgressTool } from '../ingest/huddle-mcp.js';
import { clip } from '../text.js';
import { MANAGED_CAPABILITIES, replay } from '../state/reduce.js';
import { resolveClaudeExecutable, resolveNodeExecutable } from './claude-path.js';
import type { HuddleLogger } from './huddle-core.js';
import {
  checkProcess,
  decideOrphans,
  ORPHAN_ENDED,
  orphanCandidates,
  pidsToCheck,
  type OrphanDecision,
} from './orphans.js';
import { isLocalAbsolutePath } from './paths.js';
import { readProcessCommandLines, type CommandLineReader } from './process-info.js';
import { RunRegistry, type RunRegistryEntry } from './run-registry.js';
import {
  removeSelfReportFiles,
  selfReportOn,
  sweepSelfReportFiles,
  writeSelfReportFiles,
  type SelfReportRunFiles,
} from './self-report.js';
import { defaultWorktreeDataDir, samePath, WorktreeManager, type GitRunner, type WorktreeEntry } from './worktree.js';

/**
 * Variables Claude Code 2.1.325 sets in the processes it starts (observed in a Bash tool call's environment on this
 * machine, 2026-11-14; not documented as a list): they say "you are inside session X". A managed run is a new top-level
 * session, so they are removed. Auth, the user's own settings env (`CLAUDE_CODE_ENABLE_TELEMETRY`,
 * `CLAUDE_CODE_ENABLE_TODO_TOOLS`, `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`, ...), `CLAUDE_CONFIG_DIR`, `ANTHROPIC_*` and
 * `OTEL_*` are kept. Matched case-insensitively (Windows env names are).
 */
export const NESTED_SESSION_ENV_VARS = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'AI_AGENT',
] as const;

const NESTED: ReadonlySet<string> = new Set(NESTED_SESSION_ENV_VARS.map((n) => n.toUpperCase()));

/** The env for a managed run: a copy of `base` without NESTED_SESSION_ENV_VARS. Pure. */
export function managedRunEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined || NESTED.has(name.toUpperCase())) continue;
    env[name] = value;
  }
  return env;
}

/** Folder (under the app data folder) for the `--agents` files; each is removed when its run exits. */
export const RUN_AGENTS_DIRNAME = 'run-agents';
/** run.stop: how long the run gets to finish (interrupt, close stdin) before it is ended hard. */
export const DEFAULT_RUN_STOP_GRACE_MS = 3000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The name StreamDriver gives an `--agents` file; group 1 is the run id. */
const AGENTS_FILE = /^agents-(.+)\.json$/;

/**
 * `run.launch` of a template with `ruleIds`: refused (fail closed). What "rules of this run on top of the enabled global
 * ones" means for a rule that is disabled globally is not decided, and silently ignoring a template's rule could drop
 * a deny the user relied on.
 */
export const TEMPLATE_RULES_UNSUPPORTED =
  'This template has rules of its own, which this build cannot apply yet. Remove them from the template or add them as global rules.';

/**
 * The scope a template's budget is written with at launch (ADR-020 §4): 'agent' stays on the run's main agent, and
 * every other scope ('session', 'overall', 'all') limits the whole run, written as a 'session' budget under the run's
 * own session. A template never writes an 'overall' budget.set: the overall budget is the user's one setting (filed
 * under BUDGET_SESSION_ID by the `budget.set` command), and a run's budget ends with the run, so it never needs the
 * start-up replay after the run (M5 WP5 checked this; see huddle-core.prune.test.ts).
 */
export function templateBudgetScope(scope: Budget['scope']): 'agent' | 'session' {
  return budgetScopeOf(scope) === 'agent' ? 'agent' : 'session';
}

/** The error item a launch that never started raises (the tree's root shows only "failed"). */
export function runFailedItemId(runId: string): string {
  return `run:${runId}:spawn_failed`;
}

/**
 * How runs are launched. The desktop app needs none of these: the defaults are the installed `claude`,
 * `process.env`, %LOCALAPPDATA% worktrees. Three are for the M4 exit harness and tests only, and the desktop app must
 * never set them: `claudeCommand`, `settingsFile` and `skipAttachCheck`.
 */
export interface RunLaunchOptions {
  /**
   * Harness and tests only: the claude executable, spawned exactly as given (e.g. the fake claude). Default: `claude`
   * resolved once to an absolute path on the run env's PATH (claude-path.ts), never by bare name (security review M2).
   */
  claudeCommand?: string;
  /**
   * Harness only: passed as `--settings <file>` to every run (an args-array value, never through a shell). The exit
   * harness's per-run settings point the hooks at its headless Huddle on a private port, like scripts/m3-exit.mjs.
   * ADR-020 §1: the product never adds hooks through `--settings` (user and `--settings` hooks may both fire).
   */
  settingsFile?: string;
  /**
   * Harness only: launch without the user-level hooks attached (the harness's `settingsFile` brings the hooks). Without
   * it, `run.launch` needs an attached connection (ADR-020 §1).
   */
  skipAttachCheck?: boolean;
  /** Tests inject the fake claude here. */
  spawn?: SpawnFn;
  kill?: KillFn;
  /** The env the run's env is made from (default `process.env`); NESTED_SESSION_ENV_VARS are removed from it. */
  env?: NodeJS.ProcessEnv;
  /** Where worktrees live (default `defaultWorktreeDataDir()`: %LOCALAPPDATA%, not the roaming app data folder). */
  worktreeDataDir?: string;
  git?: GitRunner;
  /** A new run's UUID (default `crypto.randomUUID`). */
  newSessionId?: () => string;
  /** run.stop grace (default DEFAULT_RUN_STOP_GRACE_MS). */
  stopGraceMs?: number;
  /**
   * Tests: the process list for start-up reconciliation (default `readProcessCommandLines`: PowerShell CIM on Windows,
   * wmic as a fallback, `ps` elsewhere). `kill` above also ends an orphan's tree.
   */
  processCommandLines?: CommandLineReader;
}

export interface RunHostDeps {
  /** The app data folder; the `--agents` files go in `<dataDir>/run-agents`. */
  dataDir: string;
  now: () => number;
  nextId: () => string;
  getState: () => HuddleState;
  /** Reduce (synchronously) and store events. Resolves false when the write failed. */
  accept: (events: readonly HuddleEvent[]) => Promise<boolean>;
  /** Background work the core waits for on quit. */
  track: <T>(work: Promise<T>) => Promise<T>;
  logger: HuddleLogger;
  /** Null when a run may be launched now, else the reason in the UI's words (ADR-020 §1: hooks attached). */
  launchRefusal: () => string | null;
  options?: RunLaunchOptions;
  /**
   * Tests only (HuddleCoreDeps.runIsLive): runs seeded in the log that stand for live runs of this Huddle. Start-up
   * reconciliation leaves them alone. The app never sets it.
   */
  runIsLive?: (runId: string) => boolean;
  /**
   * M5 WP5: one run's stored lifecycle events (run.*, worktree.*) in log order, for a Keep or Discard on a run that is
   * no longer in the live state. Absent: such a run is found in the worktree registry only.
   */
  storedRunEvents?: (runId: string) => Promise<HuddleEvent[]>;
  /**
   * Self-reported progress (M6 P4, F27, ADR-025). `serverSource`: the server script shipped with the app; `enabled`:
   * the global `selfReport.enabled` setting, read at each launch. Absent: no run gets the tool.
   */
  selfReport?: { serverSource: string; enabled: () => boolean };
}

interface LiveRun {
  runId: string;
  sessionId: string;
  driver: StreamDriver;
  worktree: WorktreeEntry | null;
  exited: boolean;
  /** The run has a `<dataDir>/run-mcp/<runId>/` folder to remove at its exit. */
  selfReport: boolean;
}

type Fields<T extends HuddleEvent['type']> = Omit<
  EventOfType<T>,
  'id' | 'type' | 'ts' | 'sessionId' | 'agentKey' | 'source'
>;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fail(code: Extract<CommandResult, { ok: false }>['code'], message: string): CommandResult {
  return { ok: false, code, message };
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, Math.max(0, ms)).unref();
  });

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fsp.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

export class RunHost {
  private readonly deps: RunHostDeps;
  private readonly options: RunLaunchOptions;
  private readonly live = new Map<string, LiveRun>();
  private manager: WorktreeManager | null = null;
  private closing = false;
  /** `claude` as an absolute path, found on the first launch (M2). Null until then, and after a failed spawn. */
  private resolvedClaude: string | null = null;

  /** runs.json: the pid of every live run, for start-up reconciliation after a crash. */
  private readonly registry: RunRegistry;

  constructor(deps: RunHostDeps) {
    this.deps = deps;
    this.options = deps.options ?? {};
    this.registry = new RunRegistry({ dataDir: deps.dataDir, now: deps.now });
  }

  /** The worktree manager, made on first use (it reads nothing until asked). */
  private worktrees(): WorktreeManager {
    this.manager ??= new WorktreeManager({
      dataDir: this.options.worktreeDataDir ?? defaultWorktreeDataDir(),
      now: this.deps.now,
      ...(this.options.git !== undefined ? { git: this.options.git } : {}),
    });
    return this.manager;
  }

  /** Read through a method: `shutdown()` sets the flag across an await, which narrowing cannot see. */
  private isClosing(): boolean {
    return this.closing;
  }

  /** True while the run's process has not exited (a run this Huddle did not start, or no longer knows: false). */
  isAlive(runId: string): boolean {
    const run = this.live.get(runId);
    return run !== undefined && !run.exited;
  }

  /**
   * Was this live run started with the Huddle MCP server (`--mcp-config`, self-report on; M6 P5b)? False once it exited,
   * failed to get its files, or is unknown. In memory only: no file is read.
   */
  hasSelfReport(runId: string): boolean {
    const run = this.live.get(runId);
    return run !== undefined && !run.exited && run.selfReport;
  }

  /** The runs whose process is alive. */
  liveRunIds(): string[] {
    return [...this.live.values()].filter((r) => !r.exited).map((r) => r.runId);
  }

  private event<T extends HuddleEvent['type']>(
    type: T,
    sessionId: string,
    source: 'huddle' | 'user',
    fields: Fields<T>,
  ): HuddleEvent {
    return {
      id: this.deps.nextId(),
      type,
      ts: this.deps.now(),
      sessionId,
      agentKey: agentKey(sessionId),
      source,
      ...fields,
    } as unknown as HuddleEvent;
  }

  private emit(...events: HuddleEvent[]): Promise<boolean> {
    return this.deps.accept(events);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Launch
  // -------------------------------------------------------------------------------------------------------------------

  /**
   * `run.launch` with a template already resolved (stored or inline, validated by the caller). Resolves ok with the
   * runId in `detail` once the process has started.
   */
  async launch(template: TeamTemplate, templateId: string | null, promptOverride?: string): Promise<CommandResult> {
    const refusal = this.deps.launchRefusal();
    if (refusal !== null) return fail('unsupported', refusal);
    if (this.isClosing()) return fail('failed', 'Agent Huddle is shutting down.');
    // Fail closed (security review): a template's own rules may include a deny, and this build cannot apply them.
    if ((template.ruleIds ?? []).length > 0) return fail('unsupported', TEMPLATE_RULES_UNSUPPORTED);

    const prompt = promptOverride ?? template.prompt;
    if (prompt.trim() === '') return fail('invalid', 'The prompt is empty.');
    if (!(PERMISSION_MODES as readonly string[]).includes(template.permissionMode)) {
      return fail(
        'invalid',
        `This version of Agent Huddle cannot launch with the permission mode "${clip(template.permissionMode, 40)}".`,
      );
    }
    // Text only, before any file system call: stat-ing `\\host\share` would make Windows contact that host (L3).
    if (!isLocalAbsolutePath(template.cwd)) {
      return fail('invalid', 'The folder must be a full local path (C:\\…), not a network or device path.');
    }
    if (!(await isDirectory(template.cwd))) return fail('not_found', 'That folder does not exist.');

    const sessionId = (this.options.newSessionId ?? randomUUID)();
    if (!UUID.test(sessionId)) return fail('failed', 'Could not make an id for the run.');
    const runId = sessionId;
    const agents = template.agents !== undefined && Object.keys(template.agents).length > 0 ? template.agents : null;
    try {
      // The values that go on the command line, checked before anything is made (the driver checks them again).
      buildStreamArgs({
        sessionId,
        model: template.model,
        permissionMode: template.permissionMode,
        mainAgent: template.mainAgent,
        agentsFile: agents === null ? null : 'agents.json',
        settingsFile: this.options.settingsFile ?? null,
      });
      if (agents !== null) agentsJson(agents);
    } catch (error) {
      return fail('invalid', `The template has a value that cannot be passed to claude (${messageOf(error)}).`);
    }

    // 0. Which claude to start, as an absolute path (M2), before a worktree is made for a run that cannot start.
    const runEnv = managedRunEnv(this.options.env ?? process.env);
    const command = await this.claudeCommand(runEnv);
    if (!command.ok) {
      const agentNames = agents === null ? [] : Object.keys(agents);
      await this.emit(this.launchedEvent(sessionId, templateId, template, template.cwd, agentNames, null));
      await this.spawnFailed({ runId, sessionId, worktree: null, exited: false, selfReport: false }, command.message);
      return fail('failed', `claude could not be started: ${command.message}`);
    }

    // 1. The worktree (ADR-020 §2). createWorktree leaves nothing behind when it fails.
    let worktree: WorktreeEntry | null = null;
    if (template.worktree) {
      try {
        worktree = await this.worktrees().createWorktree({ repoDir: template.cwd, runId });
      } catch (error) {
        this.deps.logger.warn('run worktree not made', { error: messageOf(error) });
        return fail(
          'failed',
          `No worktree was made, so the run was not started: ${clip(messageOf(error), CLIP_LIMITS.error)}`,
        );
      }
      await this.emit(
        this.event('worktree.created', sessionId, 'huddle', {
          runId,
          path: clip(worktree.path, CLIP_LIMITS.path),
          branch: clip(worktree.branch, CLIP_LIMITS.path),
          baseCommit: worktree.baseCommit,
          repoRoot: clip(worktree.repoRoot, CLIP_LIMITS.path),
        }),
      );
    }
    const cwd = worktree?.path ?? template.cwd;

    // 2. The run, before the process: the reducer makes the root managed and sets its trusted folder first.
    const agentNames = agents === null ? [] : Object.keys(agents);
    await this.emit(
      this.launchedEvent(sessionId, templateId, template, cwd, agentNames, worktree),
      ...this.budgetEvents(sessionId, template.budgets ?? []),
    );
    // 3. Self-report files (F27), optional: a failure launches the run without them.
    const self = await this.selfReportFiles(template, runId, runEnv);
    const runPrompt = self === null ? prompt : withProgressPromptLine(prompt);
    const runAgents = self === null || agents === null ? agents : withProgressTool(agents);
    // 4. The process.
    const driver = new StreamDriver({
      nextId: this.deps.nextId,
      now: this.deps.now,
      env: runEnv,
      command: command.path,
      ...(this.options.spawn !== undefined ? { spawn: this.options.spawn } : {}),
      ...(this.options.kill !== undefined ? { kill: this.options.kill } : {}),
    });
    const run: LiveRun = { runId, sessionId, driver, worktree, exited: false, selfReport: self !== null };
    driver.onEvent((event) => {
      void this.emit(event);
    });
    driver.onDelivered((messageId) => {
      if (messageId === null) return;
      void this.emit(this.event('message.delivered', sessionId, 'huddle', { messageId, via: 'stream_input' }));
    });
    driver.onIdle(() => {
      this.flushOutbox(run);
    });
    driver.onExit((exit) => {
      this.onExit(run, exit);
    });

    const agentsDir = path.join(path.resolve(this.deps.dataDir), RUN_AGENTS_DIRNAME);
    let pid: number;
    try {
      if (agents !== null) await fsp.mkdir(agentsDir, { recursive: true, mode: 0o700 });
      ({ pid } = await driver.start({
        runId,
        sessionId,
        cwd,
        prompt: runPrompt,
        model: template.model,
        permissionMode: template.permissionMode,
        mainAgent: template.mainAgent,
        agents: runAgents,
        tempDir: agentsDir,
        settingsFile: self?.settingsFile ?? this.options.settingsFile ?? null,
        mcpConfigFile: self?.mcpConfigFile ?? null,
      }));
    } catch (error) {
      // The file may have gone (claude updated or removed): search again next time.
      if (this.options.claudeCommand === undefined) this.resolvedClaude = null;
      await this.spawnFailed(run, messageOf(error));
      return fail('failed', `claude could not be started: ${clip(messageOf(error), CLIP_LIMITS.error)}`);
    }
    this.live.set(runId, run);
    // The pid on disk, so a Huddle that crashes can find this process at its next start (reconcileOrphans). Queued
    // before any exit can remove it, so the remove in onExit always comes after.
    if (pid > 0 && !run.exited) {
      await this.registry
        .add({ runId, pid, startedAt: this.deps.now(), command: clip(command.path, CLIP_LIMITS.path) })
        .catch((error: unknown) => {
          this.deps.logger.warn('the run could not be recorded in runs.json', { error: messageOf(error) });
        });
    }
    await this.emit(this.event('control.applied', sessionId, 'user', { action: 'launch', detail: runId }));
    this.deps.logger.info('run launched', {
      worktree: worktree !== null,
      agents: agentNames.length,
      selfReport: self !== null,
    });
    if (this.isClosing()) {
      // Quit began while the process was starting: it must not outlive the Huddle.
      void this.deps.track(driver.stop({ graceMs: 0 }));
    }
    return { ok: true, detail: runId };
  }

  private launchedEvent(
    sessionId: string,
    templateId: string | null,
    template: TeamTemplate,
    cwd: string,
    agentNames: string[],
    worktree: WorktreeEntry | null,
  ): HuddleEvent {
    return this.event('run.launched', sessionId, 'huddle', {
      runId: sessionId,
      claudeSessionId: sessionId,
      templateId,
      cwd: clip(cwd, CLIP_LIMITS.path),
      model: template.model,
      permissionMode: template.permissionMode,
      mainAgent: template.mainAgent,
      agentNames,
      worktree: worktree === null ? null : { path: clip(worktree.path, CLIP_LIMITS.path), branch: worktree.branch },
    });
  }

  /**
   * The claude to spawn (M2). The harness's `claudeCommand` as given; otherwise `claude` found on the run env's PATH
   * as an absolute path (`resolveClaudeExecutable`: absolute PATH entries only, `.com`/`.exe` on Windows, never the
   * spawn folder), searched on the first launch and kept. A failed search is not kept, so installing claude later
   * works without a restart.
   */
  private async claudeCommand(
    env: NodeJS.ProcessEnv,
  ): Promise<{ ok: true; path: string } | { ok: false; message: string }> {
    if (this.options.claudeCommand !== undefined) return { ok: true, path: this.options.claudeCommand };
    if (this.resolvedClaude !== null) return { ok: true, path: this.resolvedClaude };
    const found = await resolveClaudeExecutable({ env });
    if (!found.ok) {
      this.deps.logger.warn('claude not found', { reason: found.reason });
      return { ok: false, message: found.message };
    }
    this.resolvedClaude = found.path;
    return found;
  }

  /**
   * The run's self-report files (self-report.ts), or null when self-report is off for it or they could not be made: no
   * server script shipped, no `node` on the run's PATH, a write that failed. Each of those is logged and the run starts
   * without the tool (fail open: self-report is optional).
   */
  private async selfReportFiles(
    template: TeamTemplate,
    runId: string,
    runEnv: NodeJS.ProcessEnv,
  ): Promise<SelfReportRunFiles | null> {
    const config = this.deps.selfReport;
    if (config === undefined || !selfReportOn(template, config.enabled())) return null;
    const nodeCommand = await resolveNodeExecutable({ env: runEnv });
    if (nodeCommand === null) {
      this.deps.logger.warn('self-report is off for this run: node was not found on PATH');
      return null;
    }
    try {
      return await writeSelfReportFiles({
        dataDir: this.deps.dataDir,
        runId,
        serverSource: config.serverSource,
        nodeCommand,
        baseSettingsFile: this.options.settingsFile ?? null,
      });
    } catch (error) {
      this.deps.logger.warn('self-report is off for this run: its files could not be written', {
        error: messageOf(error),
      });
      return null;
    }
  }

  /** Removes a run's self-report folder (at its exit or failed start). */
  private dropSelfReport(run: Pick<LiveRun, 'runId' | 'selfReport'>): void {
    if (!run.selfReport) return;
    run.selfReport = false;
    void this.deps.track(
      removeSelfReportFiles(this.deps.dataDir, run.runId).then((ok) => {
        if (!ok) this.deps.logger.warn('the self-report files of a run could not be removed');
      }),
    );
  }

  /**
   * Remove the `--agents` files (`<dataDir>/run-agents/agents-<runId>.json`) of runs that are not live: a crash or a
   * kill of the Huddle leaves them behind, and they hold the template's agent prompts (L4). Called at core start, when
   * no run is live. Only regular files named `agents-*.json`; anything else in the folder is left. Never throws.
   */
  async sweepAgentFiles(): Promise<number> {
    const dir = path.join(path.resolve(this.deps.dataDir), RUN_AGENTS_DIRNAME);
    const live = new Set(this.liveRunIds());
    // The self-report folders (run-mcp/<runId>/) of runs that are not live, by the same rule (they hold no secret, but
    // a copy of the server script per run would pile up).
    const selfReport = await sweepSelfReportFiles(this.deps.dataDir, (id) => live.has(id));
    if (selfReport > 0) this.deps.logger.info('removed self-report files left from an earlier run', { selfReport });
    let names: string[];
    try {
      names = await fsp.readdir(dir);
    } catch {
      return 0; // no folder yet
    }
    let removed = 0;
    for (const name of names) {
      const m = AGENTS_FILE.exec(name);
      if (m === null || live.has(m[1] ?? '')) continue;
      const file = path.join(dir, name);
      try {
        if (!(await fsp.lstat(file)).isFile()) continue;
        await fsp.rm(file, { force: true });
        removed += 1;
      } catch (error) {
        this.deps.logger.warn('an old --agents file could not be removed', { error: messageOf(error) });
      }
    }
    if (removed > 0) this.deps.logger.info('removed --agents files left from an earlier run', { removed });
    return removed;
  }

  /**
   * Start-up reconciliation of runs a Huddle crash left behind (orphans.ts has the rules). Called once at core start,
   * after replay, once the hook port is bound (so no other Huddle owns this data folder's runs) and before launching is
   * allowed. For each run in runs.json, and each replayed run without `run.exited`: a live process that is verified to
   * be that run (`--session-id <runId>` in its command line) has its tree killed; one that cannot be verified is left
   * alone (its pid may be reused). Then `run.exited` (how stopped, the reason in `error`), `message.dropped
   * agent_ended` for what was still queued, and `worktree.summarized` for a worktree, so discard is possible.
   * A process still running after the kill gets no `run.exited` (it is alive), an error item instead, and stays in
   * runs.json for the next start. Never throws.
   */
  async reconcileOrphans(): Promise<{ stopped: number; ended: number; unchecked: number; stillRunning: number }> {
    const counts = { stopped: 0, ended: 0, unchecked: 0, stillRunning: 0 };
    let entries: RunRegistryEntry[] = [];
    try {
      entries = (await this.registry.read()).entries;
    } catch (error) {
      this.deps.logger.warn('runs.json could not be read; replayed runs are not checked', { error: messageOf(error) });
    }
    const live = new Set(this.liveRunIds().map((id) => id.toLowerCase()));
    const standIn = this.deps.runIsLive ?? (() => false);
    const candidates = orphanCandidates(this.deps.getState(), entries).filter(
      (c) => !live.has(c.runId.toLowerCase()) && !standIn(c.runId),
    );
    if (candidates.length === 0) return counts;

    const read: CommandLineReader =
      this.options.processCommandLines ?? ((pids) => readProcessCommandLines(pids, { env: process.env }));
    const pids = pidsToCheck(candidates);
    const lines = pids.length === 0 ? new Map<number, string | null>() : await read(pids);
    const decisions = decideOrphans(candidates, lines);

    // Kill what is verified to be ours, then look again: a process that survived is still running.
    const kill = this.options.kill ?? killProcessTree;
    const killed = decisions.filter((d): d is OrphanDecision & { kill: number } => d.kill !== null);
    for (const d of killed) {
      try {
        kill(d.kill);
      } catch (error) {
        this.deps.logger.warn('an orphaned run could not be killed', { error: messageOf(error) });
      }
    }
    const survivors = new Set<string>();
    if (killed.length > 0) {
      const after = await read(killed.map((d) => d.kill));
      for (const d of killed) if (checkProcess(d.kill, d.sessionId, after) === 'ours') survivors.add(d.runId);
    }

    for (const d of decisions) {
      if (survivors.has(d.runId)) {
        counts.stillRunning += 1;
        await this.emit(
          this.event('attention.raised', d.sessionId, 'huddle', {
            item: {
              id: `run:${d.runId}:orphan`,
              kind: 'error',
              severity: 'action_required',
              agentKey: agentKey(d.sessionId),
              title: 'A run from before the restart is still running',
              detail: `The Huddle restarted while this run was going and could not stop its process (pid ${String(d.kill)}). End it in Task Manager.`,
              createdAt: this.deps.now(),
              resolvedAt: null,
            },
          }),
        );
        continue;
      }
      if (d.exitedError === null) continue;
      if (d.kill !== null) counts.stopped += 1;
      else if (d.exitedError === ORPHAN_ENDED) counts.ended += 1;
      else counts.unchecked += 1;
      const before = this.deps.getState();
      const exited = this.event('run.exited', d.sessionId, 'huddle', {
        runId: d.runId,
        exitCode: null,
        how: 'stopped',
        error: d.exitedError,
      });
      await this.emit(exited);
      const dropped = droppedByEnd(before, this.deps.getState(), [exited], {
        now: this.deps.now(),
        nextId: this.deps.nextId,
      });
      if (dropped.length > 0) await this.emit(...dropped);
      if (d.worktreePath !== null) void this.deps.track(this.summarize(d, d.worktreePath));
    }

    const done = decisions.filter((d) => !survivors.has(d.runId)).map((d) => d.runId);
    await this.registry.remove(done).catch((error: unknown) => {
      this.deps.logger.warn('runs.json could not be updated after reconciliation', { error: messageOf(error) });
    });
    this.deps.logger.info('reconciled runs left by an earlier Huddle', counts);
    return counts;
  }

  /** Template budgets apply to the new session: 'agent' to its main agent, every other scope to the whole session. */
  private budgetEvents(sessionId: string, budgets: readonly Budget[]): HuddleEvent[] {
    const root = agentKey(sessionId);
    return budgets.map((b) => {
      const scope = templateBudgetScope(b.scope);
      return this.event('budget.set', sessionId, 'huddle', { scope, targetKey: root, budget: { ...b, scope } });
    });
  }

  private async spawnFailed(
    run: Pick<LiveRun, 'runId' | 'sessionId' | 'worktree' | 'exited' | 'selfReport'>,
    why: string,
  ): Promise<void> {
    this.dropSelfReport(run);
    const error = clip(why, CLIP_LIMITS.error);
    const now = this.deps.now();
    await this.emit(
      this.event('run.exited', run.sessionId, 'huddle', {
        runId: run.runId,
        exitCode: null,
        how: 'spawn_failed',
        error,
      }),
      this.event('attention.raised', run.sessionId, 'huddle', {
        item: {
          id: runFailedItemId(run.runId),
          kind: 'error',
          severity: 'action_required',
          agentKey: agentKey(run.sessionId),
          title: 'The run could not start',
          detail: error,
          createdAt: now,
          resolvedAt: null,
        },
      }),
    );
    run.exited = true;
    if (run.worktree === null) return;
    const wt = run.worktree;
    const result = await this.worktrees().discardWorktree(
      { runId: run.runId, path: wt.path },
      { isProcessAlive: () => false },
    );
    if (result.outcome === 'discarded') {
      await this.emit(
        this.event('worktree.closed', run.sessionId, 'huddle', {
          runId: run.runId,
          outcome: 'discarded',
          error: result.error === null ? null : clip(result.error, CLIP_LIMITS.error),
        }),
      );
    } else {
      this.deps.logger.warn('the worktree of a run that did not start was not removed', { outcome: result.outcome });
    }
  }

  private onExit(run: LiveRun, exit: StreamExit): void {
    run.exited = true;
    this.dropSelfReport(run);
    void this.deps.track(
      this.registry.remove([run.runId]).catch((error: unknown) => {
        this.deps.logger.warn('the run could not be removed from runs.json', { error: messageOf(error) });
      }),
    );
    const before = this.deps.getState();
    const exited = this.event('run.exited', run.sessionId, 'huddle', {
      runId: run.runId,
      exitCode: exit.exitCode,
      how: exit.how,
      error: exit.error,
    });
    void this.emit(exited);
    // Messages still queued for the run can no longer be delivered (the reducer emptied the outboxes).
    const dropped = droppedByEnd(before, this.deps.getState(), [exited], {
      now: this.deps.now(),
      nextId: this.deps.nextId,
    });
    if (dropped.length > 0) void this.emit(...dropped);
    this.deps.logger.info('run exited', { how: exit.how, exitCode: exit.exitCode });
    const wt = run.worktree;
    if (wt !== null) void this.deps.track(this.summarize(run, wt.path));
  }

  private async summarize(run: Pick<LiveRun, 'runId' | 'sessionId'>, wtPath: string): Promise<void> {
    try {
      const summary = await this.worktrees().summarizeWorktree({ runId: run.runId, path: wtPath });
      await this.emit(
        this.event('worktree.summarized', run.sessionId, 'huddle', {
          runId: run.runId,
          filesChanged: summary.filesChanged,
          insertions: summary.insertions,
          deletions: summary.deletions,
          untracked: summary.untracked,
          files: summary.files,
        }),
      );
    } catch (error) {
      this.deps.logger.warn('could not summarize a run worktree', { error: messageOf(error) });
    }
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Run commands
  // -------------------------------------------------------------------------------------------------------------------

  /** The root of the run, if the state knows it. */
  private rootOf(runId: string): AgentNode | undefined {
    return Object.values(this.deps.getState().agents).find((n) => n.kind === 'main' && n.run?.runId === runId);
  }

  /** The root, when `control` is enabled for it (selectRunControls), else the refusal. */
  private checked(runId: string, control: RunControlName): { root: AgentNode } | { refused: CommandResult } {
    const root = this.rootOf(runId);
    if (root === undefined) return { refused: fail('not_found', 'That run is not known.') };
    const state = selectRunControls(root)[control];
    if (!state.enabled) return { refused: fail('unsupported', state.reason ?? 'Not available for this run.') };
    return { root };
  }

  /** `run.stop` (F13): interrupt, close stdin, end hard after the grace. Writes `control.applied stop` (user). */
  async stop(runId: string, via?: 'phone'): Promise<CommandResult> {
    const check = this.checked(runId, 'stop');
    if ('refused' in check) return check.refused;
    const result = await this.stopRun(runId);
    if (!result.ok) return result;
    await this.emit(
      this.event('control.applied', check.root.sessionId, 'user', {
        action: 'stop',
        detail: null,
        ...(via !== undefined ? { via } : {}),
      }),
    );
    return result;
  }

  /**
   * Stops a run's process and resolves once it has exited (the budget runner's StopRun, F19; it writes its own
   * `control.applied stop`). Not this Huddle's process, or already ended: refused.
   */
  async stopRun(runId: string): Promise<CommandResult> {
    const run = this.live.get(runId);
    if (run === undefined)
      return fail('unsupported', 'This run was not started by this Agent Huddle, so it cannot be stopped.');
    if (run.exited) return fail('expired', 'This run has already ended.');
    const exit = await run.driver.stop({ graceMs: this.options.stopGraceMs ?? DEFAULT_RUN_STOP_GRACE_MS });
    if (exit === null) return fail('failed', 'The run could not be stopped.');
    return { ok: true };
  }

  /** `run.end`: close stdin, so the run exits when its current turn ends (S16 b). */
  end(runId: string): CommandResult {
    const check = this.checked(runId, 'end');
    if ('refused' in check) return check.refused;
    const run = this.live.get(runId);
    if (run === undefined)
      return fail('unsupported', 'This run was not started by this Agent Huddle, so it cannot be ended.');
    const ended = run.driver.end();
    return ended.ok ? { ok: true } : fail('expired', 'This run has already ended.');
  }

  /**
   * The run a Keep or Discard is for, and its worktree folder, when that control is enabled (selectRunControls).
   *
   * M5 WP5: a run that is no longer in the live state (it ended more than a day ago, so the start-up replay left it in
   * the database) is rebuilt from its stored run and worktree events (`storedRunEvents`), and when those were deleted
   * too (retention), from the worktree registry (worktrees.json). For such a run "alive" is this Huddle's own process
   * check: a run of an earlier Huddle that was still in runs.json was ended at start (`reconcileOrphans`). The
   * WorktreeManager checks that follow are the M4 ones, unchanged: the registry record and ownership, the `.git` link,
   * no link followed, and the process check again.
   */
  private async worktreeTarget(
    runId: string,
    control: 'keep' | 'discard',
  ): Promise<{ sessionId: string; path: string } | { refused: CommandResult }> {
    const live = this.rootOf(runId);
    let root: Pick<AgentNode, 'run' | 'capabilities' | 'sessionId'> | undefined = live;
    if (root === undefined) root = await this.storedRoot(runId);
    if (root?.run == null) return { refused: fail('not_found', 'That run is not known.') };
    const run = root.run;
    const exited = run.exited ?? null;
    // Not in the live state and not live in this Huddle: the process is gone, whatever its last stored event says.
    const view =
      live === undefined && exited === null && !this.isAlive(runId)
        ? { ...root, run: { ...run, exited: { at: 0, exitCode: null, how: 'stopped' as const, error: null } } }
        : root;
    const state = selectRunControls(view)[control];
    if (!state.enabled) return { refused: fail('unsupported', state.reason ?? 'Not available for this run.') };
    const wt = run.worktree;
    if (wt === null) return { refused: fail('not_found', 'This run has no worktree.') };
    return { sessionId: root.sessionId, path: wt.path };
  }

  /** A run that is not in the live state, from its stored events, else from the worktree registry; undefined if neither. */
  private async storedRoot(runId: string): Promise<Pick<AgentNode, 'run' | 'capabilities' | 'sessionId'> | undefined> {
    try {
      const events = (await this.deps.storedRunEvents?.(runId)) ?? [];
      if (events.length > 0) {
        const state = replay(events);
        const root = Object.values(state.agents).find((n) => n.kind === 'main' && n.run?.runId === runId);
        if (root !== undefined) return root;
      }
    } catch (error) {
      this.deps.logger.warn('could not read a stored run', { error: messageOf(error) });
    }
    let records;
    try {
      records = await this.worktrees().listWorktrees();
    } catch (error) {
      this.deps.logger.warn('the worktree list could not be read', { error: messageOf(error) });
      return undefined;
    }
    const record = records.find((r) => r.runId === runId);
    if (record === undefined) return undefined;
    return {
      sessionId: runId,
      capabilities: { ...MANAGED_CAPABILITIES },
      run: {
        runId,
        templateId: null,
        permissionMode: 'default',
        mainAgent: null,
        agentNames: [],
        worktree: { path: record.path, branch: record.branch, state: record.state, repoRoot: record.repoRoot },
        exited: null,
        result: null,
      },
    };
  }

  async keepWorktree(runId: string): Promise<CommandResult> {
    const check = await this.worktreeTarget(runId, 'keep');
    if ('refused' in check) return check.refused;
    const result = await this.worktrees().keepWorktree({ runId, path: check.path });
    if (result.outcome === 'refused') return fail('failed', `The worktree was not kept: ${result.reason}`);
    await this.emit(this.event('worktree.closed', check.sessionId, 'user', { runId, outcome: 'kept', error: null }));
    return { ok: true };
  }

  async discardWorktree(runId: string): Promise<CommandResult> {
    const check = await this.worktreeTarget(runId, 'discard');
    if ('refused' in check) return check.refused;
    const result = await this.worktrees().discardWorktree(
      { runId, path: check.path },
      { isProcessAlive: () => this.isAlive(runId) },
    );
    if (result.outcome === 'refused') return fail('unsupported', `The worktree was not discarded: ${result.reason}`);
    if (result.outcome === 'failed') return fail('failed', `The worktree was not discarded: ${result.error}`);
    await this.emit(
      this.event('worktree.closed', check.sessionId, 'user', {
        runId,
        outcome: 'discarded',
        error: result.error === null ? null : clip(result.error, CLIP_LIMITS.error),
      }),
    );
    return result.error === null ? { ok: true } : { ok: true, detail: result.error };
  }

  /**
   * `run.openWorktree`: the worktree's folder in `detail`, for desktop main to open in VS Code (F20). Only a folder the
   * Huddle made for this run (its registry record) and that still exists; the path in the event log is not trusted alone.
   */
  async openWorktree(runId: string): Promise<CommandResult> {
    const check = this.checked(runId, 'open');
    if ('refused' in check) return check.refused;
    const wt = check.root.run?.worktree;
    if (wt == null) return fail('not_found', 'This run has no worktree.');
    let records;
    try {
      records = await this.worktrees().listWorktrees();
    } catch (error) {
      return fail('failed', `The worktree list could not be read: ${clip(messageOf(error), CLIP_LIMITS.error)}`);
    }
    const record = records.find((r) => r.runId === runId);
    if (record === undefined || !samePath(record.path, wt.path)) {
      return fail('not_found', 'This worktree was not made by Agent Huddle.');
    }
    if (!(await isDirectory(record.path))) return fail('not_found', 'The worktree folder is gone.');
    return { ok: true, detail: record.path };
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Messages (ADR-020 §5)
  // -------------------------------------------------------------------------------------------------------------------

  /**
   * `agent.message` to the main agent of a live run that is idle (between turns): written to its stdin now
   * (`message.queued`, then `message.delivered via stream_input` once written). Returns null when it is not that
   * case, and the caller hands the message to the broker's outbox (a working root: note at the next tool call, or
   * the follow-up at the turn's end).
   */
  message(
    cmd: { agentKey: string; text: string; delivery: 'auto' | 'next_tool' | 'turn_end' },
    via?: 'phone',
  ): CommandResult | null {
    const state = this.deps.getState();
    const node = Object.hasOwn(state.agents, cmd.agentKey) ? state.agents[cmd.agentKey] : undefined;
    if (node?.kind !== 'main' || node.capabilities.message !== 'live' || isTerminal(node.status)) return null;
    const runId = node.run?.runId;
    const run = runId === undefined ? undefined : this.live.get(runId);
    if (run === undefined || run.exited || run.driver.state !== 'idle') return null;
    const text = cmd.text.trim();
    if (text === '') return fail('invalid', 'The message is empty.');
    const clipped = clip(text, CLIP_LIMITS.message);
    const messageId = this.deps.nextId();
    const sent = run.driver.send(clipped, messageId);
    if (!sent.ok) {
      return sent.reason === 'empty'
        ? fail('invalid', 'The message is empty.')
        : fail('expired', 'This run is ending, so the message was not sent.');
    }
    void this.emit(
      this.event('message.queued', node.sessionId, 'user', {
        messageId,
        text: clipped,
        delivery: cmd.delivery,
        ...(via !== undefined ? { via } : {}),
      }),
    );
    return { ok: true };
  }

  /**
   * The root's turn ended and the run is idle (driver `onIdle`, after the turn's `result` was reduced): every message
   * still in its outbox is written to stdin now, in queue order, joined into one user message, instead of waiting for
   * a tool call or a Stop that will not come before the next turn. A `next_tool` note that missed the last tool call is
   * the usual case; an `auto` or `turn_end` message queued after the turn's Stop was answered lands here too.
   *
   * Delivered once: the `message.delivered via stream_input` events are reduced synchronously right after the write is
   * handed to the driver, so the outbox is empty before any later hook (a PreToolUse of the next turn) is decided, and
   * the driver's `onDelivered` is not used for this write (ref null), so nothing is reported twice. A write the driver
   * refuses (stdin closed, stop asked for) leaves the outbox as it is; the messages are dropped at the run's exit.
   */
  private flushOutbox(run: LiveRun): void {
    if (run.exited || this.isClosing()) return;
    const state = this.deps.getState();
    const key = agentKey(run.sessionId);
    const root = Object.hasOwn(state.agents, key) ? state.agents[key] : undefined;
    if (root?.kind !== 'main' || root.run?.runId !== run.runId || root.capabilities.message === 'none') return;
    if (isTerminal(root.status)) return;
    const queued = root.outbox ?? [];
    if (queued.length === 0) return;
    const sent = run.driver.send(queued.map((m) => m.text).join(OUTBOX_JOIN), null);
    if (!sent.ok) {
      this.deps.logger.warn('queued messages were not written at the end of a turn', { reason: sent.reason });
      return;
    }
    void this.emit(
      ...queued.map((m) =>
        this.event('message.delivered', run.sessionId, 'huddle', { messageId: m.messageId, via: 'stream_input' }),
      ),
    );
    this.deps.logger.info('queued messages written at the end of a turn', { count: queued.length });
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Quit
  // -------------------------------------------------------------------------------------------------------------------

  /**
   * Quit (rule 5, never strand an agent; and no child outlives the Huddle): every live run's stdin is closed, so a
   * run between turns exits cleanly; a run still working after `graceMs` is ended hard. Resolves when each has exited
   * (or its kill was issued and the driver's own wait ran out). A launch still starting stops itself (`closing`).
   */
  async shutdown(graceMs: number): Promise<void> {
    this.closing = true;
    const runs = [...this.live.values()].filter((r) => !r.exited);
    await Promise.all(
      runs.map(async (run) => {
        run.driver.end();
        await Promise.race([run.driver.exited, sleep(graceMs)]);
        if (!run.exited) await run.driver.stop({ graceMs: 0 });
      }),
    );
  }
}
