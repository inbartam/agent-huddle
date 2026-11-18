/**
 * HuddleCore: the runtime the Electron main process hosts (M1: WP7/WP8/WP9 wiring, ADR-014, ADR-015, ADR-016).
 *
 * It owns the pieces and the order they run in; it adds no Claude Code knowledge of its own:
 *
 *   HookServer --(ParseHookResult / OTLP body, receivedAt)--> normalizeHook / normalizeTelemetry
 *     --> HuddleEvent[] --> reduce (in memory) --> SqliteEventStore.append (async, errors logged; M5)
 *                                             \-> listeners, in batches at most every `batchIntervalMs`
 *
 * Rules it keeps:
 *  - Everything is an event (CONTRIBUTING.md rule 1). The only state change is `this.state = reduce(this.state, e)`,
 *    including the rename command, which becomes a `control.applied` event.
 *  - Fail open (rule 5). A store failure is logged and can never reach the hook path. M3: the server asks
 *    `decideHook` (synchronous, no I/O) how to answer; the hook is normalized and reduced there first, then the broker
 *    (broker/) answers at once or holds. Every hold has four endings, each written as an event; on quit
 *    `releaseHeldResponses()` answers every hold with no decision before the server closes.
 *  - Detectors (F21) fold every live event (`accept`) and run a 15 s tick; replayed history is never fed to them.
 *  - Settings: huddle-settings.json is re-read before every write (desktop main writes preferences into it too).
 *  - Attach while running (ADR-014). The hooks go into settings.json only after the owner's consent, which is
 *    remembered as `consentedAt` in `<dataDir>/huddle-settings.json` once the shown change was applied, together with
 *    that change's `consentFingerprint` (ADR-019). With consent for the change a start would write, `start()` attaches
 *    by itself; a different change (say a new hook timeout) is shown again first.
 *    `dispose()` detaches (hooks removed, telemetry env vars kept). Without consent
 *    nothing under the Claude config folder is written, not even agent-huddle/config.json. `withdrawConsent()`
 *    forgets the consent and detaches.
 *  - Quit wins every race. Once `dispose()` is called, a start still in progress stops at its next step (no server,
 *    no attach, never `running`), and an attach that finishes after quit began detaches again at once. Dispose waits
 *    (bounded) for an attach in flight before deciding whether to detach.
 *  - Side effects stay here at the edge: the clock, token source, folders and logger are injected.
 *
 * Batching: the core batches events for `onEvents` listeners (default 100 ms). A desktop batcher on top is
 * harmless but not needed; pass `batchIntervalMs: 0` to hand batching to the desktop instead.
 *
 * Connection (ADR-017): `getState().connection` is setup status built here from the start result and
 * `setupStatus()`, never by the reducer. When it changes, listeners get a batch even if it carries no events
 * (an empty batch), so the UI knows to read the state again.
 */
import { randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  agentKey,
  applyUserSettingsPatch,
  budgetScopeOf,
  CLIP_LIMITS,
  DELETE_ALL_CONFIRM,
  OVERALL_BUDGET_LOWERED_WORDS,
  DEFAULT_USER_SETTINGS,
  selectDismissControl,
  selectPhoneView,
  phoneViewAgent,
  phoneViewHasApproval,
  phoneViewQuestion,
  PHONE_CONTROL_REASONS,
  PHONE_MESSAGE_DELIVERY,
  type PhoneAction,
  PHONE_DEFAULT_PORT,
  type PhoneView,
  type AgentKey,
  type AgentNode,
  type AskPreview,
  type AskTurn,
  type Budget,
  type CommandResult,
  type ConnectionStatus,
  type HuddleCommand,
  type HuddleEvent,
  type HuddleQuery,
  type HistoryDeleted,
  type HuddleState,
  type PolicyRule,
  type QueryResult,
  type TeamTemplate,
  type UserSettings,
} from '@huddle/shared';
import { Broker } from '../broker/broker.js';
import { isBrokerCommand, type RuleSubject, type RuleVerdict } from '../broker/model.js';
import { droppedByEnd } from '../broker/outbox.js';
import { parseBrokerCommand, settingsUpdateCommandSchema } from '../contracts/m3-schemas.js';
import { isM4Command, parseHuddleQuery, parseM4Command } from '../contracts/m4-schemas.js';
import { isM5Query, parseM5Command, parseM5Query } from '../contracts/m5-schemas.js';
import { isM6Command, isM6Query, parseM6Command, parseM6Query } from '../contracts/m6-schemas.js';
import { isOrchCommand, isOrchQuery } from '../contracts/orch-schemas.js';
import { PhoneHost, type PhoneHostDeps } from '../phone/phone-host.js';
import { maskPhoneView } from '../phone/view.js';
import { clip } from '../text.js';
import { maskSecrets } from '../privacy/redact.js';
import { decideByPolicy, policyInputOf } from '../policy/decide.js';
import { defaultPolicyRules } from '../policy/defaults.js';
import { previewRule } from '../policy/preview.js';
import {
  policyRuleProblem,
  policyRuleSaveProblem,
  preserveBadPolicyRulesFile,
  readPolicyRules,
  type PolicyRulesLoad,
  removePolicyRule,
  upsertPolicyRule,
  writePolicyRules,
  MAX_POLICY_RULES,
} from './policy-store.js';
import {
  emptyBudgetState,
  emptyDetectorState,
  seedBudgetState,
  step as detectStep,
  stepBudget,
  tick as detectTick,
  tickBudget,
  type BudgetAction,
  type BudgetState,
  type BudgetStep,
  type DetectorState,
} from '../detect/index.js';
import { carryOutBudgetAction, type StopRun } from './budget-runner.js';
import {
  EMPTY_LEAD_CHECK_MEMO,
  leadCheckSent,
  leadCheckStep,
  type LeadCheckMemo,
  type LeadCheckRequest,
} from './lead-check.js';
import { ASK_SYSTEM_PROMPT } from '../ingest/ask-cli.js';
import { buildAskContext } from '../report/ask-context.js';
import { AskGuard } from './ask-guard.js';
import { ASK_WORDS, AskRunner, refusalWords, type AskRunnerOptions } from './ask-runner.js';
import { RunHost, type RunLaunchOptions } from './runs.js';
import {
  MASKED_SECRET_EDITED,
  MAX_TEMPLATES,
  maskTemplateForDisplay,
  preserveBadTemplatesFile,
  readTemplates,
  removeTemplate,
  restoreMaskedPrompt,
  restoreMaskedPrompts,
  showsMaskedSecret,
  TEMPLATE_SECRET_WARNING,
  templateHoldsSecret,
  templateShowsMaskedSecret,
  upsertTemplate,
  writeTemplates,
} from './templates.js';
import {
  DEFAULT_HOOK_PORT,
  HookServer,
  PortInUseError,
  type AcceptedHook,
  type HookDecision,
  type HookServerStats,
} from '../ingest/hook-server.js';
import { createIdGenerator, type IdGenerator } from '../ingest/ids.js';
import { parseOtlpLogs } from '../ingest/otlp-schemas.js';
import type { ParseHookResult } from '../ingest/schemas.js';
import type { ParseStatuslineResult } from '../ingest/statusline-schema.js';
import { hookFacts } from '../normalize/hook-facts.js';
import { normalizeHook } from '../normalize/hooks.js';
import { normalizeStatusline } from '../normalize/statusline.js';
import { StatuslineThrottle } from './statusline-throttle.js';
import { normalizeTelemetry } from '../normalize/telemetry.js';
import { readAgentRoles, roleDescribedEvents } from '../setup/agent-roles.js';
import { McpRegistrar, type McpApplyResult, type McpRegistrarDeps } from '../setup/mcp-register.js';
import { HUDDLE_MCP_FILENAME } from '../ingest/huddle-mcp.js';
import {
  HOLD_TIMEOUT_S,
  HookInstaller,
  PERMISSION_TIMEOUT_S,
  formatDiff,
  stripBom,
  type ApplyResult,
  type DiffLine,
  type PreparedChange,
} from '../setup/install-hooks.js';
import { BUDGET_SESSION_ID, HISTORY_SESSION_ID, PHONE_SESSION_ID, TASKS_SESSION_ID } from '../state/huddle-sessions.js';
import { withNicknameFallback } from '../state/nicknames.js';
import { initialState, reduce, toHuddleState, type ReducerState } from '../state/reduce.js';
import { sessionOfAgentKey } from '../store/codec.js';
import {
  isValidSessionId,
  JsonlEventStore,
  MAX_AGENT_EVENTS,
  type JsonlEventStoreStats,
} from '../store/jsonl-store.js';
import { migrateJsonlToSqlite } from '../store/migrate-jsonl.js';
import { SqliteEventStore, type SqliteEventStoreStats } from '../store/sqlite-store.js';
import { HistoryService } from './history.js';
import { Orchestrator } from './orchestrator.js';
import { activeOverallBudgetSince, selectReplaySessions } from './replay-window.js';
import { migratedJsonlFolders, pickJsonlSessions } from './jsonl-prune.js';
import { reportPathFor } from './report-files.js';
import { removeTreeNoFollow } from './safe-remove.js';
import { RunRegistry } from './run-registry.js';
import {
  parseUserSettings,
  readHuddleSettings,
  sameSettingsFile,
  userSettingsOf,
  withoutConsent,
  withUserSettings,
  writeHuddleSettings,
  type HuddleSettings,
} from './huddle-settings.js';

/**
 * Seconds Claude Code waits for a held hook response, as the installer writes them (ADR-019). Feeds `expiresAt` on
 * approval requests. A timeout the user changed by hand (or with `--timeout`) is not reflected here.
 */
const HOOK_HOLD_TIMEOUTS_S: Readonly<Partial<Record<string, number>>> = {
  PreToolUse: HOLD_TIMEOUT_S,
  PermissionRequest: PERMISSION_TIMEOUT_S,
};

/** How often the detectors' time-based checks run (stuck agents, conflict windows, minute budgets). */
const DETECT_TICK_MS = 15_000;

/**
 * Session id the overall budget's `budget.set` events are filed under (they belong to no session). A file-name-safe
 * id that is never a Claude Code session id (those are UUIDs) and never becomes a node in the tree. Defined with the
 * Huddle's other own session ids in state/huddle-sessions.ts (the reducer needs them too).
 */
export { BUDGET_SESSION_ID, HISTORY_SESSION_ID, PHONE_SESSION_ID, TASKS_SESSION_ID };

/** How often the retention runs while the Huddle is open (M5 WP5): once a day, and once at every start. */
export const RETENTION_EVERY_MS = 24 * 60 * 60 * 1000;

/** A repeating timer for the retention: calls `run` every `everyMs`; returns a function that stops it. */
export type RetentionTimer = (run: () => void, everyMs: number) => () => void;

const defaultRetentionTimer: RetentionTimer = (run, everyMs) => {
  const timer = setInterval(run, everyMs);
  timer.unref();
  return () => {
    clearInterval(timer);
  };
};

/** `history.deleteAll` while the JSONL import still runs: the older history is still coming in. */
export const DELETE_WHILE_IMPORTING_MESSAGE =
  'Huddle is still bringing in older history. Try again when the History view no longer says so.';

/** Longest item id `attention.dismiss` takes (desktop main's ITEM_ID_MAX; detector ids carry paths). */
const DISMISS_ITEM_ID_MAX = 2100;

// ---------------------------------------------------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------------------------------------------------

/** Structured log sink. `data` never carries payload text, prompts or tokens. Must not throw. */
export interface HuddleLogger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

export const silentLogger: HuddleLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export interface HuddleCoreDeps {
  /**
   * The app's data folder (Electron userData). Holds `huddle.sqlite` (the event log, M5), `huddle-settings.json`, and
   * the M1-M4 `events/` folder until it is imported (then `events.migrated-<date>`).
   */
  dataDir: string;
  /** Claude Code's config folder (CLAUDE_CONFIG_DIR or ~/.claude). Tests pass a temp folder. */
  claudeConfigDir: string;
  /** Project folder whose `.claude/agents/*.md` describe roles. Null: project roles are skipped. */
  cwd: string | null;
  /** User agents folder, normally `<claudeConfigDir>/agents`. Null: user roles are skipped. */
  userAgentsDir: string | null;
  /** Port for hooks and telemetry. Defaults to 47821; 0 picks a free port (tests). */
  port?: number;
  /** Epoch milliseconds. Defaults to `Date.now`. Used for receivedAt, ids, rename events and consentedAt. */
  now?: () => number;
  /** The forwarder file shipped with the app (scripts/huddle-forward-hook.mjs in dev). Copied on attach. */
  forwarderSource: string;
  /**
   * The status line wrapper shipped with the app (scripts/huddle-statusline.mjs in dev). Copied when the owner opts in
   * to the status line bridge (F9). Absent: the option is refused.
   */
  statuslineSource?: string;
  /**
   * The self-report MCP server shipped with the app (M6 P4, F27; scripts/huddle-mcp.mjs in dev). Default: the file
   * `huddle-mcp.mjs` next to `forwarderSource` (both ship in scripts/ in dev and in the resources folder when packaged).
   * Managed runs copy it into their own folder; the opt-in registration for attached sessions copies it into
   * `<claudeConfigDir>/agent-huddle/`. A missing file only turns self-report off.
   */
  mcpServerSource?: string;
  /** Shown by the SessionStart hint when the Huddle is not running (e.g. the app's "remove hooks" command). */
  uninstallCommand?: string;
  logger?: HuddleLogger;
  /** Makes the ingest token when config.json has none. Defaults to 32 random bytes, base64url. */
  newToken?: () => string;
  /** Minimum gap between `onEvents` batches. Default 100 ms. */
  batchIntervalMs?: number;
  /** Upper bound for `dispose()`. Default 3000 ms. */
  disposeTimeoutMs?: number;
  /** How often the detectors' timer runs. Default 15 000 ms (tests use less). */
  detectTickMs?: number;
  /**
   * Stops a run the Huddle launched, for a budget whose action is stop or whose pause ran out (F19, ADR-020 §4).
   * Absent (the app): the core's own runs (M4 WP6, runtime/runs.ts). Tests replace it.
   */
  stopRun?: StopRun;
  /**
   * Is this managed run's process alive? The approval rules treat a session as managed only while it is (security
   * review 2026-11-14, L1). Absent (the app): the core's own runs (`RunHost.isAlive`). Tests that seed a
   * `run.launched` in the log replace it; start-up reconciliation then leaves the runs it calls live alone.
   */
  runIsLive?: (runId: string) => boolean;
  /**
   * Managed runs (M4 WP6): the claude command, spawn and kill (tests inject the fake claude), the base env, where
   * worktrees live (default %LOCALAPPDATA%/agent-huddle, never `dataDir`, which is the roaming folder), the git runner,
   * the run id source and the stop grace. The desktop app sets none of the harness-only fields (`claudeCommand`,
   * `settingsFile`, `skipAttachCheck`; see RunLaunchOptions): those are for the M4 exit harness and tests.
   */
  launch?: RunLaunchOptions;
  /**
   * Ask the Huddle (M5, F25): tests inject the fake claude (`claudeCommand`, `spawn`, `kill`), the env, a shorter
   * timeout and where the per-ask folder goes. The desktop app sets none of them (claude found on PATH, `process.env`,
   * ASK_TIMEOUT_MS, the OS temp folder).
   */
  ask?: Pick<
    AskRunnerOptions,
    'claudeCommand' | 'spawn' | 'kill' | 'env' | 'timeoutMs' | 'tempRoot' | 'stdoutMaxBytes'
  >;
  /**
   * Phone access (M6, F26): the phone page's folder (P3; absent: the API only), and test-only overrides (the network
   * adapters, the address rule so a test can bind 127.0.0.1, the auto-off timing, stream timing, the code's random
   * source). The desktop app sets only `staticDir`.
   */
  phone?: Pick<
    PhoneHostDeps,
    'staticDir' | 'interfaces' | 'addressCheck' | 'idleOffMs' | 'checkEveryMs' | 'server' | 'randomInt'
  >;
  /**
   * Self-report registration for attached sessions (M6 P4, F27): tests point `homeDir` at a temp folder and inject
   * the fake claude (`runClaude`, `claudeCommand`, `nodeCommand`) and the env. The desktop app sets none of them
   * (`os.homedir()`, claude and node found on PATH, `process.env`).
   */
  selfReportRegistrar?: Partial<
    Pick<McpRegistrarDeps, 'homeDir' | 'env' | 'runClaude' | 'claudeCommand' | 'nodeCommand'>
  >;
  /** How long quit gives a live run to exit after its stdin is closed before it is ended hard. Default 1500 ms. */
  runShutdownGraceMs?: number;
  /**
   * Tests only: Claude Code's hold timeouts as the broker counts them (default: the installed ones, ADR-019), so a pause
   * can reach its hold limit in a test without waiting ten minutes.
   */
  holdTimeoutsMs?: { permissionRequest: number; preToolUse: number };
  /**
   * M5 history (runtime/history.ts): how long after a run ends its report is written (default 1500 ms), and how many
   * sessions one start-up backfill pass derives (default 5000). Tests shorten or lower them.
   */
  history?: {
    reportDelayMs?: number;
    backfillMaxSessions?: number;
    backfillAtStart?: boolean;
    /** M5 WP7: the debounce before the ETA priors are computed again (default PRIORS_DELAY_MS, 2000 ms). */
    priorsDelayMs?: number;
    /**
     * M5 WP5: run the retention once in the background at start (default true) and then every `retentionEveryMs`
     * (default RETENTION_EVERY_MS) on `retentionTimer` (default a `setInterval`, unref'd). Tests pass their own timer.
     */
    retentionAtStart?: boolean;
    retentionEveryMs?: number;
    retentionTimer?: RetentionTimer;
    /** Most events one deletion transaction removes (default PRUNE_CHUNK_ROWS). */
    pruneChunkRows?: number;
  };
}

/** The first-run consent screen's content. The ingest token is shown as `<token>`. */
export interface AttachPreview {
  settingsPath: string;
  settingsExisted: boolean;
  /** False when the hooks are already in place exactly as they would be written. */
  changed: boolean;
  notes: string[];
  warnings: string[];
  diff: DiffLine[];
  /** `diff` as unified-style text with 3 lines of context. */
  diffText: string;
}

export interface SetupStatus {
  /** The owner agreed to attach while running (ADR-014). */
  consented: boolean;
  consentedAt: string | null;
  /** The Huddle's hooks are in settings.json, put there by this run. */
  attached: boolean;
  settingsPath: string;
  /** The port the server listens on, or null when it is not listening. */
  port: number | null;
  /** The change waiting for consent (first run, or after a `stale` result), else null. */
  preparedDiff: AttachPreview | null;
  /** The last attach or prepare problem, in words the UI can show, else null. */
  error: string | null;
}

export type StartResult =
  | { ok: true; port: number; setup: SetupStatus }
  /** The port is taken (usually another running Agent Huddle). Replayed history is still available through getState(). */
  | { ok: false; code: 'port_in_use'; port: number; message: string }
  | { ok: false; code: 'failed'; message: string };

/** Options for the first-run change. */
export interface AttachOptions {
  /** F9: also install the status line bridge (default false). */
  statusLine?: boolean;
}

export type PrepareAttachResult = { ok: true; preview: AttachPreview } | { ok: false; error: string };

/** `notes` (F9): what happened to the status line bridge, e.g. that a line the user changed was left alone. */
export type WithdrawResult = { ok: true; notes?: string[] } | { ok: false; error: string };

export type AttachResult =
  | { status: 'attached'; written: boolean }
  /** settings.json changed the Huddle's part since the preview: show `preview` and ask again. */
  | { status: 'stale'; preview: AttachPreview }
  | { status: 'error'; error: string };

export interface HuddleCoreStats {
  server: HookServerStats | null;
  /** SQLite (M5); JSONL only when the database could not be opened (`storeKind`). */
  store: SqliteEventStoreStats | JsonlEventStoreStats;
  storeKind: 'sqlite' | 'jsonl-fallback';
  unrecognizedHooks: number;
  unrecognizedTelemetry: number;
  /** Status line bodies that failed validation (F9). */
  unrecognizedStatusline: number;
  storeErrors: number;
  listenerErrors: number;
  /** Events handed in during shutdown after the background work was waited for: dropped, the log is closing. */
  eventsDroppedAtClose: number;
}

export type HuddleEventsListener = (batch: readonly HuddleEvent[]) => void;

// ---------------------------------------------------------------------------------------------------------------------

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{8,}$/;
const DEFAULT_BATCH_MS = 100;
const DEFAULT_DISPOSE_MS = 3000;
/** Share of the dispose budget the server gets to answer in-flight requests before connections are cut. */
const SERVER_CLOSE_MS = 1000;
/** Default for `runShutdownGraceMs`. */
const DEFAULT_RUN_SHUTDOWN_GRACE_MS = 1500;
/** Message for work refused or abandoned because quit has begun. */
const SHUTTING_DOWN = 'Agent Huddle is shutting down.';
/** A phone Allow refused because the summary hides part of the command (AX-01). */
const PHONE_HIDDEN_ALLOW = 'Answer this one on the computer.';

type Phase = 'new' | 'starting' | 'running' | 'failed' | 'disposing' | 'disposed';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clipText(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function plural(n: number, one: string, many: string): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

/** "Deleted 212 runs, 34 reports and the older history folder." (M5 WP5; DESIGN "History deleted: …"). */
export function deletedWords(deleted: HistoryDeleted, all: boolean): string {
  const parts = [plural(deleted.runs, 'run', 'runs'), plural(deleted.reports, 'report', 'reports')];
  if (all) parts.push(plural(deleted.folders, 'older history folder', 'older history folders'));
  const last = parts.pop() ?? '';
  const words = `Deleted ${parts.length > 0 ? `${parts.join(', ')} and ${last}` : last}.`;
  return deleted.overallBudgetLowered === true ? `${words} ${OVERALL_BUDGET_LOWERED_WORDS}` : words;
}

type PruneJob = { kind: 'retention'; days: number } | { kind: 'delete_all' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isoOf(ms: number): string {
  return new Date(Number.isFinite(ms) ? ms : 0).toISOString();
}

/**
 * The event log (M5): SQLite at `<dataDir>/huddle.sqlite`. Fail open: when the database cannot be opened (a file from
 * a newer Huddle, a damaged or locked file) the Huddle still starts, on the M1-M4 JSONL log in `<dataDir>/events`, and
 * says so in the log and in `stats().storeKind`. A later start that can open the database imports those lines
 * (migrate-jsonl.ts). The file is never replaced or deleted here.
 */
function openEventStore(dataDir: string, logger: HuddleLogger): SqliteEventStore | JsonlEventStore {
  const root = path.resolve(dataDir);
  try {
    // 500 ms, not the store's 5000 ms default: node:sqlite waits for a lock synchronously, on the main thread that
    // also answers hooks (budget 20 ms). Another connection holding a write lock (a second Huddle on this folder,
    // a backup tool) may stall hook answers this long at most; then the write fails, is logged, and the event stays
    // in memory (fail open).
    return new SqliteEventStore({ file: path.join(root, 'huddle.sqlite'), busyTimeoutMs: 500 });
  } catch (error) {
    logger.error('could not open the event database; recording to the JSONL log instead', { error: messageOf(error) });
    return new JsonlEventStore({ baseDir: path.join(root, 'events') });
  }
}

/** Resolves 'done' or 'timeout'; never rejects (a rejection counts as done and is reported to `onError`). */
function within(work: Promise<unknown>, ms: number, onError: (error: unknown) => void): Promise<'done' | 'timeout'> {
  return new Promise((resolve) => {
    const timer = setTimeout(
      () => {
        resolve('timeout');
      },
      Math.max(0, ms),
    );
    timer.unref();
    work.then(
      () => {
        clearTimeout(timer);
        resolve('done');
      },
      (error: unknown) => {
        clearTimeout(timer);
        onError(error);
        resolve('done');
      },
    );
  });
}

/** docs/DESIGN.md "Words": what happened and what to do. */
export function portInUseMessage(port: number): string {
  return `Port ${String(port)} is in use, probably by another Agent Huddle or another program. Close it and restart Huddle.`;
}

/** docs/DESIGN.md "Words", the empty state for hooks not installed. */
export const NEEDS_CONSENT_MESSAGE =
  "Huddle isn't connected to Claude Code yet. Review the change it makes to your settings.";

/** `run.launch` without attached hooks (ADR-020 §1). */
export const LAUNCH_NEEDS_ATTACH_MESSAGE =
  "Huddle isn't connected to Claude Code yet. Connect first: a launched run reports to Huddle through the hooks in your Claude Code settings.";

/** M5 history questions and report commands on the JSONL fallback (the database could not be opened). */
/** L4 (M5 security review): a lower retention deletes runs, so it carries the count the user saw. */
export const RETENTION_CONFIRM_MISSING =
  'Lowering how long history is kept deletes older runs. Check how many first, then confirm.';
export function retentionConfirmChanged(runs: number): string {
  return `The runs to delete changed since you checked: now ${plural(runs, 'run', 'runs')}. Check again, then confirm.`;
}
/** Delete all on the JSONL fallback (M1): what it could not reach. */
export const JSONL_DELETE_ALL_NOTE = 'The event database could not be opened, so anything it holds was not deleted.';
const DAY_MS = 86_400_000;

export const NO_HISTORY_MESSAGE =
  "History isn't available: Huddle couldn't open its database and is recording to the older log. Restart Huddle to try again.";

/** `setup.attach` came back stale: the first-run screen shows this above the refreshed change. */
export const SETTINGS_CHANGED_MESSAGE =
  'Your Claude Code settings changed since this was shown. Review the updated change.';

function previewOf(change: PreparedChange): AttachPreview {
  return {
    settingsPath: change.settingsPath,
    settingsExisted: change.settingsExisted,
    changed: change.plan.changed,
    notes: [...change.plan.notes],
    warnings: [...change.plan.warnings],
    diff: change.diff,
    diffText: formatDiff(change.diff),
  };
}

// ---------------------------------------------------------------------------------------------------------------------

export class HuddleCore {
  private readonly deps: HuddleCoreDeps;
  private readonly logger: HuddleLogger;
  private readonly now: () => number;
  private readonly nextId: IdGenerator;
  /** See `openEventStore`: SQLite, or the JSONL log when the database cannot be opened. */
  private readonly store: SqliteEventStore | JsonlEventStore;
  private readonly installer: HookInstaller;
  /** The opt-in `claude mcp add --scope user` step for attached sessions (F27, ADR-025). */
  private readonly mcpRegistrar: McpRegistrar;
  private readonly batchIntervalMs: number;

  private phase: Phase = 'new';
  private state: ReducerState = initialState();
  /** Newest events per agent (at most MAX_AGENT_EVENTS each), so `getEvents` can answer synchronously. */
  private readonly recent = new Map<AgentKey, HuddleEvent[]>();
  /** (session, folder) pairs whose agent definitions were read, keyed by `describeKey`. */
  private readonly describedRoots = new Set<string>();
  /** Drops repeated status line readings before they are stored (F9; see statusline-throttle.ts). */
  private readonly statuslineThrottle = new StatuslineThrottle();
  /** Epoch ms when `start()` began; reported in `connection.startedAt` so the UI can mark replayed sessions stale. */
  private startedAt: number | null = null;
  /** Background work (role reads, event writes) that dispose waits for before closing the store. */
  private readonly inFlight = new Set<Promise<unknown>>();

  private readonly listeners = new Set<HuddleEventsListener>();
  private queue: HuddleEvent[] = [];
  private emitTimer: NodeJS.Timeout | null = null;

  private server: HookServer | null = null;
  private port: number | null = null;
  private token: string | null = null;
  private settings: HuddleSettings = { consentedAt: null, consentedFor: null, consentedFingerprint: null, extra: {} };
  /** The user's settings (M3), from `settings.preferences`; refreshed on every read of the file. */
  private userSettings: UserSettings = DEFAULT_USER_SETTINGS;
  /** The lead check on idle teammates (M6 P5b, ADR-027): what was asked, in memory only (lead-check.ts). */
  private leadCheck: LeadCheckMemo = EMPTY_LEAD_CHECK_MEMO;
  /**
   * Is the Huddle's MCP server registered for attached sessions (`claude mcp add --scope user huddle`, F27)? Read from
   * `.claude.json` off the hook path: at start, after a register or unregister, after consent is withdrawn, and with
   * each registration preview. Null until the first read finished (counts as not registered).
   */
  private huddleMcpRegistered: boolean | null = null;
  /** Writes of huddle-settings.json run one after another; each re-reads the file first (two writers: core, main). */
  private settingsQueue: Promise<unknown> = Promise.resolve();
  /**
   * The approval rules (M4, F18), from policy-rules.json (read at start; the default set until then and when the file
   * is missing or bad). This core is the file's only writer; changes are written first, then adopted.
   */
  private policyRules: PolicyRule[] = defaultPolicyRules();
  /** A2-02: the rules file on disk was not used and must be moved aside before the next save. */
  private policyFileBad = false;
  /** A2-02: the rules file could not be read; no save until a later read succeeds. */
  private policyReadFailed = false;
  /** A2-02: shown in the state as `policyWarning`. */
  private policyWarning: string | null = null;
  /** Writes of policy-rules.json run one after another. */
  private policyQueue: Promise<unknown> = Promise.resolve();
  /** The team templates (M4, F16/F17), from templates.json (read at start; empty until then and for a bad file). */
  private templates: TeamTemplate[] = [];
  /** templates.json exists but was not used: it is moved aside before the first write, never overwritten. */
  private templatesFileBad = false;
  /** Writes of templates.json run one after another. */
  private templatesQueue: Promise<unknown> = Promise.resolve();
  /** The runs this Huddle launched (M4 WP6): their drivers, worktrees and commands. */
  private readonly runs: RunHost;
  /** F28 skills and F29 tasks (runtime/orchestrator.ts). */
  private readonly orch: Orchestrator;
  /** Holds, timers and the hook decisions of M3 (F10-F13). */
  private readonly broker: Broker;
  /** M5 (F22-F24): history, replay, reports and scorecards. Null on the JSONL fallback (no database). */
  private readonly history: HistoryService | null;
  /** The JSONL import is running (`history.list`'s "Bringing in older history…"). */
  private importing = false;
  /** Ask the Huddle (M5, F25): the one-shot read-only `claude -p`, one at a time. */
  private readonly asker: AskRunner;
  /** Phone access (M6, F26). */
  private readonly phone: PhoneHost;
  /** Keeps the ask's own session out of the tree (ask-guard.ts). */
  private readonly askGuard = new AskGuard();
  /** Retention and "delete all history" run one at a time (M5 WP5). */
  private pruneQueue: Promise<unknown> = Promise.resolve();
  /** Stops the daily retention timer; null while none runs. */
  private stopRetentionTimer: (() => void) | null = null;
  /** Hook results already normalized inside `decideHook`, so `onHook` does not normalize them twice. */
  private readonly normalizedEarly = new WeakSet<object>();
  /**
   * Detector fold (F21). Starts empty and sees only live events: replayed history is never fed in, so sessions from
   * before this run are not flagged as stuck the moment the Huddle starts.
   */
  private detectors: DetectorState = emptyDetectorState();
  /**
   * Budget detector (F19): live events only, like the others; seeded after replay from the inbox, so a budget already
   * flagged (and acted on) before a restart is not flagged or acted on again.
   */
  private budgetDetector: BudgetState = emptyBudgetState();
  private detectTimer: NodeJS.Timeout | null = null;
  private attached = false;
  private pendingChange: PreparedChange | null = null;
  private setupError: string | null = null;

  private startPromise: Promise<StartResult> | null = null;
  /** The settled start result, once `start()` has finished. */
  private startResult: StartResult | null = null;
  /** `connection` as listeners last saw it (JSON), to emit an empty batch only when it changes. */
  private lastConnection = JSON.stringify(null);
  private connectionDirty = false;
  private disposePromise: Promise<void> | null = null;
  /** Set the moment `dispose()` is called, before it waits for anything: start and attach check it after every await. */
  private disposeRequested = false;
  /** The attach (start-time or Connect) that is writing settings.json right now, if any. */
  private attachInFlight: Promise<unknown> | null = null;
  private readonly counters = {
    unrecognizedHooks: 0,
    unrecognizedTelemetry: 0,
    unrecognizedStatusline: 0,
    storeErrors: 0,
    listenerErrors: 0,
    eventsDroppedAtClose: 0,
  };
  /** Set in dispose once the background work is done, before the store closes: accept() drops what comes later. */
  private storeClosing = false;

  constructor(deps: HuddleCoreDeps) {
    this.deps = deps;
    this.logger = deps.logger ?? silentLogger;
    this.now = deps.now ?? Date.now;
    this.nextId = createIdGenerator({ now: this.now });
    this.batchIntervalMs = Math.max(0, deps.batchIntervalMs ?? DEFAULT_BATCH_MS);
    this.store = openEventStore(deps.dataDir, this.logger);
    this.installer = new HookInstaller({
      configDir: deps.claudeConfigDir,
      now: () => new Date(this.now()),
      newToken: () => this.token ?? this.makeToken(),
      forwarderSource: deps.forwarderSource,
      ...(deps.statuslineSource !== undefined ? { statuslineSource: deps.statuslineSource } : {}),
      ...(deps.uninstallCommand !== undefined ? { uninstallCommand: deps.uninstallCommand } : {}),
    });
    this.mcpRegistrar = new McpRegistrar({
      configDir: deps.claudeConfigDir,
      homeDir: deps.selfReportRegistrar?.homeDir ?? os.homedir(),
      serverSource: this.mcpServerSource(),
      ...(deps.selfReportRegistrar?.env !== undefined ? { env: deps.selfReportRegistrar.env } : {}),
      ...(deps.selfReportRegistrar?.runClaude !== undefined ? { runClaude: deps.selfReportRegistrar.runClaude } : {}),
      ...(deps.selfReportRegistrar?.claudeCommand !== undefined
        ? { claudeCommand: deps.selfReportRegistrar.claudeCommand }
        : {}),
      ...(deps.selfReportRegistrar?.nodeCommand !== undefined
        ? { nodeCommand: deps.selfReportRegistrar.nodeCommand }
        : {}),
    });
    this.broker = new Broker({
      now: this.now,
      nextId: this.nextId,
      getState: () => this.state,
      questionHoldSeconds: () => this.userSettings.questionHoldSeconds,
      huddleStartedAt: () => this.startedAt,
      timeouts: deps.holdTimeoutsMs ?? {
        permissionRequest: PERMISSION_TIMEOUT_S * 1000,
        preToolUse: HOLD_TIMEOUT_S * 1000,
      },
      accept: (events) => {
        void this.accept(events);
      },
      warn: (message, data) => {
        this.logger.warn(message, data);
      },
      // Ending 2 (F18): synchronous and pure over the rules and settings in memory; the raw facts never leave here.
      ruleDecision: (subject) => this.ruleDecision(subject),
      // L1 (security review 2026-11-14): a session counts as managed for the rules only while its run's process lives.
      runLive: (runId) => (deps.runIsLive ?? ((id: string) => this.runs.isAlive(id)))(runId),
    });
    this.runs = new RunHost({
      dataDir: deps.dataDir,
      now: this.now,
      nextId: this.nextId,
      getState: () => this.state,
      accept: (events) => this.accept(events),
      track: (work) => this.track(work),
      logger: this.logger,
      launchRefusal: () => this.launchRefusal(),
      ...(deps.launch !== undefined ? { options: deps.launch } : {}),
      ...(deps.runIsLive !== undefined ? { runIsLive: deps.runIsLive } : {}),
      storedRunEvents: (runId) => this.storedRunEvents(runId),
      selfReport: {
        serverSource: this.mcpServerSource(),
        enabled: () => this.userSettings.selfReport?.enabled ?? true,
      },
    });
    this.orch = new Orchestrator({
      state: () => toHuddleState(this.state),
      templates: () => this.templates,
      accept: (events) => this.accept(events),
      nextId: this.nextId,
      now: this.now,
      launch: (template, templateId, override) => this.runs.launch(template, templateId, override),
      skills: { claudeConfigDir: deps.claudeConfigDir, homeDir: os.homedir() },
    });
    this.asker = new AskRunner({
      now: this.now,
      logger: this.logger,
      // L1 (M5 security review): only the key names of settings.json, read-only, through the installer's reader.
      readClaudeSettingsKeys: () => this.installer.readAskRelevantKeys(),
      ...deps.ask,
    });
    this.phone = new PhoneHost({
      dataDir: deps.dataDir,
      now: this.now,
      nextId: this.nextId,
      accept: (events) => this.accept(events),
      logger: this.logger,
      view: () => this.phoneView(),
      decide: (requestId, decision) => this.phoneDecide(requestId, decision),
      act: (action) => this.phoneAct(action),
      saveChoice: (ip, port) => this.savePhoneChoice(ip, port),
      ...deps.phone,
    });
    const store = this.store;
    this.history =
      store instanceof SqliteEventStore
        ? new HistoryService({
            store,
            dataDir: deps.dataDir,
            now: this.now,
            logger: this.logger,
            liveState: () => this.state,
            startedAt: () => this.startedAt,
            settings: () => this.userSettings,
            migrating: () => this.importing,
            track: (work) => this.track(work),
            exclude: [BUDGET_SESSION_ID, HISTORY_SESSION_ID, PHONE_SESSION_ID, TASKS_SESSION_ID],
            keep: [BUDGET_SESSION_ID, TASKS_SESSION_ID],
            budgetSessionId: BUDGET_SESSION_ID,
            isRunLive: (runId) => (deps.runIsLive ?? ((id: string) => this.runs.isAlive(id)))(runId),
            ...(deps.history?.pruneChunkRows !== undefined ? { pruneChunkRows: deps.history.pruneChunkRows } : {}),
            ...(deps.history?.reportDelayMs !== undefined ? { reportDelayMs: deps.history.reportDelayMs } : {}),
            ...(deps.history?.backfillMaxSessions !== undefined
              ? { backfillMaxSessions: deps.history.backfillMaxSessions }
              : {}),
            ...(deps.history?.priorsDelayMs !== undefined ? { priorsDelayMs: deps.history.priorsDelayMs } : {}),
            // M5 WP7: `getState().priors` changed; listeners get an empty batch ("read the state again").
            onPriorsChanged: () => {
              this.connectionDirty = true;
              this.scheduleEmit();
            },
          })
        : null;
  }

  /** The self-report server script shipped with the app (HuddleCoreDeps.mcpServerSource). */
  private mcpServerSource(): string {
    return this.deps.mcpServerSource ?? path.join(path.dirname(this.deps.forwarderSource), HUDDLE_MCP_FILENAME);
  }

  /**
   * ADR-020 §1: a launched run reports to the Huddle only through the hooks in the user's Claude Code settings (never
   * `--settings`), so launching needs them attached, with consent, and the server running.
   */
  private launchRefusal(): string | null {
    if (this.phase !== 'running' || this.quitting()) {
      return 'Agent Huddle is not receiving events right now, so it cannot launch a run.';
    }
    // Exit harness only (RunLaunchOptions.skipAttachCheck): its per-run `--settings` file brings the hooks.
    if (this.deps.launch?.skipAttachCheck === true) return null;
    if (!this.attached || !this.hasConsent()) return LAUNCH_NEEDS_ATTACH_MESSAGE;
    return null;
  }

  /** The approval rules (F18) for a permission request: managed sessions always, attached ones only when enabled. */
  private ruleDecision(subject: RuleSubject): RuleVerdict | null {
    if (subject.facts === null) return null;
    const outcome = decideByPolicy(
      this.policyRules,
      this.userSettings.policy,
      policyInputOf(subject.facts, subject.node, subject.sessionCwd),
      subject.managedRunLive,
    );
    return outcome === null ? null : { decision: outcome.decision, ruleId: outcome.ruleId, message: outcome.message };
  }

  /** The user's settings as the core uses them now (question window, detector thresholds). */
  getUserSettings(): UserSettings {
    return this.userSettings;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------------------------------------------------

  /**
   * Replays the event log, starts the server and, with consent on record, attaches the hooks.
   * Never rejects: problems come back as `{ ok: false }`. Calling it again returns the same result.
   */
  start(): Promise<StartResult> {
    this.startPromise ??= this.runStart().then((result) => {
      this.startResult = result;
      this.noteConnection();
      return result;
    });
    return this.startPromise;
  }

  private async runStart(): Promise<StartResult> {
    if (this.phase !== 'new' || this.quitting()) return { ok: false, code: 'failed', message: SHUTTING_DOWN };
    this.phase = 'starting';
    this.startedAt = this.now();
    const abandoned = (): StartResult => ({ ok: false, code: 'failed', message: SHUTTING_DOWN });
    try {
      this.adoptSettings(await readHuddleSettings(this.deps.dataDir));
      if (this.quitting()) return abandoned();
      this.adoptPolicyLoad(await readPolicyRules(this.deps.dataDir));
      const templates = await readTemplates(this.deps.dataDir);
      this.templates = templates.templates;
      this.templatesFileBad = templates.bad;
      if (templates.warning !== null) this.logger.warn(templates.warning);
      // L1: what settings.json says about the ask's credential and provider (key names only), for HuddleState.ask.
      await this.asker.refreshClaudeSettings();
      // No run is live yet: any `--agents` file still on disk was left by a crash (L4).
      await this.runs.sweepAgentFiles();
      if (this.quitting()) return abandoned();
      await this.importJsonlHistory();
      if (this.quitting()) return abandoned();
      await this.replayStore();
      if (this.quitting()) return abandoned();
      // M6: the paired phones (phone-devices.json) are announced; phone access itself stays off until turned on.
      await this.phone.start();
      this.budgetDetector = seedBudgetState(this.state);
      this.callOffEarlierPauses();
      this.token = await this.resolveToken();
      if (this.quitting()) return abandoned();

      const requestedPort = this.deps.port ?? DEFAULT_HOOK_PORT;
      const server = new HookServer({
        token: this.token,
        port: requestedPort,
        now: this.now,
        closeTimeoutMs: SERVER_CLOSE_MS,
        onHook: (result, receivedAt) => {
          this.onHook(result, receivedAt);
        },
        onTelemetryLogs: (body, receivedAt) => {
          this.onTelemetryLogs(body, receivedAt);
        },
        onStatusline: (result, receivedAt) => {
          this.onStatusline(result, receivedAt);
        },
        onHandlerError: (error) => {
          this.logger.error('event handler failed', { error: messageOf(error) });
        },
        decideHook: (result, receivedAt) => this.decideHook(result, receivedAt),
        onHoldRefused: (result, _receivedAt, why) => {
          // Fail open: the server already answered with no decision. Record the ending; it may mean 64 holds are open.
          this.logger.warn('hold refused, answered with no decision', { why });
          this.broker.holdRefused(result, why);
        },
      });
      try {
        const { port } = await server.start();
        if (this.quitting()) {
          // Quit began while the port was opening: close it here. The server is only published once it is up and
          // quit has not begun, so dispose never closes a server that is still starting.
          await server.close();
          return abandoned();
        }
        this.server = server;
        this.port = port;
      } catch (error) {
        this.server = null;
        if (error instanceof PortInUseError) {
          // Never attach here: the hooks would point at whoever owns the port.
          this.phase = 'failed';
          const message = portInUseMessage(error.port);
          this.setupError = message;
          this.logger.error('port in use', { port: error.port });
          return { ok: false, code: 'port_in_use', port: error.port, message };
        }
        throw error;
      }
      // Runs a crash left behind (runs.json, and replayed runs without run.exited): stopped when verified to be ours,
      // then ended in the log, so they stop looking alive and their worktrees can be discarded. After the bind, so a
      // second Huddle on this data folder (it fails on the port) never touches the first one's runs; before `running`,
      // so no launch can race it.
      try {
        await this.runs.reconcileOrphans();
      } catch (error) {
        this.logger.error('could not reconcile runs from an earlier start', { error: messageOf(error) });
      }
      if (this.quitting()) return abandoned();
      this.phase = 'running';
      this.logger.info('listening', { port: this.port });
      // M6 P5b: whether attached sessions have the Huddle MCP server, read once now, in the background (never on a hook).
      this.refreshMcpRegistered();
      this.startDetectTimer();
      // M5: derive the stored runs that have no current derivation (migrated history, a newer build), in the
      // background and in small steps (runtime/history.ts). The scorecards wait for it.
      if (this.deps.history?.backfillAtStart !== false) void this.history?.backfill();
      // M5 WP5: the retention, once now in the background (after the replay; alongside the backfill) and once a day.
      this.startRetention();

      if (this.hasConsent()) await this.autoAttach();
      else await this.prepareAttach();
      if (this.quitting()) return abandoned();
      return { ok: true, port: this.port, setup: this.setupStatus() };
    } catch (error) {
      if (this.phase === 'starting') this.phase = 'failed';
      const message = `Agent Huddle could not start: ${messageOf(error)}`;
      this.setupError = message;
      this.logger.error('start failed', { error: messageOf(error) });
      return { ok: false, code: 'failed', message };
    }
  }

  /**
   * Quit. Order: release held hook responses -> detach the hooks (telemetry env kept) -> close the
   * server (in-flight requests are answered) -> deliver the last batch -> flush and close the store.
   * Idempotent, never rejects, and bounded by `disposeTimeoutMs` (default 3 s) so quitting never hangs.
   */
  dispose(): Promise<void> {
    this.disposePromise ??= this.runDispose();
    return this.disposePromise;
  }

  /** A call, not a field read, so TypeScript does not narrow it across the awaits where it can change. */
  private quitting(): boolean {
    return this.disposeRequested;
  }

  private async runDispose(): Promise<void> {
    const budget = Math.max(0, this.deps.disposeTimeoutMs ?? DEFAULT_DISPOSE_MS);
    const started = performance.now();
    const left = (): number => Math.max(0, budget - (performance.now() - started));
    const report = (step: string) => (error: unknown) => {
      this.logger.error(`dispose: ${step} failed`, { error: messageOf(error) });
    };
    const step = async (name: string, work: () => Promise<unknown>, cap = Infinity): Promise<void> => {
      const outcome = await within(Promise.resolve().then(work), Math.min(cap, left()), report(name));
      if (outcome === 'timeout') this.logger.warn(`dispose: ${name} timed out`);
    };

    // From here on, start and attach stop at their next step, and an attach that still lands detaches itself.
    this.disposeRequested = true;
    // M5: no report or backfill step starts any more; one in progress is waited for with the other background work.
    // A report still waiting for its delay is made when the run is next opened.
    this.history?.dispose();
    // M5 (F25): an ask in flight ends now (its process tree is killed; its folder is removed with the background work).
    this.asker.cancel('cancelled');
    // A start still in progress gets a moment to stop at its next check.
    if (this.startPromise) await step('start', () => this.startPromise ?? Promise.resolve(), budget / 4);
    this.phase = 'disposing';

    this.stopDetectTimer();
    this.stopRetentionTimer?.();
    this.stopRetentionTimer = null;
    // 0. M6: phone access closes first, so no phone decides while the holds are being released; its streams end.
    await step('close phone access', () => this.phone.shutdown());
    // 1. M3: every held hook response is released with an empty 200 *before* the port closes.
    await step('release held responses', () => this.releaseHeldResponses());
    // 1b. M4: no managed run outlives the Huddle. Stdin is closed (a run between turns exits cleanly, and its SessionEnd
    //     still reaches the open port); a run still working after the grace is ended hard. Their run.exited events are
    //     written while the log is open.
    const grace = Math.max(0, this.deps.runShutdownGraceMs ?? DEFAULT_RUN_SHUTDOWN_GRACE_MS);
    await step('stop managed runs', () => this.runs.shutdown(Math.min(grace, left() / 2)));
    // 2. An attach writing settings.json right now finishes first (it detaches itself, see `guardAttach`), so the
    //    decision below sees the file as it is.
    const attaching = this.attachInFlight;
    if (attaching) await step('finish attach', () => attaching, budget / 4);
    // 3. Detach, so sessions stop calling a port that is about to close.
    if (this.attached) await step('detach', () => this.detach(), budget / 2);
    // 4. Close the server; requests in flight still get their answer.
    const server = this.server;
    if (server) await step('close server', () => server.close());
    // 5. Let queued writes and role reads finish, then hand the last batch to listeners.
    //    Work that finishes can start more (a write's follow-up), so wait until none is left (bounded by the budget).
    await step('finish background work', async () => {
      while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
    });
    // From here on a late batch (a request answered during close) is dropped and counted, not written to a closing log.
    this.storeClosing = true;
    this.flushListeners();
    this.listeners.clear();
    // 6. Flush the event log.
    await step('close store', () => this.store.close());
    this.phase = 'disposed';
  }

  /**
   * Ending 4 (broker rules): every held response is answered with no decision (empty 200) and its ending is written
   * (`by: 'shutdown'`, `question.closed shutdown`, `hold.ended shutdown`) while the log is still open. No hold starts
   * afterwards. Then the server releases anything the broker did not know about (none expected).
   */
  private releaseHeldResponses(): Promise<void> {
    this.broker.shutdown();
    const left = this.server?.releaseAll() ?? 0;
    if (left > 0) this.logger.warn('released holds the broker did not know', { count: left });
    return Promise.resolve();
  }

  private startDetectTimer(): void {
    if (this.detectTimer !== null) return;
    const every = Math.max(10, this.deps.detectTickMs ?? DETECT_TICK_MS);
    this.detectTimer = setInterval(() => {
      try {
        const now = this.now();
        const out = detectTick(this.detectors, now, this.userSettings.detectors, this.userSettings.roleKinds ?? null);
        this.detectors = out.state;
        void this.accept(out.emit);
        // Minute budgets run out with no event at all.
        const budget = this.takeBudgetStep(tickBudget(this.budgetDetector, this.state, now, this.startedAt));
        void this.accept(budget.emit);
        this.carryOutBudget(budget.actions);
      } catch (error) {
        this.logger.error('detector tick failed', { error: messageOf(error) });
      }
    }, every);
    this.detectTimer.unref();
  }

  private stopDetectTimer(): void {
    if (this.detectTimer === null) return;
    clearInterval(this.detectTimer);
    this.detectTimer = null;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // CoreHost surface
  // -------------------------------------------------------------------------------------------------------------------

  /** The state the UI sees, with setup status in `connection` (ADR-017). Bookkeeping never crosses IPC (ADR-016). */
  getState(): HuddleState {
    const state = {
      // M5 WP5: an agent whose rename events were deleted keeps the nickname copied into the settings (state/nicknames.ts).
      ...toHuddleState(withNicknameFallback(this.state, this.userSettings.nicknames)),
      policy: this.policyRules.map((r) => ({ ...r, match: { ...r.match } })),
      policyWarning: this.policyWarning,
      // M5 WP5 (L4): prompts leave the core masked; templates.json and the launch keep the text as typed.
      templates: this.templates.map((t) => maskTemplateForDisplay(structuredClone(t))),
      // M5 WP6 (F25): what the Ask pane needs before it asks; filled here, not by the reducer (like `connection`).
      ask: {
        enabled: this.userSettings.ask.enabled,
        apiKeySet: this.asker.apiKeySet(),
        otherProvider: this.asker.otherProvider(),
        busy: this.asker.busy,
      },
    };
    // M5 WP7 (F24 -> F4): the ETA priors from the scorecards, cached by the history service; absent until computed.
    const priors = this.history?.priors() ?? null;
    const withPriors =
      priors === null ? state : { ...state, priors: { ...priors, byRoleModel: { ...priors.byRoleModel } } };
    const connection = this.connection();
    return connection ? { ...withPriors, connection } : withPriors;
  }

  /**
   * ADR-017. Null until `start()` has settled. Precedence: a failed start (port in use, error), then attached,
   * then a change waiting for consent, then any setup error. Messages use docs/DESIGN.md's words, and every
   * string is scrubbed of the ingest token (the diff already shows it as `<token>`).
   */
  private connection(): ConnectionStatus | null {
    const status = this.connectionStatus();
    return status && this.startedAt !== null ? { ...status, startedAt: this.startedAt } : status;
  }

  private connectionStatus(): ConnectionStatus | null {
    const started = this.startResult;
    // Not started yet, or shutting down: no setup status to show.
    if (!started || this.phase === 'disposing' || this.phase === 'disposed') return null;
    if (!started.ok) {
      return {
        status: started.code === 'port_in_use' ? 'port_in_use' : 'error',
        message: this.scrub(started.message),
      };
    }
    if (this.attached) return { status: 'attached', message: null };
    const pending = this.pendingChange;
    if (pending) {
      return {
        status: 'needs_consent',
        message: NEEDS_CONSENT_MESSAGE,
        preview: {
          settingsPath: pending.settingsPath,
          diffText: this.scrub(formatDiff(pending.diff)),
          warnings: pending.plan.warnings.map((w) => this.scrub(w)),
        },
      };
    }
    return {
      status: 'error',
      message: this.scrub(this.setupError ?? 'Huddle is not connected to Claude Code. Restart Huddle to try again.'),
    };
  }

  /** Belt and braces: the ingest token never leaves main in clear, whatever text it ends up in. */
  private scrub(text: string): string {
    const token = this.token;
    return token ? text.split(token).join('<token>') : text;
  }

  /** Queue an empty batch for listeners when `connection` changed since they last saw it. */
  private noteConnection(): void {
    const next = JSON.stringify(this.connection());
    if (next === this.lastConnection) return;
    this.lastConnection = next;
    this.connectionDirty = true;
    this.scheduleEmit();
  }

  /**
   * The newest `limit` events of one agent (clamped 1..500), oldest first, from the in-memory mirror of the event
   * log: every replayed and every new event passes through it, so it equals what the store returns for that agent
   * (capped at 500). Synchronous because the desktop IPC handler is. `readEvents` reads the store itself.
   */
  getEvents(agentKey: AgentKey, limit: number): HuddleEvent[] {
    const cap = Number.isFinite(limit) ? Math.min(MAX_AGENT_EVENTS, Math.max(1, Math.floor(limit))) : MAX_AGENT_EVENTS;
    const events = this.recent.get(agentKey);
    return events ? events.slice(-cap) : [];
  }

  /** Same as `getEvents`, read from disk. Rejects only for an invalid agent key. */
  readEvents(agentKey: AgentKey, limit: number): Promise<HuddleEvent[]> {
    return this.store.readAgentEvents(agentKey, limit);
  }

  /**
   * Runs one command. Never rejects. Supported: `agent.rename`, `setup.attach`, `settings.update` and the broker's
   * commands (approvals, questions, messages, pause and resume, M3; `approval.allowAllMatchingPolicy`, M4), and the
   * approval rules (`policy.upsertRule`, `policy.removeRule`, M4 WP2), budgets (`budget.set`, M4 WP5),
   * `attention.dismiss` (after the M4 runbook), templates and
   * runs (`template.*`, `run.*`, `agent.stop`, `all.stop`, and `agent.message` to an idle managed root over stdin, M4
   * WP6), the run reports (`report.make`, `report.openFile`, `report.copyPath`, M5), and the history retention and
   * "delete all history" (`history.setRetention`, `history.deleteAll`, M5 WP5), and Ask the Huddle (`huddle.ask`,
   * `ask.cancel`, `ask.setEnabled`, M5 WP6); everything else is `unsupported`.
   */
  async command(cmd: HuddleCommand): Promise<CommandResult> {
    try {
      if (this.disposeRequested || this.phase === 'disposing' || this.phase === 'disposed') {
        return { ok: false, code: 'failed', message: SHUTTING_DOWN };
      }
      if (cmd.type === 'agent.rename') return await this.rename(cmd.agentKey, cmd.name);
      if (cmd.type === 'setup.attach') return await this.attachCommand();
      if (cmd.type === 'settings.update') return await this.updateUserSettings(cmd);
      if (cmd.type === 'agent.message') {
        // A managed root between turns takes the message on stdin at once (ADR-020 §5); otherwise the broker's outbox.
        const parsed = parseBrokerCommand(cmd);
        if (parsed?.type !== 'agent.message') {
          return { ok: false, code: 'invalid', message: 'That command is not well formed.' };
        }
        return this.runs.message(parsed) ?? this.broker.command(parsed);
      }
      if (cmd.type === 'agent.stop' || cmd.type === 'all.stop') return await this.stopCommand(cmd);
      if (isBrokerCommand(cmd)) {
        // Checked again here: the host may not be desktop main, and the renderer is never trusted.
        const parsed = parseBrokerCommand(cmd);
        if (parsed === null) return { ok: false, code: 'invalid', message: 'That command is not well formed.' };
        return this.broker.command(parsed);
      }
      if (cmd.type === 'policy.upsertRule' || cmd.type === 'policy.removeRule') return await this.policyCommand(cmd);
      if (cmd.type === 'budget.set') return await this.budgetCommand(cmd);
      if (cmd.type === 'attention.dismiss') return await this.dismissCommand(cmd);
      if (cmd.type === 'template.upsert' || cmd.type === 'template.remove') return await this.templateCommand(cmd);
      if (isM4Command(cmd)) return await this.runCommand(cmd);
      if (cmd.type === 'report.make' || cmd.type === 'report.openFile' || cmd.type === 'report.copyPath') {
        return await this.reportCommand(cmd);
      }
      if (cmd.type === 'history.setRetention' || cmd.type === 'history.deleteAll')
        return await this.historyCommand(cmd);
      if (cmd.type === 'huddle.ask' || cmd.type === 'ask.cancel' || cmd.type === 'ask.setEnabled') {
        return await this.askCommand(cmd);
      }
      if (isM6Command(cmd)) return await this.phoneCommand(cmd);
      // F28 skills, F29 tasks: checked again in the orchestrator (the host may not be desktop main).
      if (isOrchCommand(cmd)) return await this.orch.command(cmd);
      return {
        ok: false,
        code: 'unsupported',
        message: `This version of Agent Huddle can only watch agents; "${cmd.type}" is not available yet.`,
      };
    } catch (error) {
      this.logger.error('command failed', { error: messageOf(error) });
      return { ok: false, code: 'failed', message: 'The command failed.' };
    }
  }

  /** Adopts a read of policy-rules.json: its rules (or the defaults) and what is wrong with the file (A2-02). */
  private adoptPolicyLoad(policy: PolicyRulesLoad): void {
    this.policyRules = policy.rules;
    this.policyFileBad = policy.bad;
    this.policyReadFailed = policy.readFailed;
    this.policyWarning = policy.warning;
    if (policy.warning !== null) this.logger.warn(policy.warning);
  }

  /**
   * `policy.upsertRule` / `policy.removeRule` (F18): checked again here (the host may not be desktop main), written to
   * policy-rules.json, then adopted, so a rule in use is always one that was saved. Listeners get an empty batch
   * ("read the state again": `getState().policy` changed). Writes no event: rules are configuration, not facts.
   */
  private async policyCommand(cmd: unknown): Promise<CommandResult> {
    const parsed = parseM4Command(cmd);
    if (parsed === null || (parsed.type !== 'policy.upsertRule' && parsed.type !== 'policy.removeRule')) {
      return { ok: false, code: 'invalid', message: 'That rule is not well formed.' };
    }
    const run = this.policyQueue.then(async (): Promise<CommandResult> => {
      // A2-02: a file that could not be read is never overwritten blind; read it again first.
      if (this.policyReadFailed) {
        const again = await readPolicyRules(this.deps.dataDir);
        this.adoptPolicyLoad(again);
        if (again.readFailed) {
          return {
            ok: false,
            code: 'failed',
            message:
              'The rules file could not be read, so it was not changed. Close any program that has it open, then try again.',
          };
        }
      }
      let next: PolicyRule[];
      if (parsed.type === 'policy.upsertRule') {
        // AX-05: the save-only refusal (launchers, installs, push, discard, delete); a loaded file is never checked by it.
        const problem = policyRuleProblem(parsed.rule) ?? policyRuleSaveProblem(parsed.rule);
        if (problem !== null) return { ok: false, code: 'invalid', message: problem };
        next = upsertPolicyRule(this.policyRules, parsed.rule);
        if (next.length > MAX_POLICY_RULES) {
          return { ok: false, code: 'invalid', message: `At most ${String(MAX_POLICY_RULES)} rules can be saved.` };
        }
      } else {
        if (!this.policyRules.some((r) => r.id === parsed.ruleId)) {
          return { ok: false, code: 'not_found', message: 'That rule is not in the list.' };
        }
        next = removePolicyRule(this.policyRules, parsed.ruleId);
      }
      try {
        if (this.policyFileBad) {
          // A2-02: keep the user's own file (with its deny and ask rules) instead of writing the defaults over it.
          const moved = await preserveBadPolicyRulesFile(this.deps.dataDir, this.now());
          this.policyFileBad = false;
          if (moved !== null) {
            this.logger.warn('moved an unusable policy-rules.json aside before saving');
            this.policyWarning = `${this.policyWarning ?? 'policy-rules.json was not used'}. The old file was kept as ${path.basename(moved)}.`;
          }
        }
        await writePolicyRules(this.deps.dataDir, next);
      } catch (error) {
        this.logger.error('could not save the approval rules', { error: messageOf(error) });
        return {
          ok: false,
          code: 'failed',
          message: 'The rules could not be saved. Check that the app data folder is writable, then try again.',
        };
      }
      this.policyRules = next;
      this.connectionDirty = true;
      this.scheduleEmit();
      return { ok: true };
    });
    this.policyQueue = run.catch(() => undefined);
    return run;
  }

  /**
   * `budget.set` (F19): checked again here, then written as a `budget.set` event (the reducer keeps one budget per
   * scope and target; a budget with no limit clears it). The scope is the budget's own, 'all' read as 'overall'.
   * agent: `agentKey` names the agent. session: `agentKey` names any agent of the session; the budget is filed under
   * its root. overall: `agentKey` is not read, and the event is filed under BUDGET_SESSION_ID, so every overall budget
   * replays in the order it was set. The budget detector checks it with the next event (or tick).
   */
  private async budgetCommand(cmd: unknown): Promise<CommandResult> {
    const parsed = parseM4Command(cmd);
    if (parsed?.type !== 'budget.set') {
      return { ok: false, code: 'invalid', message: 'That budget is not well formed.' };
    }
    const scope = budgetScopeOf(parsed.budget.scope);
    const budget: Budget = { ...parsed.budget, scope };
    let envelope: { sessionId: string; agentKey: AgentKey };
    let targetKey: AgentKey | null = null;
    if (scope === 'overall') {
      envelope = { sessionId: BUDGET_SESSION_ID, agentKey: BUDGET_SESSION_ID };
    } else {
      const key = parsed.agentKey;
      const node = key !== null && Object.hasOwn(this.state.agents, key) ? this.state.agents[key] : undefined;
      if (node === undefined) {
        return { ok: false, code: key === null ? 'invalid' : 'not_found', message: 'That agent is not known.' };
      }
      const root = Object.hasOwn(this.state.agents, node.sessionId) ? this.state.agents[node.sessionId] : undefined;
      const owner = scope === 'agent' ? node : root;
      if (owner === undefined) return { ok: false, code: 'not_found', message: "That agent's session is not known." };
      targetKey = owner.key;
      envelope = { sessionId: owner.sessionId, agentKey: owner.key };
    }
    const saved = await this.accept([
      { id: this.nextId(), type: 'budget.set', ts: this.now(), ...envelope, source: 'user', scope, targetKey, budget },
    ]);
    if (!saved) {
      return {
        ok: false,
        code: 'failed',
        message: 'The budget applies now but could not be saved; it is lost on restart.',
      };
    }
    return { ok: true };
  }

  /**
   * `attention.dismiss` (added after the M4 runbook): the user hides an open inbox item. Checked again here (the host
   * may not be desktop main); `selectDismissControl` (shared) decides which items may go: never an approval or a
   * question (Claude Code waits on them), never a budget item while agents it paused are still paused. Written as
   * `attention.resolved` with reason 'dismissed' and source user. The detectors ignore attention events, so their
   * memory still has the item open: it is not raised again while the same condition holds (for a budget: the same
   * setting), and is when the condition clears and comes back.
   */
  private async dismissCommand(cmd: unknown): Promise<CommandResult> {
    const itemId = isRecord(cmd) ? cmd['itemId'] : undefined;
    if (typeof itemId !== 'string' || itemId === '' || itemId.length > DISMISS_ITEM_ID_MAX) {
      return { ok: false, code: 'invalid', message: 'That command is not well formed.' };
    }
    const items = this.state.inbox.filter((i) => i.id === itemId);
    const item = items.find((i) => i.resolvedAt === null) ?? items[items.length - 1];
    if (item === undefined) return { ok: false, code: 'not_found', message: 'That item is not in the inbox.' };
    const control = selectDismissControl(this.state, item);
    if (!control.enabled) {
      return {
        ok: false,
        code: item.resolvedAt === null ? 'unsupported' : 'expired',
        message: control.reason ?? 'That item cannot be dismissed.',
      };
    }
    const node = Object.hasOwn(this.state.agents, item.agentKey) ? this.state.agents[item.agentKey] : undefined;
    const saved = await this.accept([
      {
        id: this.nextId(),
        type: 'attention.resolved',
        ts: this.now(),
        sessionId: node?.sessionId ?? item.agentKey,
        agentKey: item.agentKey,
        source: 'user',
        itemId: item.id,
        reason: 'dismissed',
      },
    ]);
    if (!saved) {
      return { ok: false, code: 'failed', message: 'Dismissed for now, but it could not be saved; it may come back.' };
    }
    return { ok: true };
  }

  /**
   * `template.upsert` / `template.remove` (F16/F17): checked again here, written to templates.json, then adopted (the
   * same order as the rules). A templates.json that was not readable at start is moved aside first, never overwritten.
   * Listeners get an empty batch (`getState().templates` changed). Writes no event: templates are configuration.
   */
  private async templateCommand(cmd: unknown): Promise<CommandResult> {
    const parsed = parseM4Command(cmd);
    if (parsed === null || (parsed.type !== 'template.upsert' && parsed.type !== 'template.remove')) {
      return { ok: false, code: 'invalid', message: 'That template is not well formed.' };
    }
    const run = this.templatesQueue.then(async (): Promise<CommandResult> => {
      let next: TeamTemplate[];
      let warning: string | null = null;
      if (parsed.type === 'template.upsert') {
        // L4 (M5 WP5): the editor shows masked prompts, so a prompt that comes back unchanged is the stored one.
        // L3 (M5 security review): null when a prompt matches two different stored secrets.
        const template = restoreMaskedPrompts(parsed.template, this.templates);
        if (template === null || templateShowsMaskedSecret(template, this.templates)) {
          return { ok: false, code: 'invalid', message: MASKED_SECRET_EDITED };
        }
        if (templateHoldsSecret(template)) warning = TEMPLATE_SECRET_WARNING;
        next = upsertTemplate(this.templates, template);
        if (next.length > MAX_TEMPLATES) {
          return { ok: false, code: 'invalid', message: `At most ${String(MAX_TEMPLATES)} templates can be saved.` };
        }
      } else {
        if (!this.templates.some((t) => t.id === parsed.templateId)) {
          return { ok: false, code: 'not_found', message: 'That template is not in the list.' };
        }
        next = removeTemplate(this.templates, parsed.templateId);
      }
      try {
        if (this.templatesFileBad) {
          const moved = await preserveBadTemplatesFile(this.deps.dataDir, this.now());
          if (moved !== null) this.logger.warn('moved an unreadable templates.json aside before saving');
          this.templatesFileBad = false;
        }
        await writeTemplates(this.deps.dataDir, next);
      } catch (error) {
        this.logger.error('could not save the templates', { error: messageOf(error) });
        return {
          ok: false,
          code: 'failed',
          message: 'The templates could not be saved. Check that the app data folder is writable, then try again.',
        };
      }
      this.templates = next;
      this.connectionDirty = true;
      this.scheduleEmit();
      return warning === null ? { ok: true } : { ok: true, warning };
    });
    this.templatesQueue = run.catch(() => undefined);
    return run;
  }

  /**
   * The run commands (M4 WP6, ADR-020; runtime/runs.ts). `run.launch` takes a stored template by id or an inline one
   * (not stored). `run.openWorktree` answers `{ ok: true, detail: <worktree folder> }`; desktop main opens it.
   */
  private async runCommand(cmd: unknown): Promise<CommandResult> {
    const parsed = parseM4Command(cmd);
    if (parsed === null) return { ok: false, code: 'invalid', message: 'That command is not well formed.' };
    switch (parsed.type) {
      case 'run.launch': {
        // L4 (M5 WP5): an inline template or an override built from the masked display gets its stored prompt back,
        // so what runs is what the user typed; a prompt that still shows a hidden secret is refused.
        let template: TeamTemplate | null | undefined =
          parsed.template === undefined ? undefined : restoreMaskedPrompts(parsed.template, this.templates);
        // L3 (M5 security review): a prompt that matches two different stored secrets is refused, not guessed.
        if (template === null) return { ok: false, code: 'invalid', message: MASKED_SECRET_EDITED };
        let templateId: string | null = null;
        if (parsed.templateId !== undefined) {
          template = this.templates.find((t) => t.id === parsed.templateId);
          if (template === undefined) return { ok: false, code: 'not_found', message: 'That template is not saved.' };
          templateId = template.id;
        }
        if (template === undefined) return { ok: false, code: 'invalid', message: 'Give a template to launch.' };
        const override =
          parsed.promptOverride === undefined
            ? undefined
            : restoreMaskedPrompt(parsed.promptOverride, this.templates, {
                templateId: templateId ?? template.id,
                agent: null,
              });
        const inlineMasked = parsed.template !== undefined && templateShowsMaskedSecret(template, this.templates);
        if (
          inlineMasked ||
          override === null ||
          (override !== undefined && showsMaskedSecret(override, this.templates))
        ) {
          return { ok: false, code: 'invalid', message: MASKED_SECRET_EDITED };
        }
        return this.runs.launch(template, templateId, override);
      }
      case 'run.stop':
        return this.runs.stop(parsed.runId);
      case 'run.end':
        return this.runs.end(parsed.runId);
      case 'run.keepWorktree':
        return this.runs.keepWorktree(parsed.runId);
      case 'run.discardWorktree':
        return this.runs.discardWorktree(parsed.runId);
      case 'run.openWorktree':
        return this.runs.openWorktree(parsed.runId);
      default:
        return { ok: false, code: 'unsupported', message: `"${parsed.type}" is not available in this build.` };
    }
  }

  /**
   * The report commands (M5, F23): checked again here. `report.make` builds the report of an ended run from its stored
   * events and writes its Markdown file. `report.openFile` / `report.copyPath` answer `{ ok: true, detail: <path> }`
   * for the run's file, only inside `<dataDir>/reports` and only when it exists; desktop main opens it or copies it.
   */
  private async reportCommand(cmd: unknown): Promise<CommandResult> {
    const parsed = parseM5Command(cmd);
    if (
      parsed === null ||
      (parsed.type !== 'report.make' && parsed.type !== 'report.openFile' && parsed.type !== 'report.copyPath')
    ) {
      return { ok: false, code: 'invalid', message: 'That command is not well formed.' };
    }
    const history = this.history;
    if (history === null) return { ok: false, code: 'unsupported', message: NO_HISTORY_MESSAGE };
    if (parsed.type === 'report.make') return history.makeReportCommand(parsed.sessionId);
    return history.reportFileCommand(parsed.sessionId);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Ask the Huddle (M5, F25)
  // -------------------------------------------------------------------------------------------------------------------

  /**
   * The exact stdin text `huddle.ask` would send for `question` now (report/ask-context.ts): the state as the UI sees
   * it (nicknames kept), the newest events of every agent (the Huddle's own budget and history sessions left out),
   * the ingest token masked as `<token>`. Works while Ask is off (DESIGN: "What would be sent" still opens).
   */
  private askPreview(question: string, history?: readonly AskTurn[]): AskPreview {
    const state = toHuddleState(withNicknameFallback(this.state, this.userSettings.nicknames));
    const events: HuddleEvent[] = [];
    for (const list of this.recent.values()) {
      for (const e of list.slice(-200)) {
        if (
          e.sessionId !== BUDGET_SESSION_ID &&
          e.sessionId !== HISTORY_SESSION_ID &&
          e.sessionId !== PHONE_SESSION_ID &&
          e.sessionId !== TASKS_SESSION_ID
        )
          events.push(e);
      }
    }
    return buildAskContext(state, events, question, this.now(), {
      secrets: this.token === null ? [] : [this.token],
      systemPrompt: ASK_SYSTEM_PROMPT,
      ...(history !== undefined ? { history } : {}),
    });
  }

  /** Does the reducer's state have this session's main agent? (The ask guard holds telemetry of unknown sessions.) */
  private knowsSession(sessionId: string): boolean {
    return Object.hasOwn(this.state.agents, agentKey(sessionId));
  }

  /** HuddleState.ask changed outside the reducer (like `connection`): send the state again. */
  private noteAskStatusChanged(): void {
    this.connectionDirty = true;
    this.scheduleEmit();
  }

  /**
   * `huddle.ask`, `ask.cancel`, `ask.setEnabled`, checked again here (the host may not be desktop main).
   *
   * huddle.ask: refused `disabled` while Ask is off, `api_key_set` when ANTHROPIC_API_KEY is in the env claude would
   * get (or in settings.json's env block, or an apiKeyHelper), `other_provider` when another endpoint or provider is
   * set (L1), `busy` while another ask runs; otherwise the preview text is built again at this moment and sent (AskRunner).
   * The answer is returned as plain text in `CommandResult.ask` and nothing else happens with it: no event, no file, no
   * log line (only the outcome kind, wall time and token counts are logged), and no code path turns it into a command.
   * ask.cancel: ends the ask in flight with `cancelled`; ok when none runs.
   * ask.setEnabled: saved in the settings file (desktop main forwards it here); switching off ends an ask in flight
   * with `disabled` first.
   */
  private async askCommand(cmd: unknown): Promise<CommandResult> {
    const parsed = parseM5Command(cmd);
    if (parsed?.type === 'ask.cancel') {
      this.asker.cancel('cancelled');
      return { ok: true };
    }
    if (parsed?.type === 'ask.setEnabled') {
      if (!parsed.enabled) this.asker.cancel('disabled');
      try {
        await this.updateSettingsFile((file) =>
          withUserSettings(file, parseUserSettings({ ...userSettingsOf(file), ask: { enabled: parsed.enabled } })),
        );
      } catch (error) {
        this.logger.error('could not save the Ask setting', { error: messageOf(error) });
        return {
          ok: false,
          code: 'failed',
          message: 'Settings could not be saved. Check that the app data folder is writable, then try again.',
        };
      }
      this.connectionDirty = true;
      this.scheduleEmit();
      return { ok: true };
    }
    if (parsed?.type !== 'huddle.ask') {
      return { ok: false, code: 'invalid', message: 'Write a question of at most 500 characters.' };
    }
    // L1: settings.json is read again first (key names only), so a key or provider added since start is seen. Ask is
    // checked after this read, so a switch-off during it counts.
    if (await this.asker.refreshClaudeSettings()) this.noteAskStatusChanged();
    if (!this.userSettings.ask.enabled) {
      return { ok: false, code: 'failed', message: ASK_WORDS.disabled, askError: 'disabled' };
    }
    const refusal = this.asker.refusal();
    if (refusal !== null) return { ok: false, code: 'failed', message: refusalWords(refusal), askError: refusal.kind };
    if (this.asker.busy) return { ok: false, code: 'failed', message: ASK_WORDS.busy, askError: 'busy' };
    // Synchronous from the busy check to `run`, which claims the runner before its first await.
    const preview = this.askPreview(parsed.question, parsed.history);
    const askedAt = this.now();
    const running = this.asker.run(preview.text, {
      onFolder: (folder) => {
        this.askGuard.begin(folder);
      },
    });
    // `HuddleState.ask.busy` changed: listeners get an empty batch ("read the state again"), now and at the end.
    this.connectionDirty = true;
    this.scheduleEmit();
    const result = await this.track(running);
    this.connectionDirty = true;
    this.scheduleEmit();
    // Held telemetry of other sessions goes in now; the ask's own (and anything of its session later) is dropped.
    void this.accept(this.askGuard.end(result.sessionId, (id) => this.knowsSession(id)));
    if (!result.ok) return { ok: false, code: 'failed', message: result.message, askError: result.error };
    return {
      ok: true,
      ask: {
        text: result.text,
        model: result.model,
        askedAt,
        wallMs: result.wallMs,
        apiMs: result.apiMs,
        tokens: result.tokens,
        costUsd: result.costUsd,
        sent: preview.text,
      },
    };
  }

  /** Tests: write the run reports waiting for their delay now, and wait for every report in progress. */
  flushReports(): Promise<void> {
    return this.history?.flushReports() ?? Promise.resolve();
  }

  // -------------------------------------------------------------------------------------------------------------------
  // History retention and "delete all history" (M5 WP5, F22)
  // -------------------------------------------------------------------------------------------------------------------

  /**
   * `history.setRetention` / `history.deleteAll`, checked again here (the host may not be desktop main).
   *
   * setRetention: the days are saved in the settings file (desktop main forwards it here, settings-host.ts); a lower
   * value than before deletes the runs older than it at once (the UI asked the user first), answering what went.
   * deleteAll: refused unless `confirm` is exactly DELETE_ALL_CONFIRM, on the JSONL fallback (no database), and while
   * the JSONL import runs. See `prune` for what is deleted and kept.
   */
  private async historyCommand(cmd: unknown): Promise<CommandResult> {
    const parsed = parseM5Command(cmd);
    if (parsed?.type === 'history.setRetention') {
      const before = this.userSettings.history.retentionDays;
      // L4: lowering deletes at once, so the command must carry the count `history.retentionPreview` showed. The count,
      // the save and the deletion run as one job on the prune queue, so nothing deletes in between and a stale command
      // can never delete more than the user saw. Raising needs no confirmation.
      if (parsed.days < before && this.canPrune()) {
        const confirm = parsed.confirm;
        if (confirm === undefined) return { ok: false, code: 'invalid', message: RETENTION_CONFIRM_MISSING };
        return this.enqueuePrune(async () => {
          const runs = await this.retentionRunCount(parsed.days);
          if (runs !== confirm) return { ok: false, code: 'invalid', message: retentionConfirmChanged(runs) };
          const saved = await this.saveRetentionDays(parsed.days);
          if (saved !== null) return saved;
          return this.runPrune({ kind: 'retention', days: parsed.days });
        });
      }
      const saved = await this.saveRetentionDays(parsed.days);
      if (saved !== null) return saved;
      if (parsed.days >= before || !this.canPrune()) return { ok: true };
      return this.prune({ kind: 'retention', days: parsed.days });
    }
    if (parsed?.type !== 'history.deleteAll' || (parsed.confirm as string) !== DELETE_ALL_CONFIRM) {
      return { ok: false, code: 'invalid', message: 'Type delete to confirm.' };
    }
    if (!this.canPrune()) return { ok: false, code: 'unsupported', message: NO_HISTORY_MESSAGE };
    if (this.importing) return { ok: false, code: 'failed', message: DELETE_WHILE_IMPORTING_MESSAGE };
    return this.prune({ kind: 'delete_all' });
  }

  /** History can be deleted: on the database (HistoryService), or on the JSONL fallback (M1, whole session files). */
  private canPrune(): boolean {
    return this.history !== null || this.store instanceof JsonlEventStore;
  }

  /**
   * What `history.retentionPreview` answers for `days`: the runs a retention of `days` deletes now, counted as the
   * history list counts them (HistoryService `retentionRunCount`). The preview and the L4 check both call this, so they
   * agree; the deletion also removes the run-less fragments it does not count. On the JSONL fallback (no derivations)
   * it counts session files.
   */
  private async retentionRunCount(days: number): Promise<number> {
    if (this.history !== null) return this.history.retentionRunCount(days);
    return (await this.jsonlPruneCandidates({ kind: 'retention', days })).length;
  }

  /** Saves the retention days in the settings file; null when saved, else the failure to answer. */
  private async saveRetentionDays(days: number): Promise<CommandResult | null> {
    try {
      await this.updateSettingsFile((file) =>
        withUserSettings(file, parseUserSettings({ ...userSettingsOf(file), history: { retentionDays: days } })),
      );
    } catch (error) {
      this.logger.error('could not save the history retention', { error: messageOf(error) });
      return {
        ok: false,
        code: 'failed',
        message: 'Settings could not be saved. Check that the app data folder is writable, then try again.',
      };
    }
    this.connectionDirty = true;
    this.scheduleEmit();
    return null;
  }

  /** The retention at start, then every RETENTION_EVERY_MS while the Huddle runs (M5 WP5). */
  private startRetention(): void {
    if (!this.canPrune() || this.stopRetentionTimer !== null) return;
    const run = (): void => {
      if (this.quitting() || this.phase !== 'running') return;
      void this.track(
        this.prune({ kind: 'retention', days: this.userSettings.history.retentionDays }).then((result) => {
          if (!result.ok) this.logger.warn('the history retention did not run', { error: result.message });
        }),
      );
    };
    if (this.deps.history?.retentionAtStart !== false) run();
    const timer = this.deps.history?.retentionTimer ?? defaultRetentionTimer;
    this.stopRetentionTimer = timer(run, Math.max(1, this.deps.history?.retentionEveryMs ?? RETENTION_EVERY_MS));
  }

  /**
   * Deletes stored history (M5 WP5, F22), one deletion at a time:
   *  1. Which sessions: a retention takes the sessions with no event in the last `days` days (HistoryService
   *     `retentionCandidates`; the preview counts the runs among them, and run-less fragments go too); delete all
   *     takes every stored session. Both leave out the
   *     overall budgets' session, sessions running in this Huddle and runs whose process lives.
   *  2. The nicknames of those sessions' agents (from the log and the state) are copied into the settings first; if
   *     that write fails nothing is deleted.
   *  3. Their events, `sessions` rows (and search rows), derived rows and report files go, in chunked transactions that
   *     yield (HistoryService `deleteSessions`). A retention also trims the Huddle's own history session.
   *  4. Delete all also removes every other report file, the older JSONL folders (`events`, `events.migrated-*`, never
   *     following a link) and rebuilds the search index from what is left.
   *  5. VACUUM only when cheap (HistoryService `compactIfCheap`).
   *  6. `history.pruned` names the deleted sessions the state had, so the reducer forgets them.
   */
  private prune(job: PruneJob): Promise<CommandResult> {
    return this.enqueuePrune(() => this.runPrune(job));
  }

  /** Runs `work` on the prune queue: one deletion (or count, save and deletion) at a time. */
  private enqueuePrune(work: () => Promise<CommandResult>): Promise<CommandResult> {
    const run = this.pruneQueue.then(work);
    this.pruneQueue = run.catch(() => undefined);
    return run;
  }

  /** Only on the prune queue. */
  private async runPrune(job: PruneJob): Promise<CommandResult> {
    const history = this.history;
    if (history === null) {
      if (this.store instanceof JsonlEventStore) return this.runJsonlPrune(this.store, job);
      return { ok: false, code: 'unsupported', message: NO_HISTORY_MESSAGE };
    }
    if (this.quitting()) return { ok: false, code: 'failed', message: SHUTTING_DOWN };
    const all = job.kind === 'delete_all';
    try {
      const ids = all ? await history.deleteAllCandidates() : await history.retentionCandidates(job.days);
      const chosen = new Set(ids);
      // Retention never picks these (retentionCandidates); delete all does, and its answer says so.
      const budgetCounted = all ? await history.countedByOverallBudget(ids) : 0;
      if (!(await this.keepNicknames(all ? () => true : (sessionId) => chosen.has(sessionId)))) {
        return {
          ok: false,
          code: 'failed',
          message:
            'Nothing was deleted: the agent nicknames could not be saved first. Check that the app data folder is writable.',
        };
      }
      // M6 (F26): delete all revokes every paired phone and removes phone-devices.json first, so the revoke events land
      // in the phone session before it is deleted with the rest; a retention revokes phones not seen for that long.
      if (all) await this.phone.deleteAll();
      else await this.phone.retention(job.days);
      const outcome = await history.deleteSessions(ids, () => this.quitting());
      let reports = outcome.reports;
      let folders = 0;
      const problems: string[] = [];
      if (all) {
        const left = new Set(this.storedSessionIds());
        reports += await history.removeReportFiles(left);
        // M6: the phone session's events (paired, revoked, connected: device names) go too, whatever the delete kept.
        await history.trimSession(PHONE_SESSION_ID, this.now() + 1);
        const legacy = await history.removeLegacyFolders();
        folders = legacy.removed;
        problems.push(...legacy.problems);
        history.rebuildSearchIndex();
      } else {
        await history.trimSession(HISTORY_SESSION_ID, history.retentionCutoff(job.days));
        await history.trimSession(PHONE_SESSION_ID, history.retentionCutoff(job.days));
        // M1: the older JSONL folders the import left, once nothing in them is newer than the cutoff.
        const legacy = await history.removeExpiredLegacyFolders(history.retentionCutoff(job.days));
        folders = legacy.removed;
        problems.push(...legacy.problems);
      }
      const compacted = outcome.deleted.length > 0 || folders > 0 ? history.compactIfCheap() : 'skipped';
      this.forgetPruned(outcome.deleted, all ? 'delete_all' : 'retention');
      this.logger.info(all ? 'deleted all history' : 'history retention', {
        runs: outcome.deleted.length,
        keptAfterNewEvents: outcome.kept.length,
        events: outcome.events,
        reports,
        folders,
        compacted,
        problems: problems.length,
      });
      // Delete all may lower the overall budget's usage (the user asked for everything to go); the answer says so.
      const deleted: HistoryDeleted = { runs: outcome.deleted.length, reports, folders };
      if (all && budgetCounted > 0) deleted.overallBudgetLowered = true;
      if (problems.length > 0) {
        return {
          ok: false,
          code: 'failed',
          message: `History was deleted, but part of the older history folder could not be removed: ${clipText(problems.join('; '), CLIP_LIMITS.error)}`,
        };
      }
      return { ok: true, detail: deletedWords(deleted, all), deleted };
    } catch (error) {
      this.logger.error(all ? 'could not delete all history' : 'the history retention failed', {
        error: messageOf(error),
      });
      return {
        ok: false,
        code: 'failed',
        message: 'History could not be deleted completely. What was deleted stays deleted; try again.',
      };
    }
  }

  /**
   * Sessions the JSONL fallback must not delete now (M1): those running in this Huddle (a root that has not ended,
   * active since this start, its run not exited; the database's `isLive` rule over the state) and managed runs whose
   * process lives.
   */
  private jsonlLiveSessionIds(): Set<string> {
    const live = new Set<string>();
    const started = this.startedAt;
    const isRunLive = this.deps.runIsLive ?? ((id: string) => this.runs.isAlive(id));
    for (const key of this.state.rootKeys) {
      const node = Object.hasOwn(this.state.agents, key) ? this.state.agents[key] : undefined;
      if (node?.kind !== 'main') continue;
      if (isRunLive(node.sessionId)) {
        live.add(node.sessionId);
        continue;
      }
      if (node.endedAt !== null || started === null || node.lastEventAt < started) continue;
      if ((node.run?.exited ?? null) === null) live.add(node.sessionId);
    }
    return live;
  }

  /**
   * The session files a JSONL-fallback retention or delete all removes now (M1). Never the overall budgets' file or a
   * live session's; a retention also keeps the Huddle's own history session and, while an overall budget is in force,
   * every file it may count (the cutoff moves back to its `setAt`, as on the database). Picked by the file's own time.
   */
  private async jsonlPruneCandidates(job: PruneJob): Promise<string[]> {
    const store = this.store;
    if (!(store instanceof JsonlEventStore)) return [];
    const keep = this.jsonlLiveSessionIds();
    keep.add(BUDGET_SESSION_ID);
    keep.add(TASKS_SESSION_ID);
    const files = await store.sessionFiles();
    if (job.kind === 'delete_all') return pickJsonlSessions(files, { kind: 'delete_all' }, keep);
    keep.add(HISTORY_SESSION_ID);
    const budgetEvents: HuddleEvent[] = [];
    try {
      for await (const event of store.readSession(BUDGET_SESSION_ID)) budgetEvents.push(event);
    } catch (error) {
      // Unknown budget: keep everything rather than lower a safety cap's usage.
      this.logger.warn('the history retention could not read the overall budget', { error: messageOf(error) });
      return [];
    }
    const since = activeOverallBudgetSince(budgetEvents);
    const cutoff = Math.min(this.now() - job.days * DAY_MS, since ?? Number.POSITIVE_INFINITY);
    return pickJsonlSessions(files, { kind: 'retention', cutoff }, keep);
  }

  /**
   * Retention and delete all on the JSONL fallback (M5 security review M1): whole `<sessionId>.jsonl` files, without
   * following links, on the store's write chain; their report files too; delete all also removes the
   * `events.migrated-*` folders. Nicknames are copied into the settings first (from the state: there is no database to
   * read them from). The database file is never touched (it could not be opened), and delete all says so.
   */
  private async runJsonlPrune(store: JsonlEventStore, job: PruneJob): Promise<CommandResult> {
    if (this.quitting()) return { ok: false, code: 'failed', message: SHUTTING_DOWN };
    const all = job.kind === 'delete_all';
    try {
      const ids = await this.jsonlPruneCandidates(job);
      const chosen = new Set(ids);
      if (!(await this.keepNicknames(all ? () => true : (sessionId) => chosen.has(sessionId)))) {
        return {
          ok: false,
          code: 'failed',
          message:
            'Nothing was deleted: the agent nicknames could not be saved first. Check that the app data folder is writable.',
        };
      }
      const outcome = await store.deleteSessionFiles(ids, removeTreeNoFollow);
      const problems = [...outcome.problems];
      let reports = 0;
      for (const sessionId of outcome.deleted) {
        const file = reportPathFor(this.deps.dataDir, sessionId);
        if (file === null) continue;
        try {
          if ((await removeTreeNoFollow(file)).existed) reports += 1;
        } catch (error) {
          problems.push(`${path.basename(file)}: ${messageOf(error)}`);
        }
      }
      let folders = 0;
      if (all) {
        for (const folder of await migratedJsonlFolders(this.deps.dataDir)) {
          try {
            if ((await removeTreeNoFollow(folder)).existed) folders += 1;
          } catch (error) {
            problems.push(`${path.basename(folder)}: ${messageOf(error)}`);
          }
        }
      }
      this.forgetPruned(outcome.deleted, all ? 'delete_all' : 'retention');
      this.logger.info(all ? 'deleted all history (JSONL)' : 'history retention (JSONL)', {
        runs: outcome.deleted.length,
        reports,
        folders,
        problems: problems.length,
      });
      const deleted: HistoryDeleted = { runs: outcome.deleted.length, reports, folders };
      if (problems.length > 0) {
        return {
          ok: false,
          code: 'failed',
          message: `History was deleted, but some files could not be removed: ${clipText(problems.join('; '), CLIP_LIMITS.error)}`,
        };
      }
      const words = deletedWords(deleted, all);
      return { ok: true, detail: all ? `${words} ${JSONL_DELETE_ALL_NOTE}` : words, deleted };
    } catch (error) {
      this.logger.error(all ? 'could not delete all history' : 'the history retention failed', {
        error: messageOf(error),
      });
      return {
        ok: false,
        code: 'failed',
        message: 'History could not be deleted completely. What was deleted stays deleted; try again.',
      };
    }
  }

  /** Every session id the database still holds. */
  private storedSessionIds(): string[] {
    return this.store instanceof SqliteEventStore ? this.store.history.sessionIds([]) : [];
  }

  /**
   * Copies the latest nickname of every agent whose session `include` accepts into `settings.nicknames`: from the stored
   * log (a cleared nickname removes the entry), then from the state (which wins). Resolves false when that could not be
   * saved. Writes nothing when nothing changes.
   */
  private async keepNicknames(include: (sessionId: string) => boolean): Promise<boolean> {
    const history = this.history;
    // The JSONL fallback (M1) has no database to read renames from: the state's nicknames only.
    const changes = history === null ? new Map<AgentKey, string | null>() : await history.storedNicknames(include);
    for (const [key, book] of Object.entries(this.state.book.agents)) {
      if (book.nickname !== null && include(sessionOfAgentKey(key))) changes.set(key, book.nickname);
    }
    if (changes.size === 0) return true;
    try {
      await this.updateSettingsFile((file) => {
        const user = userSettingsOf(file);
        const nicknames: Record<AgentKey, string> = { ...user.nicknames };
        for (const [key, name] of changes) {
          if (name === null) Reflect.deleteProperty(nicknames, key);
          else
            Object.defineProperty(nicknames, key, {
              value: name,
              enumerable: true,
              writable: true,
              configurable: true,
            });
        }
        if (JSON.stringify(nicknames) === JSON.stringify(user.nicknames)) return file;
        return withUserSettings(file, parseUserSettings({ ...user, nicknames }));
      });
      this.connectionDirty = true;
      this.scheduleEmit();
      return true;
    } catch (error) {
      this.logger.error('could not save the agent nicknames before deleting history', { error: messageOf(error) });
      return false;
    }
  }

  /**
   * After a deletion: `history.pruned` (only the deleted sessions the state has, see events.ts) so the reducer forgets
   * them, and the in-memory mirrors (`recent`, role reads) forget them too. Written to the Huddle's own history session.
   */
  private forgetPruned(deleted: readonly string[], reason: 'retention' | 'delete_all'): void {
    const gone = new Set(deleted);
    for (const key of [...this.recent.keys()]) if (gone.has(sessionOfAgentKey(key))) this.recent.delete(key);
    for (const key of [...this.describedRoots])
      if (gone.has(key.split('\u0000')[0] ?? '')) this.describedRoots.delete(key);
    if (deleted.length === 0 && reason === 'retention') return;
    const runs = this.state.book.runs ?? {};
    const inState = deleted.filter(
      (id) =>
        Object.hasOwn(this.state.agents, id) || Object.hasOwn(this.state.book.sessions, id) || Object.hasOwn(runs, id),
    );
    void this.accept([
      {
        id: this.nextId(),
        type: 'history.pruned',
        ts: this.now(),
        sessionId: HISTORY_SESSION_ID,
        agentKey: HISTORY_SESSION_ID,
        source: reason === 'retention' ? 'huddle' : 'user',
        sessionIds: inState,
        reason,
        count: deleted.length,
      },
    ]);
  }

  /** One run's stored lifecycle events (M5 WP5, fix a): for Keep and Discard on a run no longer in the live state. */
  private async storedRunEvents(runId: string): Promise<HuddleEvent[]> {
    const store = this.store;
    if (store instanceof SqliteEventStore) {
      if (!isValidSessionId(runId)) return [];
      await store.flush();
      return store.history.runEvents(runId);
    }
    const out: HuddleEvent[] = [];
    if (!isValidSessionId(runId)) return out;
    for await (const event of store.readSession(runId)) {
      if (event.type.startsWith('run.') || event.type.startsWith('worktree.')) out.push(event);
    }
    return out;
  }

  /**
   * `agent.stop` (F13): the main agent of a run this Huddle launched stops its run (as `run.stop`); anything else is
   * unsupported (an attached session cannot be stopped from here, and a subagent is not a process of its own).
   * `all.stop`: every live run, one after another; ok when each stopped.
   */
  private async stopCommand(cmd: HuddleCommand): Promise<CommandResult> {
    if (cmd.type === 'all.stop') {
      const runIds = this.runs.liveRunIds();
      if (runIds.length === 0) {
        return {
          ok: false,
          code: 'unsupported',
          message: 'No run Huddle launched is running. Sessions started in a terminal are stopped there.',
        };
      }
      const results = await Promise.all(runIds.map((runId) => this.runs.stop(runId)));
      const failed = results.filter((r) => !r.ok).length;
      if (failed === 0) return { ok: true };
      return {
        ok: false,
        code: 'failed',
        message: `${String(failed)} of ${String(runIds.length)} runs could not be stopped.`,
      };
    }
    if (cmd.type !== 'agent.stop' || typeof cmd.agentKey !== 'string') {
      return { ok: false, code: 'invalid', message: 'That command is not well formed.' };
    }
    const node = Object.hasOwn(this.state.agents, cmd.agentKey) ? this.state.agents[cmd.agentKey] : undefined;
    if (node === undefined) return { ok: false, code: 'not_found', message: 'That agent is not known.' };
    const runId = node.kind === 'main' ? node.run?.runId : undefined;
    if (runId === undefined) {
      return {
        ok: false,
        code: 'unsupported',
        message:
          'Only the main agent of a run Huddle launched can be stopped from here. Use the terminal for this one.',
      };
    }
    return this.runs.stop(runId);
  }

  /**
   * Read-only questions from the UI (`huddle:query`, ADR-020). Never rejects and writes nothing.
   * `policy.preview`: over the newest approval requests in memory (the same mirror `getEvents` reads), approximate
   * because those carry the stored, clipped and masked input. `pick.folder` needs a system dialog: Electron main
   * answers it itself, so here it is `unsupported`. M5 (F22-F24): the history, replay, report and scorecard questions
   * go to the history service (runtime/history.ts); it writes no event, only derived rows and report files.
   * `ask.preview` (F25) is built here from memory (`askPreview`).
   */
  query(q: HuddleQuery): Promise<QueryResult> {
    try {
      // M5 (F22-F25) questions: checked again here, then answered by the history service (or, for Ask, here).
      if (isM5Query(q)) {
        const m5 = parseM5Query(q);
        if (m5 === null)
          return Promise.resolve({ ok: false, code: 'invalid', message: 'That query is not well formed.' });
        // F25: built from memory (no database needed), whether Ask is on or off.
        if (m5.type === 'ask.preview') {
          // L1: the Ask view opened or the question changed: read settings.json's key names again, off this answer.
          void this.asker.refreshClaudeSettings().then((changed) => {
            if (changed) this.noteAskStatusChanged();
          });
          return Promise.resolve({ ok: true, type: 'ask.preview', preview: this.askPreview(m5.question, m5.history) });
        }
        // M1 + L4: the JSONL fallback deletes too, so it answers the count the confirmation needs.
        if (this.history === null && m5.type === 'history.retentionPreview' && this.store instanceof JsonlEventStore) {
          const days = m5.days;
          return this.retentionRunCount(days).then(
            (runs): QueryResult => ({ ok: true, type: 'history.retentionPreview', preview: { days, runs } }),
            (): QueryResult => ({ ok: false, code: 'failed', message: 'The history could not be read.' }),
          );
        }
        if (this.history === null) return Promise.resolve({ ok: false, code: 'failed', message: NO_HISTORY_MESSAGE });
        return this.history.query(m5);
      }
      // F28: the known projects and their skills, one skill's file. Reads files only.
      if (isOrchQuery(q)) return this.orch.query(q);
      // M6 (F26): the LAN addresses phone access may use, read from the adapters now.
      if (isM6Query(q)) {
        const m6 = parseM6Query(q);
        if (m6 === null)
          return Promise.resolve({ ok: false, code: 'invalid', message: 'That query is not well formed.' });
        // M6 (F27): what the self-report registration would run and change. Reads only.
        if (m6.type === 'setup.selfReportPreview') {
          return this.mcpRegistrar.prepare(m6.mode).then(
            (plan): QueryResult => {
              if (plan.preview.state !== 'unreadable') this.huddleMcpRegistered = plan.preview.state === 'ours';
              return { ok: true, type: 'setup.selfReportPreview', preview: plan.preview };
            },
            (): QueryResult => ({ ok: false, code: 'failed', message: 'The registration could not be checked.' }),
          );
        }
        return Promise.resolve({ ok: true, type: 'phone.addresses', addresses: this.phone.addresses() });
      }
      const parsed = parseHuddleQuery(q);
      if (parsed === null)
        return Promise.resolve({ ok: false, code: 'invalid', message: 'That query is not well formed.' });
      if (parsed.type === 'pick.folder') {
        return Promise.resolve({
          ok: false,
          code: 'unsupported',
          message: 'Choosing a folder is answered by the desktop app, not the core.',
        });
      }
      const events: HuddleEvent[] = [];
      for (const list of this.recent.values()) {
        for (const e of list) if (e.type === 'approval.requested') events.push(e);
      }
      const preview = previewRule(parsed.rule, events, this.state.agents);
      return Promise.resolve({ ok: true, type: 'policy.preview', preview });
    } catch (error) {
      this.logger.error('query failed', { error: messageOf(error) });
      return Promise.resolve({ ok: false, code: 'failed', message: 'The query failed.' });
    }
  }

  onEvents(listener: HuddleEventsListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Attach while running (ADR-014)
  // -------------------------------------------------------------------------------------------------------------------

  /**
   * `setup.attach` (ADR-017): the user pressed Connect on the first-run screen. `expired` means settings.json
   * changed since the preview; the new preview is already in `getState().connection`.
   */
  private async attachCommand(): Promise<CommandResult> {
    const result = await this.consentAndAttach();
    switch (result.status) {
      case 'attached':
        return { ok: true };
      case 'stale':
        return { ok: false, code: 'expired', message: SETTINGS_CHANGED_MESSAGE };
      case 'error':
        return { ok: false, code: 'failed', message: this.scrub(result.error) };
    }
  }

  /** Consent counts only for the settings.json it was given for (see HuddleSettings.consentedFor). */
  private hasConsent(): boolean {
    const { consentedAt, consentedFor } = this.settings;
    return consentedAt !== null && consentedFor !== null && sameSettingsFile(consentedFor, this.installer.settingsPath);
  }

  /** Consent on record for this settings.json and for exactly this change (`SettingsPlan.consentFingerprint`). */
  private hasConsentFor(fingerprint: string): boolean {
    return this.hasConsent() && this.settings.consentedFingerprint === fingerprint;
  }

  setupStatus(): SetupStatus {
    return {
      consented: this.hasConsent(),
      consentedAt: this.hasConsent() ? this.settings.consentedAt : null,
      attached: this.attached,
      settingsPath: this.installer.settingsPath,
      port: this.phase === 'running' ? this.port : null,
      preparedDiff: this.pendingChange ? previewOf(this.pendingChange) : null,
      error: this.setupError,
    };
  }

  /**
   * Reads settings.json and returns the change attaching would make, for the first-run screen. Writes nothing.
   * The change is kept; `consentAndAttach` applies exactly this change (or reports `stale`).
   * `statusLine: true` (F9, opt-in, default off) also wraps the user's status line with the bridge; the diff shows it.
   * Once installed, the bridge stays across starts and quits (ADR-018) until `removeStatusLineBridge()`.
   */
  async prepareAttach(options: AttachOptions = {}): Promise<PrepareAttachResult> {
    const result = await this.runPrepareAttach(options);
    this.noteConnection();
    return result;
  }

  private async runPrepareAttach(options: AttachOptions = {}): Promise<PrepareAttachResult> {
    if (this.phase !== 'running' || this.port === null || this.token === null) {
      return { ok: false, error: 'Agent Huddle is not receiving events right now, so it will not add its hooks.' };
    }
    try {
      const prepared = await this.installer.prepareInstall({
        port: this.port,
        token: this.token,
        ...(options.statusLine === true ? { statusLine: true } : {}),
      });
      if ('ok' in prepared) {
        this.setupError = prepared.error;
        return { ok: false, error: prepared.error };
      }
      this.pendingChange = prepared;
      this.setupError = null;
      return { ok: true, preview: previewOf(prepared) };
    } catch (error) {
      const message = `Could not read Claude Code settings: ${messageOf(error)}`;
      this.setupError = message;
      return { ok: false, error: message };
    }
  }

  /**
   * The owner agreed on the first-run screen: apply the change that was shown, and only once it is in settings.json
   * remember the consent (`consentedAt`). If settings.json changed the Huddle's part since then, nothing is written,
   * no consent is stored, and `stale` carries the new change to show; the screen asks again. Later starts attach
   * without asking (ADR-014: one consent).
   */
  async consentAndAttach(): Promise<AttachResult> {
    const result = await this.guardAttach(() => this.runConsentAndAttach());
    this.noteConnection();
    return result;
  }

  private async runConsentAndAttach(): Promise<AttachResult> {
    if (this.phase !== 'running' || this.disposeRequested) {
      return {
        status: 'error',
        error: 'Agent Huddle is not receiving events right now, so it will not add its hooks.',
      };
    }
    if (this.attached) return { status: 'attached', written: false };
    const change = this.pendingChange;
    if (!change) return { status: 'error', error: 'There is no change to approve. Show the change first.' };
    try {
      const result = this.afterApply(await this.installer.apply(change, { consent: true }));
      // apply() wrote exactly this plan (a different fresh plan comes back as stale), so its fingerprint is what the
      // owner approved. Recorded again when it differs from the one on record (a changed hook table, ADR-019).
      const fingerprint = change.plan.consentFingerprint;
      if (result.status === 'attached' && !this.hasConsentFor(fingerprint)) await this.recordConsent(fingerprint);
      return result;
    } catch (error) {
      const message = `Could not attach: ${messageOf(error)}`;
      this.setupError = message;
      return { status: 'error', error: message };
    }
  }

  /**
   * Stores the consent after the shown change was applied. If that write fails the hooks stay for this run and the
   * next start asks again, which is the safe direction.
   */
  private async recordConsent(consentedFingerprint: string): Promise<void> {
    const consentedAt = isoOf(this.now());
    const consentedFor = this.installer.settingsPath;
    try {
      await this.updateSettingsFile((file) => ({ ...file, consentedAt, consentedFor, consentedFingerprint }));
    } catch (error) {
      this.logger.error('could not save consent', { error: messageOf(error) });
    }
  }

  private adoptSettings(settings: HuddleSettings): void {
    this.settings = settings;
    this.userSettings = userSettingsOf(settings);
  }

  /**
   * huddle-settings.json has two writers (this core: consent; desktop main: preferences, until main hands
   * `settings.update` to the core). So every write re-reads the file, changes only its own part, keeps every other key,
   * and writes; writes from this core run one after another. Rejects when the write fails (nothing adopted then).
   */
  private updateSettingsFile(change: (file: HuddleSettings) => HuddleSettings): Promise<HuddleSettings> {
    const run = this.settingsQueue.then(async () => {
      const next = change(await readHuddleSettings(this.deps.dataDir));
      await writeHuddleSettings(this.deps.dataDir, next);
      this.adoptSettings(next);
      return next;
    });
    this.settingsQueue = run.catch(() => undefined);
    return run;
  }

  /**
   * `settings.update` (M3): the patch is checked, applied to the preferences as they are in the file now, re-checked
   * field by field, and saved. Listeners get an empty batch ("read the state again"). While desktop main still answers
   * `settings.update` itself (settings-host.ts), this path is only reached by other hosts and tests.
   */
  private async updateUserSettings(cmd: unknown): Promise<CommandResult> {
    const parsed = settingsUpdateCommandSchema.safeParse(cmd);
    if (!parsed.success) return { ok: false, code: 'invalid', message: 'Those settings are not valid.' };
    const patch = parsed.data.patch;
    try {
      await this.updateSettingsFile((file) =>
        withUserSettings(file, parseUserSettings(applyUserSettingsPatch(userSettingsOf(file), patch))),
      );
    } catch (error) {
      this.logger.error('could not save settings', { error: messageOf(error) });
      return {
        ok: false,
        code: 'failed',
        message: 'Settings could not be saved. Check that the app data folder is writable, then try again.',
      };
    }
    this.connectionDirty = true;
    this.scheduleEmit();
    return { ok: true };
  }

  /**
   * Forget the consent and remove the hooks (telemetry env vars stay, as on quit). Afterwards the first-run screen
   * shows the change again. The consent is cleared first, so a crash halfway never attaches on the next start.
   * Not a command yet: the tray item and a command come later.
   */
  async withdrawConsent(): Promise<WithdrawResult> {
    const result = await this.runWithdrawConsent();
    this.noteConnection();
    return result;
  }

  private async runWithdrawConsent(): Promise<WithdrawResult> {
    if (this.disposeRequested || this.phase === 'disposing' || this.phase === 'disposed') {
      return { ok: false, error: SHUTTING_DOWN };
    }
    try {
      // An attach in progress lands first; then it is undone below.
      const attaching = this.attachInFlight;
      if (attaching) await attaching.catch(() => undefined);
      await this.updateSettingsFile(withoutConsent);
      if (this.attached) await this.detach();
      // Withdrawing consent also takes the status line bridge out (F9, ADR-018); a line that is not ours stays.
      const notes = await this.restoreBridge();
      // ... and the self-report MCP server for attached sessions (F27, ADR-025), when it is the Huddle's.
      const mcp = await this.mcpRegistrar.removeIfOurs();
      this.refreshMcpRegistered();
      if (mcp.status === 'written')
        notes.push('removed the self-report MCP server (claude mcp remove --scope user huddle)');
      if (mcp.status === 'error')
        notes.push(`the self-report MCP server could not be removed: ${this.scrub(mcp.error)}`);
      this.logger.info('consent withdrawn');
      if (this.phase === 'running' && !this.quitting()) await this.runPrepareAttach();
      return notes.length > 0 ? { ok: true, notes } : { ok: true };
    } catch (error) {
      const message = `Could not remove the hooks: ${messageOf(error)}`;
      this.setupError = message;
      this.logger.error('withdraw consent failed', { error: messageOf(error) });
      return { ok: false, error: message };
    }
  }

  /**
   * F9: put the user's own status line back (or remove the key when they had none) and leave the hooks as they are.
   * A status line the user changed after the bridge was installed is left alone. An explicit owner action, so it
   * writes without the first-run screen; nothing else in settings.json changes.
   */
  async removeStatusLineBridge(): Promise<WithdrawResult> {
    if (this.disposeRequested || this.phase === 'disposing' || this.phase === 'disposed') {
      return { ok: false, error: SHUTTING_DOWN };
    }
    try {
      const attaching = this.attachInFlight;
      if (attaching) await attaching.catch(() => undefined);
      const notes = await this.restoreBridge();
      return notes.length > 0 ? { ok: true, notes } : { ok: true };
    } catch (error) {
      return { ok: false, error: `Could not remove the status line bridge: ${this.scrub(messageOf(error))}` };
    }
  }

  /**
   * Restores the user's status line (or removes the bridge key when they had none), hooks untouched. Returns the
   * installer's notes about the status line ("left as it is", "restore ..."); throws when it could not be written.
   */
  private async restoreBridge(): Promise<string[]> {
    const options = { keepHooks: true, restoreStatusLine: true, removeTelemetry: false } as const;
    for (let attempt = 0; attempt < 2; attempt++) {
      const prepared = await this.installer.prepareUninstall(options);
      if ('ok' in prepared) throw new Error(prepared.error);
      const result = await this.installer.apply(prepared, { consent: true });
      if (result.status === 'written' || result.status === 'unchanged') {
        const notes = [...prepared.plan.notes, ...prepared.plan.warnings].filter((n) =>
          /status line|statusLine/.test(n),
        );
        this.logger.info('status line bridge checked', { written: result.status === 'written' });
        return notes;
      }
      if (result.status === 'error') throw new Error(result.error);
    }
    throw new Error('Claude Code settings kept changing; try again.');
  }

  /**
   * Runs one attach and remembers it as in flight, so dispose can wait for it. If quit began while it ran and it
   * attached anyway, the hooks are removed again before it settles: a closing Huddle never leaves hooks behind.
   */
  private async guardAttach<T>(work: () => Promise<T>): Promise<T> {
    const run = (async () => {
      try {
        return await work();
      } finally {
        if (this.disposeRequested && this.attached) {
          await this.detach().catch((error: unknown) => {
            this.logger.error('detach after quit failed', { error: messageOf(error) });
          });
        }
      }
    })();
    this.attachInFlight = run;
    try {
      return await run;
    } finally {
      if (this.attachInFlight === run) this.attachInFlight = null;
    }
  }

  private afterApply(result: ApplyResult): AttachResult {
    switch (result.status) {
      case 'written':
      case 'unchanged':
        this.attached = true;
        this.pendingChange = null;
        this.setupError = null;
        this.logger.info('attached', { written: result.status === 'written' });
        return { status: 'attached', written: result.status === 'written' };
      case 'stale':
        this.pendingChange = result.prepared;
        this.setupError = null;
        return { status: 'stale', preview: previewOf(result.prepared) };
      case 'needs-consent':
        return { status: 'error', error: 'Consent is missing.' };
      case 'error':
        this.setupError = result.error;
        this.logger.error('attach failed', { error: result.error });
        return { status: 'error', error: result.error };
    }
  }

  /**
   * Start with consent on record. Attaches only when the change it would write is the one the owner approved (same
   * `consentFingerprint`); otherwise, including a consent saved before fingerprints were stored, the change is kept
   * as pending and the first-run screen shows it (`needs_consent`), nothing written. A `stale` here is a race with
   * another writer, so it is retried once, with the same check on the fresh plan.
   */
  private autoAttach(): Promise<void> {
    return this.guardAttach(async () => {
      const { port, token } = this;
      if (port === null || token === null) return;
      for (let attempt = 0; attempt < 2; attempt++) {
        if (this.quitting()) return;
        const prepared = await this.installer.prepareInstall({ port, token });
        if ('ok' in prepared) {
          this.setupError = prepared.error;
          this.logger.error('attach failed', { error: prepared.error });
          return;
        }
        if (!this.hasConsentFor(prepared.plan.consentFingerprint)) {
          this.pendingChange = prepared;
          this.setupError = null;
          this.logger.info('the hook change differs from the one consented to; asking again');
          return;
        }
        const result = await this.installer.apply(prepared, { consent: true });
        if (result.status === 'stale' && !this.hasConsentFor(result.prepared.plan.consentFingerprint)) {
          this.pendingChange = result.prepared;
          this.setupError = null;
          return;
        }
        const outcome = this.afterApply(result);
        if (outcome.status !== 'stale') return;
      }
      this.pendingChange = null;
      this.setupError = 'Claude Code settings kept changing while Agent Huddle tried to add its hooks.';
    });
  }

  /** Quit: remove the Huddle's hooks; telemetry env vars stay (a stopped Huddle makes them silent). */
  private async detach(): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await this.installer.uninstall({ removeTelemetry: false }, { consent: true });
      if (result.status === 'written' || result.status === 'unchanged') {
        this.attached = false;
        this.logger.info('detached', { written: result.status === 'written' });
        return;
      }
      if (result.status === 'error') throw new Error(result.error);
    }
    throw new Error('Claude Code settings kept changing while Agent Huddle tried to remove its hooks.');
  }

  /** The token from agent-huddle/config.json, so it matches settings.json; a new one (kept in memory) otherwise. */
  private async resolveToken(): Promise<string> {
    try {
      const raw: unknown = JSON.parse(stripBom(await fsp.readFile(this.installer.configPath, 'utf8')));
      if (isRecord(raw) && typeof raw.token === 'string' && TOKEN_PATTERN.test(raw.token)) return raw.token;
    } catch {
      // Missing or unreadable: make a new one. It is written to config.json only on attach, after consent.
    }
    return this.makeToken();
  }

  private makeToken(): string {
    const token = this.deps.newToken ? this.deps.newToken() : randomBytes(32).toString('base64url');
    if (!TOKEN_PATTERN.test(token)) throw new Error('newToken must return at least 8 URL-safe characters');
    return token;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Ingest
  // -------------------------------------------------------------------------------------------------------------------

  private onHook(result: ParseHookResult, receivedAt: number): void {
    if (!result.ok) {
      // result.error lists field paths and codes only, never payload text.
      this.counters.unrecognizedHooks += 1;
      this.logger.warn('unrecognized hook payload', { error: result.error });
      return;
    }
    // Normal path (M3): `decideHook` already normalized and accepted this hook before it was answered.
    if (this.normalizedEarly.has(result)) return;
    this.acceptHook(result, receivedAt);
  }

  /**
   * Normalize, accept, and record messages the reducer dropped because their agent ended. Returns the events, or null
   * when the hook belongs to an Ask the Huddle session (F25, ask-guard.ts) and was dropped.
   */
  private acceptHook(result: AcceptedHook, receivedAt: number): HuddleEvent[] | null {
    const before = this.state;
    const normalized = normalizeHook(result, {
      receivedAt: isoOf(receivedAt),
      nextId: this.nextId,
      holdTimeouts: HOOK_HOLD_TIMEOUTS_S,
    });
    const events = this.askGuard.admitHook(normalized);
    if (normalized.length > 0 && events.length === 0) return null;
    void this.accept(events);
    if (events.length > 0 && before !== this.state) {
      const dropped = droppedByEnd(before, this.state, events, { now: receivedAt, nextId: this.nextId });
      void this.accept(dropped);
    }
    return events;
  }

  /**
   * The server asks how to answer an accepted hook, before anything is written (20 ms budget, no I/O, no awaits).
   *
   * Correlation: the hook is normalized and reduced *here*, first, so the broker decides from the reducer's state with
   * this hook's own events in it, and learns the request id straight from them: `approval.requested.request.requestId`
   * (made by `nextId` in the normalizer) for a PermissionRequest, `question.asked.request.requestId` (the tool_use_id)
   * for AskUserQuestion. No second id scheme, no guessing which event belongs to which held request. The events are
   * written by the store asynchronously, as always; `onHook` later skips this result (`normalizedEarly`).
   *
   * The raw pieces the broker needs from the payload (exact question text and labels, tool input, stop_hook_active)
   * come through `hookFacts` (normalize/), so the broker never reads a payload field itself.
   */
  private decideHook(result: AcceptedHook, receivedAt: number): HookDecision {
    if (this.phase === 'disposed') {
      this.normalizedEarly.add(result);
      return { now: null };
    }
    // Marked only once accepted: if acceptHook throws, the server answers with no decision (fail open) and the
    // `onHook` pass that follows accepts the hook's events instead of skipping them.
    const events = this.acceptHook(result, receivedAt);
    this.normalizedEarly.add(result);
    // An Ask the Huddle session's hook (none expected: its hooks are disabled) is answered at once with no decision.
    if (events === null) return { now: null };
    let approvalRequestId: string | null = null;
    let questionRequestId: string | null = null;
    for (const e of events) {
      if (e.type === 'approval.requested') approvalRequestId = e.request.requestId;
      if (e.type === 'question.asked') questionRequestId = e.request.requestId;
    }
    return this.broker.onHook(result, hookFacts(result), receivedAt, { approvalRequestId, questionRequestId });
  }

  private onTelemetryLogs(body: unknown, receivedAt: number): void {
    const parsed = parseOtlpLogs(body);
    if (!parsed.ok) {
      this.counters.unrecognizedTelemetry += 1;
      this.logger.warn('unrecognized telemetry payload', { error: parsed.error });
      return;
    }
    const events = normalizeTelemetry(parsed.records, { receivedAt: isoOf(receivedAt), nextId: this.nextId });
    // F25: an ask's telemetry (the OTEL env is in the user's settings, which disableAllHooks does not touch) is held
    // while the ask runs and dropped once its session id is known (ask-guard.ts).
    void this.accept(this.askGuard.admitOther(events, (id) => this.knowsSession(id)));
  }

  /** F9: a status line post (already answered by the server). */
  private onStatusline(result: ParseStatuslineResult, receivedAt: number): void {
    if (!result.ok) {
      this.counters.unrecognizedStatusline += 1;
      this.logger.warn('unrecognized status line payload', { error: result.error });
      return;
    }
    const events = normalizeStatusline(result.payload, { receivedAt: isoOf(receivedAt), nextId: this.nextId });
    void this.accept(this.askGuard.admitOther(this.statuslineThrottle.admit(events), (id) => this.knowsSession(id)));
  }

  /** Reduce, mirror, queue for listeners, then write. A failed write is logged; the event stays in memory. */
  private accept(events: readonly HuddleEvent[]): Promise<boolean> {
    // After quit the log is closed; a late handler call (a request answered during close) is dropped.
    if (events.length === 0) return Promise.resolve(true);
    if (this.storeClosing || this.phase === 'disposed') {
      this.counters.eventsDroppedAtClose += events.length;
      return Promise.resolve(false);
    }
    const raised: HuddleEvent[] = [];
    const budgetActions: BudgetAction[] = [];
    const leadChecks: LeadCheckRequest[] = [];
    for (const event of events) {
      this.state = reduce(this.state, event);
      this.remember(event);
      // An overall budget.set is filed under a session of its own (BUDGET_SESSION_ID): never read roles for it, a
      // role.described there would make it a root in the tree.
      if (event.type !== 'budget.set') this.noticeSession(event.sessionId);
      raised.push(...this.detect(event));
      const budget = this.budgetStep(event);
      raised.push(...budget.emit);
      budgetActions.push(...budget.actions);
      // F29: a task's run ended; its outcome is written to the task (accepted with the detector output below).
      raised.push(...this.taskStep(event));
      const check = this.leadCheckStep(event);
      if (check !== null) leadChecks.push(check);
    }
    this.queue.push(...events);
    this.scheduleEmit();
    // M6: live phone streams get the new view (throttled, and only when what a phone sees changed).
    this.phone.notifyChanged();
    // Detector output goes through here too (the detectors ignore attention events, so this does not recurse further).
    if (raised.length > 0) void this.accept(raised);
    // After this batch is in: the actions write events of their own (pause, stop, the finished item).
    this.carryOutBudget(budgetActions);
    // M6 P5b: the lead checks this batch asked for, through the outbox (their message.queued is accepted on its own).
    this.sendLeadChecks(leadChecks);
    return this.track(
      this.store.append(events).then(
        () => {
          // M5: a run that ended in this batch gets its report, after the batch is stored and off this path.
          this.history?.noteStored(events);
          return true;
        },
        (error: unknown) => {
          this.counters.storeErrors += 1;
          this.logger.error('could not write events', { error: messageOf(error), count: events.length });
          return false;
        },
      ),
    );
  }

  /** One live event through the detectors (F21); thresholds are the user's current settings. Never throws. */
  private detect(event: HuddleEvent): HuddleEvent[] {
    try {
      const out = detectStep(this.detectors, event, this.userSettings.detectors, this.userSettings.roleKinds ?? null);
      this.detectors = out.state;
      return out.emit;
    } catch (error) {
      this.logger.error('detector step failed', { error: messageOf(error) });
      return [];
    }
  }

  /** One event through the task outcome step (F29). Never throws: a failure there must not stop the batch. */
  private taskStep(event: HuddleEvent): HuddleEvent[] {
    try {
      return this.orch.runStep(event);
    } catch (error) {
      this.logger.error('task step failed', { error: messageOf(error) });
      return [];
    }
  }

  /**
   * One live event through the lead check (M6 P5b, ADR-027). Only while running: replayed and imported events never
   * reach it (they are reduced directly). Never throws.
   */
  private leadCheckStep(event: HuddleEvent): LeadCheckRequest | null {
    if (this.phase !== 'running' || this.quitting()) return null;
    try {
      const step = leadCheckStep(this.leadCheck, this.state, event, {
        enabled: this.userSettings.teams?.askLeadOnIdle ?? true,
        serverAvailable: (lead) => this.huddleMcpAvailable(lead),
      });
      this.leadCheck = step.memo;
      return step.request;
    } catch (error) {
      this.logger.error('lead check failed', { error: messageOf(error) });
      return null;
    }
  }

  /**
   * Is the Huddle MCP server (and so report_teammate) available to this lead? A managed run started with it (self-report
   * on), or the user-scope registration is active (attached sessions, and managed runs too: no --strict-mcp-config,
   * ADR-025). From memory only: the hook path never reads .claude.json.
   */
  private huddleMcpAvailable(lead: AgentNode): boolean {
    const runId = lead.run?.runId;
    if (runId !== undefined && this.runs.hasSelfReport(runId)) return true;
    return this.huddleMcpRegistered === true;
  }

  /** Queues each lead check as a message from the Huddle and records it (lead-check.ts dedupe). Never throws. */
  private sendLeadChecks(requests: readonly LeadCheckRequest[]): void {
    const sent = new Set<string>();
    for (const request of requests) {
      if (sent.has(request.teammateKey)) continue;
      sent.add(request.teammateKey);
      try {
        const { result, messageId } = this.broker.messageByHuddle(request.leadKey, request.text, 'auto');
        if (!result.ok || messageId === null) {
          this.logger.info('lead check not queued', { code: result.ok ? 'no message' : result.code });
          continue;
        }
        const lead = Object.hasOwn(this.state.agents, request.leadKey) ? this.state.agents[request.leadKey] : undefined;
        this.leadCheck = leadCheckSent(this.leadCheck, request, lead?.sessionId ?? '', messageId);
        this.logger.info('lead check queued for an idle teammate');
      } catch (error) {
        this.logger.error('lead check could not be queued', { error: messageOf(error) });
      }
    }
  }

  /** Reads whether the Huddle's MCP server is registered for the user, in the background. Never throws. */
  private refreshMcpRegistered(): void {
    void this.track(
      this.mcpRegistrar.isRegistered().then(
        (registered) => {
          this.huddleMcpRegistered = registered;
        },
        () => {
          this.huddleMcpRegistered = false;
        },
      ),
    );
  }

  /** One live event through the budget detector (F19). Never throws. */
  private budgetStep(event: HuddleEvent): BudgetStep {
    try {
      return this.takeBudgetStep(stepBudget(this.budgetDetector, this.state, event, this.startedAt));
    } catch (error) {
      this.logger.error('budget detector failed', { error: messageOf(error) });
      return { state: this.budgetDetector, emit: [], actions: [] };
    }
  }

  /** Adopt the detector's new state at once, so events the actions write are folded against it (no second action). */
  private takeBudgetStep(step: BudgetStep): BudgetStep {
    this.budgetDetector = step.state;
    return step;
  }

  /** Pause, stop, then raise the item with what happened (runtime/budget-runner.ts). In the background; never throws. */
  private carryOutBudget(actions: readonly BudgetAction[]): void {
    for (const action of actions) {
      if (this.quitting() || this.phase === 'disposed') return;
      const work = carryOutBudgetAction(action, {
        pause: (agentKey, detail) => this.broker.pauseByHuddle(agentKey, detail),
        // The budget runner writes its own control.applied stop (source huddle) on this path.
        stopRun: this.deps.stopRun ?? ((runId) => this.runs.stopRun(runId)),
        accept: (events) => {
          void this.accept(events);
        },
        now: this.now,
        nextId: this.nextId,
      }).then(
        (outcome) => {
          this.logger.info('budget action carried out', {
            reason: action.reason,
            onExceed: action.onExceed,
            stopped: outcome.stopped,
            stopFailed: outcome.stopFailed.length,
            paused: outcome.pausedManaged + outcome.pausedAttached + outcome.pausedInstead,
            pauseFailed: outcome.pauseFailed,
          });
        },
        (error: unknown) => {
          this.logger.error('budget action failed', { error: messageOf(error) });
        },
      );
      void this.track(work);
    }
  }

  private remember(event: HuddleEvent): void {
    let list = this.recent.get(event.agentKey);
    if (!list) {
      list = [];
      this.recent.set(event.agentKey, list);
    }
    list.push(event);
    if (list.length > MAX_AGENT_EVENTS) list.splice(0, list.length - MAX_AGENT_EVENTS);
  }

  /**
   * The project folder whose `.claude/agents` describe this session's roles: the session root's `cwd` from state
   * (set by session.started, so no payload field is read here), else the app's fixed `deps.cwd`.
   */
  private sessionCwd(sessionId: string): string | null {
    const root = Object.hasOwn(this.state.agents, sessionId) ? this.state.agents[sessionId] : undefined;
    return root?.cwd ?? this.deps.cwd;
  }

  private describeKey(sessionId: string, cwd: string | null): string {
    return `${sessionId}\u0000${cwd ?? ''}`;
  }

  /**
   * Role descriptions: read once per (session, folder), when a session shows up live and again if its folder
   * becomes known later (the first event seen may precede SessionStart). Replayed sessions whose role.described
   * events are already in the log are not read again for the same folder. Reading per session, rather than once at
   * start, picks up agent definitions added while the Huddle runs.
   */
  private noticeSession(sessionId: string): void {
    // No root (yet): an event filed under a placeholder (a runId before its session is known, the budgets' own id)
    // or a run event that came before run.launched. A role.described there would make a root that is not a session.
    // Not marked as described, so the session is read once its root exists.
    if (!Object.hasOwn(this.state.agents, sessionId)) return;
    const cwd = this.sessionCwd(sessionId);
    const key = this.describeKey(sessionId, cwd);
    if (this.describedRoots.has(key)) return;
    this.describedRoots.add(key);
    if (cwd === null && this.deps.userAgentsDir === null) return;
    void this.track(this.describeRoles(sessionId, cwd));
  }

  private async describeRoles(sessionId: string, cwd: string | null): Promise<void> {
    try {
      const roles = await readAgentRoles({ cwd, userAgentsDir: this.deps.userAgentsDir });
      if (roles.length === 0 || this.phase === 'disposed') return;
      await this.accept(roleDescribedEvents(roles, { sessionId, ts: this.now(), nextId: this.nextId }));
    } catch (error) {
      this.logger.warn('could not read agent definitions', { error: messageOf(error) });
    }
  }

  private track<T>(work: Promise<T>): Promise<T> {
    this.inFlight.add(work);
    void work.finally(() => this.inFlight.delete(work));
    return work;
  }

  /**
   * M5: the M1-M4 JSONL history (`<dataDir>/events`) goes into the database once (store/migrate-jsonl.ts), before the
   * replay, so the first start on SQLite shows what the last start on JSONL showed. A failure is logged and the start
   * goes on with what the database holds; nothing is marked done, so the next start tries again (the import skips
   * events it stored already). Nothing is deleted: the folder is renamed to `events.migrated-<date>`.
   *
   * Rollback to a JSONL build: quit, rename `events.migrated-<date>` back to `events`, move or delete
   * `huddle.sqlite` (with `-wal` and `-shm`), start the older build. Events recorded since the switch are only in the
   * database.
   */
  private async importJsonlHistory(): Promise<void> {
    if (!(this.store instanceof SqliteEventStore)) return;
    this.importing = true;
    try {
      const report = await migrateJsonlToSqlite({
        eventsDir: path.join(path.resolve(this.deps.dataDir), 'events'),
        store: this.store,
        now: this.now,
        logger: this.logger,
      });
      if (report.status !== 'already_done' && report.status !== 'no_source') {
        this.logger.info('JSONL history import', { status: report.status, events: report.distinctEvents });
      }
    } catch (error) {
      this.logger.error('could not import the JSONL history; it is kept and tried again next start', {
        error: messageOf(error),
      });
    } finally {
      this.importing = false;
    }
  }

  /**
   * Start-up replay (M5, owner's decisions): only sessions that have not ended, sessions active in the last 24 hours,
   * the overall budgets' pseudo session, runs still listed in runs.json and, while an overall budget is in force,
   * sessions active since it was set are loaded into the state (runtime/replay-window.ts). Older sessions stay in the database for the history view. Every session is read in
   * chunks with a yield between chunks and between sessions. The JSONL fallback (database not openable) replays
   * everything, as M1-M4 did.
   */
  private async replayStore(): Promise<void> {
    const store = this.store;
    let sessionIds: string[];
    let known: number;
    if (store instanceof SqliteEventStore) {
      const records = await store.listSessionRecords();
      known = records.length;
      const always = [BUDGET_SESSION_ID, TASKS_SESSION_ID, ...(await this.registeredRunIds())];
      // The overall budget's log is read first: while one is in force, every session since its setAt is loaded too,
      // so the budget keeps counting what ran under it across a restart (replay-window.ts).
      let activeSince: number | null = null;
      try {
        const budgetEvents: HuddleEvent[] = [];
        for await (const event of store.readSession(BUDGET_SESSION_ID)) budgetEvents.push(event);
        activeSince = activeOverallBudgetSince(budgetEvents);
      } catch (error) {
        this.logger.warn('could not read the overall budgets before the replay', { error: messageOf(error) });
      }
      // The Huddle's own history session (history.pruned) is never replayed: what it names is gone from the database,
      // and a session that came back after its prune must not be dropped by an older prune record read after it.
      sessionIds = selectReplaySessions(
        records.filter((r) => r.sessionId !== HISTORY_SESSION_ID && r.sessionId !== PHONE_SESSION_ID),
        { now: this.now(), always, activeSince },
      ).map((r) => r.sessionId);
    } else {
      const sessions = await store.listSessions();
      known = sessions.length;
      sessionIds = sessions
        .sort((a, b) => a.firstTs - b.firstTs || a.sessionId.localeCompare(b.sessionId))
        .map((s) => s.sessionId);
    }
    let count = 0;
    const replayed = new Set<string>();
    for (const sessionId of sessionIds) {
      if (this.quitting()) return;
      try {
        for await (const event of store.readSession(sessionId)) {
          this.state = reduce(this.state, event);
          this.remember(event);
          replayed.add(event.sessionId);
          count += 1;
        }
      } catch (error) {
        this.logger.warn('could not replay a session', { error: messageOf(error) });
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    // A replayed session was described when it was live (its role.described events are in the log): not read
    // again for the folder it had. It is read once more only if a later SessionStart reports another folder.
    for (const sessionId of replayed) this.describedRoots.add(this.describeKey(sessionId, this.sessionCwd(sessionId)));
    this.logger.info('replayed event log', { sessions: sessionIds.length, stored: known, events: count });
  }

  /** Run ids in runs.json: loaded at start-up whatever their age, so `reconcileOrphans` sees them in the state. */
  private async registeredRunIds(): Promise<string[]> {
    try {
      const file = await new RunRegistry({ dataDir: this.deps.dataDir, now: this.now }).read();
      return file.entries.map((entry) => entry.runId);
    } catch (error) {
      this.logger.warn('runs.json could not be read before the replay', { error: messageOf(error) });
      return [];
    }
  }

  /**
   * F13: a pause asked for in an earlier Huddle run and still waiting for the agent's next tool call (`pausePending`
   * after replay) was not asked for in this run, so it is called off: one `control.applied resume` (source `huddle`)
   * per such agent, appended to the log like any other fact. Runs after replay and before the server opens, so no
   * PreToolUse can be held for it in between. Holds themselves never survive a restart (their connections are gone).
   */
  private callOffEarlierPauses(): void {
    const ts = this.now();
    const events: HuddleEvent[] = Object.values(this.state.agents)
      .filter((node) => node.pausePending === true)
      .map((node) => ({
        id: this.nextId(),
        type: 'control.applied',
        ts,
        sessionId: node.sessionId,
        agentKey: node.key,
        source: 'huddle',
        action: 'resume',
        detail: null,
      }));
    if (events.length === 0) return;
    this.logger.info('called off pauses from an earlier run', { count: events.length });
    void this.accept(events);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Phone access (M6, F26)
  // -------------------------------------------------------------------------------------------------------------------

  /**
   * `setup.selfReport.register` / `unregister` (F27, ADR-025): runs `claude mcp add|remove --scope user huddle` only
   * when the fresh plan is the one the user saw (`fingerprint`). Writes no event: this is configuration of Claude Code,
   * like the hook install. Never writes `.claude.json` itself.
   */
  private async selfReportCommand(mode: 'register' | 'unregister', fingerprint: string): Promise<CommandResult> {
    const result = await this.mcpRegistrar.apply({ mode, fingerprint }, { consent: true });
    this.refreshMcpRegistered();
    return this.selfReportResult(result);
  }

  private selfReportResult(result: McpApplyResult): CommandResult {
    switch (result.status) {
      case 'written':
        this.logger.info('self-report registration changed', { mode: result.preview.mode });
        return { ok: true };
      case 'unchanged':
        return { ok: true, detail: 'Nothing to change.' };
      case 'stale':
        return {
          ok: false,
          code: 'expired',
          message: 'What is registered changed since the preview. Look at the new preview and try again.',
        };
      case 'refused':
        return { ok: false, code: 'unsupported', message: result.preview.refusal ?? 'Not possible now.' };
      case 'needs-consent':
        return { ok: false, code: 'invalid', message: 'Consent is missing.' };
      case 'error':
        this.logger.warn('self-report registration failed', { error: this.scrub(result.error) });
        return { ok: false, code: 'failed', message: this.scrub(result.error) };
    }
  }

  /**
   * The M6 commands, checked again here (the host may not be desktop main): `phone.enable` / `phone.disable` /
   * `phone.pair` / `phone.revoke`, and `setup.selfReport.register` / `unregister` (`selfReportCommand`). The pairing code
   * comes back in the result (`phonePairing`), never in an event or a file.
   */
  private async phoneCommand(cmd: unknown): Promise<CommandResult> {
    const parsed = parseM6Command(cmd);
    if (parsed === null) return { ok: false, code: 'invalid', message: 'That command is not well formed.' };
    switch (parsed.type) {
      case 'setup.selfReport.register':
        return this.selfReportCommand('register', parsed.fingerprint);
      case 'setup.selfReport.unregister':
        return this.selfReportCommand('unregister', parsed.fingerprint);
      case 'phone.enable': {
        if (this.phase !== 'running') {
          return { ok: false, code: 'failed', message: 'Agent Huddle is not running, so phone access cannot start.' };
        }
        const port = parsed.port ?? this.userSettings.phone?.port ?? PHONE_DEFAULT_PORT;
        return this.phone.enable(parsed.ip, port);
      }
      case 'phone.disable':
        return this.phone.disable('user');
      case 'phone.pair':
        return this.phone.pair();
      case 'phone.revoke':
        return this.phone.revoke(parsed.deviceId === 'all' ? { all: true } : { deviceId: parsed.deviceId });
    }
  }

  /** What a paired phone sees now: `selectPhoneView`, every string masked again (and the ingest token scrubbed). */
  private phoneView(): PhoneView {
    const startedAt = this.startedAt;
    const view = selectPhoneView(
      this.getState(),
      this.now(),
      startedAt !== null ? { huddleStartedAt: startedAt } : undefined,
    );
    return maskPhoneView(view, (text) => this.scrub(maskSecrets(text)));
  }

  /**
   * A phone's Approve or Deny: only for an approval the phone view lists (open, in a live session, not expired), and
   * through the broker's own path with `via: 'phone'`, so the four endings and "a second decision is expired" hold
   * exactly as for the desktop.
   */
  private phoneDecide(requestId: string, decision: 'allow' | 'deny'): CommandResult {
    if (this.quitting() || this.phase !== 'running') return { ok: false, code: 'failed', message: SHUTTING_DOWN };
    const view = this.phoneView();
    if (!phoneViewHasApproval(view, requestId)) {
      const known = this.state.inbox.some((i) => i.kind === 'approval' && i.approval?.requestId === requestId);
      return known
        ? { ok: false, code: 'expired', message: 'This request was already answered or has timed out.' }
        : { ok: false, code: 'not_found', message: 'That request is not known.' };
    }
    // A summary that hides part of the command (a masked secret, or cut at the limit) is not enough to allow on (AX-01):
    // the phone may deny it, and allowing is left to the computer, where the terminal shows the whole command.
    if (
      decision === 'allow' &&
      view.inbox.some((i) => i.kind === 'approval' && i.requestId === requestId && i.hidden)
    ) {
      return { ok: false, code: 'invalid', message: PHONE_HIDDEN_ALLOW };
    }
    return this.broker.command({ type: 'approval.decide', requestId, decision }, { via: 'phone' });
  }

  /**
   * One action from a paired phone (ADR-030), on the explicit allowlist the listener already enforced. The target must
   * be in the phone view now (a live session, an open question) and the view's control for it must be enabled, which
   * is the desktop's rule from `AgentNode.capabilities` (`selectControls`, `selectRunControls`). The command is then
   * built field by field and runs through the desktop's own path with `via: 'phone'`: the broker for answers, messages,
   * pause and resume (so the four endings of a held question hold as for the desktop), the run host for a managed
   * root's live message and for stop. Typed text is clipped to CLIP_LIMITS.message; a typed answer is masked in the log
   * by the broker, and a message is stored as the desktop stores it.
   */
  private async phoneAct(action: PhoneAction): Promise<CommandResult> {
    if (this.quitting() || this.phase !== 'running') return { ok: false, code: 'failed', message: SHUTTING_DOWN };
    const view = this.phoneView();
    const via = { via: 'phone' as const };
    if (action.type === 'question.answer') {
      const shown = phoneViewQuestion(view, action.requestId);
      const item = this.state.inbox.find(
        (i) => i.kind === 'question' && i.resolvedAt === null && i.question?.requestId === action.requestId,
      );
      const display = item?.question;
      if (shown === null || display === undefined) {
        const known = this.state.inbox.some((i) => i.kind === 'question' && i.question?.requestId === action.requestId);
        return known
          ? { ok: false, code: 'expired', message: 'This question was already answered or closed.' }
          : { ok: false, code: 'not_found', message: PHONE_CONTROL_REASONS.notInView };
      }
      if (!shown.answer.enabled) {
        return { ok: false, code: 'unsupported', message: shown.answer.reason ?? 'Answer this one on the computer.' };
      }
      if (action.answers.length !== display.questions.length) {
        return { ok: false, code: 'invalid', message: 'Answer every question.' };
      }
      // Indexes into the options as the inbox shows them (not the phone's masked copy), so the labels match exactly.
      const answers: Record<string, string[]> = {};
      const other: Record<string, string> = {};
      for (const [index, q] of display.questions.entries()) {
        const part = action.answers[index];
        if (part === undefined) return { ok: false, code: 'invalid', message: 'Answer every question.' };
        const labels: string[] = [];
        for (const choice of [...new Set(part.choices)].sort((a, b) => a - b)) {
          const option = q.options[choice];
          if (option === undefined) {
            return { ok: false, code: 'invalid', message: 'That choice is not one of the options.' };
          }
          labels.push(option.label);
        }
        answers[q.question] = labels;
        const typed = clip((part.other ?? '').trim(), CLIP_LIMITS.message);
        if (typed !== '') other[q.question] = typed;
      }
      return this.broker.command(
        {
          type: 'question.answer',
          requestId: action.requestId,
          answers,
          ...(Object.keys(other).length > 0 ? { other } : {}),
        },
        via,
      );
    }
    const agent = phoneViewAgent(view, action.agentKey);
    const node = Object.hasOwn(this.state.agents, action.agentKey) ? this.state.agents[action.agentKey] : undefined;
    if (agent === null || node === undefined) {
      return { ok: false, code: 'not_found', message: PHONE_CONTROL_REASONS.notInView };
    }
    const refuse = (reason: string | null): CommandResult => ({
      ok: false,
      code: 'unsupported',
      message: reason ?? 'Not possible from the phone now.',
    });
    switch (action.type) {
      case 'agent.message': {
        if (!agent.controls.message.enabled || node.capabilities.message === 'none') {
          return refuse(agent.controls.message.reason);
        }
        const text = clip(action.text.trim(), CLIP_LIMITS.message);
        if (text === '') return { ok: false, code: 'invalid', message: 'The message is empty.' };
        const cmd = { type: 'agent.message' as const, agentKey: node.key, text, delivery: PHONE_MESSAGE_DELIVERY };
        return this.runs.message(cmd, 'phone') ?? this.broker.command(cmd, via);
      }
      case 'agent.pause':
        if (!agent.controls.pause.enabled || !node.capabilities.pause) return refuse(agent.controls.pause.reason);
        return this.broker.command({ type: 'agent.pause', agentKey: node.key }, via);
      case 'agent.resume':
        if (!agent.controls.resume.enabled || !node.capabilities.pause) return refuse(agent.controls.resume.reason);
        return this.broker.command({ type: 'agent.resume', agentKey: node.key }, via);
      case 'agent.stop': {
        const runId = node.kind === 'main' ? node.run?.runId : undefined;
        if (!agent.controls.stop.enabled || !node.capabilities.stop || runId === undefined) {
          return refuse(agent.controls.stop.reason);
        }
        return this.runs.stop(runId, 'phone');
      }
    }
  }

  /** Remembers the chosen address and port (Settings offers them next time). */
  private async savePhoneChoice(ip: string, port: number): Promise<void> {
    await this.updateSettingsFile((file) =>
      withUserSettings(file, parseUserSettings({ ...userSettingsOf(file), phone: { ip, port } })),
    );
    this.connectionDirty = true;
    this.scheduleEmit();
  }

  /** Tests: the phone host (address, devices, the auto-off check). */
  phoneHostForTests(): PhoneHost {
    return this.phone;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------------------------------------------------

  /** ADR-015: a nickname is a `control.applied` rename event. Trimmed, clipped; empty clears it. */
  private async rename(agentKey: unknown, name: unknown): Promise<CommandResult> {
    if (typeof agentKey !== 'string' || typeof name !== 'string') {
      return { ok: false, code: 'invalid', message: 'Rename needs an agent and a name.' };
    }
    const node = Object.hasOwn(this.state.agents, agentKey) ? this.state.agents[agentKey] : undefined;
    if (!node) return { ok: false, code: 'not_found', message: 'That agent is not known.' };
    const trimmed = name.trim();
    const clipped = trimmed.length > CLIP_LIMITS.summary ? trimmed.slice(0, CLIP_LIMITS.summary).trimEnd() : trimmed;
    const saved = await this.accept([
      {
        id: this.nextId(),
        type: 'control.applied',
        ts: this.now(),
        sessionId: node.sessionId,
        agentKey,
        source: 'user',
        action: 'rename',
        detail: clipped === '' ? null : clipped,
      },
    ]);
    if (!saved) {
      return {
        ok: false,
        code: 'failed',
        message: 'The new name is shown but could not be saved; it is lost on restart.',
      };
    }
    // M5 WP5: a nickname kept in the settings (after its history was deleted) follows the rename, so clearing a name
    // clears it there too and the kept one does not come back.
    if (Object.hasOwn(this.userSettings.nicknames, agentKey)) {
      try {
        await this.updateSettingsFile((file) => {
          const user = userSettingsOf(file);
          const nicknames: Record<AgentKey, string> = { ...user.nicknames };
          if (clipped === '') Reflect.deleteProperty(nicknames, agentKey);
          else
            Object.defineProperty(nicknames, agentKey, {
              value: clipped,
              enumerable: true,
              writable: true,
              configurable: true,
            });
          return withUserSettings(file, parseUserSettings({ ...user, nicknames }));
        });
      } catch (error) {
        this.logger.warn('could not update a kept nickname', { error: messageOf(error) });
      }
    }
    return { ok: true };
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Listeners
  // -------------------------------------------------------------------------------------------------------------------

  private scheduleEmit(): void {
    if (this.emitTimer !== null || this.phase === 'disposed') return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      this.flushListeners();
    }, this.batchIntervalMs);
    this.emitTimer.unref();
  }

  private flushListeners(): void {
    if (this.emitTimer !== null) {
      clearTimeout(this.emitTimer);
      this.emitTimer = null;
    }
    if (this.queue.length === 0 && !this.connectionDirty) return;
    // An empty batch means "connection changed, read the state again" (ADR-017).
    const batch = this.queue;
    this.queue = [];
    this.connectionDirty = false;
    for (const listener of [...this.listeners]) {
      try {
        listener(batch);
      } catch (error) {
        this.counters.listenerErrors += 1;
        this.logger.error('events listener failed', { error: messageOf(error) });
      }
    }
  }

  // -------------------------------------------------------------------------------------------------------------------

  stats(): HuddleCoreStats {
    return {
      server: this.server ? this.server.stats() : null,
      store: this.store.stats(),
      storeKind: this.store instanceof SqliteEventStore ? 'sqlite' : 'jsonl-fallback',
      ...this.counters,
    };
  }
}
