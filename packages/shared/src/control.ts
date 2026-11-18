/**
 * Commands: everything the UI (desktop window, widget, later the phone) may ask the core to do.
 * The renderer never talks to Claude Code directly. It sends a HuddleCommand over IPC and
 * receives a CommandResult; state changes come back as HuddleEvents like everything else.
 */
import type { AgentKey, Budget, PolicyRule, TeamTemplate } from './model.js';
import type { HuddleTaskStatus, SkillFile, SkillsAnswer } from './orch.js';
import type { PhoneAddress, PhonePairing } from './phone.js';
import type {
  AskAnswer,
  AskErrorKind,
  AskPreview,
  AskTurn,
  HistoryCursor,
  HistoryOutcome,
  HistoryPage,
  HistorySearchPage,
  HistoryStats,
  ReplayEventsPage,
  ReplayMoment,
  ReportAnswer,
  RetentionPreview,
  RunHead,
  ScorecardsAnswer,
} from './remember.js';
import type { SelfReportRegistrationMode, SelfReportRegistrationPreview } from './self-report.js';
import type { UserSettingsPatch } from './settings.js';

export type HuddleCommand =
  // inbox
  | { type: 'approval.decide'; requestId: string; decision: 'allow' | 'deny'; message?: string; remember?: boolean }
  /**
   * Answer with no decision, so Claude Code's own prompt is how the user answers. Also "Answer in terminal" for a held
   * question: send it with the question's `requestId` (QuestionRequest.requestId); the question closes `passed_through`.
   */
  | { type: 'approval.passThrough'; requestId: string }
  | {
      type: 'question.answer';
      requestId: string;
      /** Per question text: one option label, or several for a multi-select question. */
      answers: Record<string, string | string[]>;
      /** Per question text: the user's own typed answer ("Other"); for multi-select it follows the chosen labels. */
      other?: Record<string, string>;
      /** Older form of a typed answer for a one-question call; `other` is preferred. */
      freeText?: string;
    }
  | { type: 'attention.dismiss'; itemId: string }
  // one agent
  | { type: 'agent.message'; agentKey: AgentKey; text: string; delivery: 'auto' | 'next_tool' | 'turn_end' }
  // M3: take back a queued message before it is delivered
  | { type: 'message.cancel'; agentKey: AgentKey; messageId: string }
  | { type: 'agent.pause'; agentKey: AgentKey }
  | { type: 'agent.resume'; agentKey: AgentKey }
  | { type: 'agent.stop'; agentKey: AgentKey }
  | { type: 'agent.setModel'; agentKey: AgentKey; model: string }
  | { type: 'agent.rename'; agentKey: AgentKey; name: string }
  // everything at once (command palette)
  | { type: 'all.pause' }
  | { type: 'all.resume' }
  | { type: 'all.stop' }
  | { type: 'approval.allowAllMatchingPolicy' }
  // team templates (M4, F16): stored by main in templates.json
  | { type: 'template.upsert'; template: TeamTemplate }
  | { type: 'template.remove'; templateId: string }
  /**
   * Runs (M4, ADR-020). run.launch: give exactly one of `templateId` (a stored template) and `template` (an inline
   * one, not stored); `promptOverride` replaces the template's prompt. Once the process has started the result is
   * `{ ok: true, detail: <runId> }` (the runId is also the run's Claude Code session id). The other run commands name
   * the run by the `runId` on its root (`AgentNode.run.runId`).
   */
  | { type: 'run.launch'; templateId?: string; template?: TeamTemplate; promptOverride?: string }
  /** Stop the run's process (F13). */
  | { type: 'run.stop'; runId: string }
  /** Close the run's stdin, so it exits when its current turn ends. */
  | { type: 'run.end'; runId: string }
  | { type: 'run.keepWorktree'; runId: string }
  /** Remove the worktree and its branch; refused while the run's process is alive or for a path the Huddle did not make. */
  | { type: 'run.discardWorktree'; runId: string }
  /**
   * Open the worktree folder in VS Code (F20). The core answers `{ ok: true, detail: <the worktree folder> }` (only a
   * folder the Huddle made for this run and that still exists); desktop main opens that path.
   */
  | { type: 'run.openWorktree'; runId: string }
  // configuration
  /** Add or replace an approval rule by id (F18); stored by main in policy-rules.json. */
  | { type: 'policy.upsertRule'; rule: PolicyRule }
  | { type: 'policy.removeRule'; ruleId: string }
  | { type: 'budget.set'; agentKey: AgentKey | null; budget: Budget }
  // M3: change the user's settings (detectors, toasts, question window, shortcut); any subset
  | { type: 'settings.update'; patch: UserSettingsPatch }
  // ask-the-huddle (F25)
  /**
   * Ask once: the core builds the preview text again, runs a one-shot read-only `claude -p` (S18) and answers
   * `{ ok: true, ask: AskAnswer }` or `{ ok: false, askError }`. Refused while Ask is off. Answers are never stored.
   */
  | {
      type: 'huddle.ask';
      question: string;
      /**
       * Earlier turns of this conversation, oldest first (added for the Home Ask card): at most ASK_HISTORY_TURNS_MAX
       * (the core keeps the newest), each clipped (question ASK_QUESTION_MAX, answer ASK_HISTORY_ANSWER_MAX) and masked
       * again in core. Sent to the model and shown in What will be sent; never stored. Absent: a first question.
       */
      history?: AskTurn[];
    }
  /** Put an Ask answer on the clipboard. Main does it (the renderer has no clipboard permission); the core never sees it. */
  | { type: 'ask.copyAnswer'; text: string }
  /** Stop the ask in flight (it ends with askError 'cancelled'); ok when none was running. M5. */
  | { type: 'ask.cancel' }
  /** Settings, Ask the Huddle (M5). Turning it off also cancels an ask in flight. */
  | { type: 'ask.setEnabled'; enabled: boolean }
  // history (M5, F22 F23)
  /**
   * Settings, History: keep runs this many whole days (RETENTION_DAYS_MIN..MAX). Lowering it deletes older runs, so a
   * lower value must carry `confirm`: the run count `history.retentionPreview` answered for these days (M5 security
   * review L4). The core counts again and refuses a different number, so a stale command never deletes more than the
   * user saw. Raising needs no `confirm`. Optional field, added in M5.
   */
  | { type: 'history.setRetention'; days: number; confirm?: number }
  /** Delete every stored event, report and the older JSONL folder; keeps nicknames (owner decision). */
  | { type: 'history.deleteAll'; confirm: 'delete' }
  /** Build the run's report from its stored events and write its Markdown file. */
  | { type: 'report.make'; sessionId: string }
  /** Open the run's Markdown file with the system (main opens it; the renderer never sends a path). */
  | { type: 'report.openFile'; sessionId: string }
  /** Put the run's Markdown file path on the clipboard (main does it). */
  | { type: 'report.copyPath'; sessionId: string }
  // setup (ADR-017): the user agreed on the first-run screen to the settings change it showed
  | { type: 'setup.attach' }
  // phone access (M6, F26)
  /**
   * Turn phone access on: listen on `ip` (one of this computer's private LAN IPv4 addresses, as `phone.addresses`
   * lists them; never 0.0.0.0, loopback or a public address) and `port` (default PHONE_DEFAULT_PORT). The answer's
   * `detail` is the phone URL. Already on with the same address: ok; with another: moves.
   */
  | { type: 'phone.enable'; ip: string; port?: number }
  /** Turn phone access off: the listener closes and every live stream ends. Paired phones stay paired. */
  | { type: 'phone.disable' }
  /**
   * A new pairing code (6 digits, single use, PHONE_PAIR_CODE_TTL_MS, PHONE_PAIR_MAX_TRIES wrong tries). Answered in
   * `CommandResult.phonePairing` (and `detail`); never stored, never in an event. Refused while phone access is off.
   * A new code replaces the one in force.
   */
  | { type: 'phone.pair' }
  /**
   * Revoke one paired phone (`deviceId` from `HuddleState.phone.devices`), or every one (`deviceId: 'all'`): the token
   * stops working at once and the phone's live streams close.
   */
  | { type: 'phone.revoke'; deviceId: string }
  // self-reported progress for attached sessions (M6, F27, ADR-025; self-report.ts)
  /**
   * Register the Huddle's MCP server user-wide (`claude mcp add --scope user huddle ...`), opt-in. `fingerprint` is
   * the one `setup.selfReportPreview` (mode register) answered: the core runs only that change, else `expired`.
   * Refused when a `huddle` server that is not the Huddle's exists.
   */
  | { type: 'setup.selfReport.register'; fingerprint: string }
  /** Remove it again (`claude mcp remove --scope user huddle`), with the fingerprint of the unregister preview. */
  | { type: 'setup.selfReport.unregister'; fingerprint: string }
  // the Huddle as orchestrator (F28 skills, F29 tasks)
  /**
   * Write `<projectPath>/.claude/skills/<name>/SKILL.md` (F28). `projectPath` must be one of the known projects
   * (`selectKnownProjects`); the core checks the name, the folder and every path again. An existing file is replaced
   * only with `overwrite: true` (the user confirmed in the UI); otherwise the answer is `{ ok: false, exists: true }`.
   */
  | {
      type: 'skill.save';
      projectPath: string;
      name: string;
      description: string;
      instructions: string;
      overwrite: boolean;
    }
  /** Make a task (F29). `projectPath` a known project or null; `templateId` a saved template or null. detail: taskId. */
  | {
      type: 'huddle_task.create';
      title: string;
      details: string;
      projectPath: string | null;
      templateId: string | null;
    }
  /** Change a task; only the fields given change. `status` is the user's own mark: to do again, or done. */
  | {
      type: 'huddle_task.update';
      taskId: string;
      title?: string;
      details?: string;
      projectPath?: string | null;
      templateId?: string | null;
      status?: Extract<HuddleTaskStatus, 'todo' | 'done'>;
    }
  | { type: 'huddle_task.delete'; taskId: string }
  /**
   * Launch the task through the normal launch path (`run.launch`): its template with the task text as the prompt, or a
   * plain run in its project. Links the run to the task. detail: the runId.
   */
  | { type: 'huddle_task.launch'; taskId: string };

export type HuddleCommandType = HuddleCommand['type'];

/** What deleting history removed (M5, F22). */
export interface HistoryDeleted {
  /** Stored sessions (runs) whose events were deleted. */
  runs: number;
  /** Run report Markdown files removed. */
  reports: number;
  /** Older JSONL history folders removed (delete all only; 0 for a retention). */
  folders: number;
  /**
   * Delete all only: runs the overall budget in force was counting were deleted, so its usage now counts only what is
   * left (OVERALL_BUDGET_LOWERED_WORDS; the reply's `detail` ends with them). Absent: the usage did not change. A
   * retention never deletes what an overall budget counts.
   */
  overallBudgetLowered?: boolean;
}

/** Shown with a delete all that deleted runs the overall budget was counting (`HistoryDeleted.overallBudgetLowered`). */
export const OVERALL_BUDGET_LOWERED_WORDS = "The overall budget's usage now counts only what is left.";

export type CommandResult =
  | {
      ok: true;
      detail?: string;
      /** `huddle.ask` only (M5): the answer. */
      ask?: AskAnswer;
      /**
       * Something the user should know although the command succeeded, in the UI's words (M5). `template.upsert`: the
       * prompt looks like it holds a secret, which is stored as typed in templates.json.
       */
      warning?: string;
      /** `history.deleteAll` and a `history.setRetention` that deleted (M5): what was deleted. */
      deleted?: HistoryDeleted;
      /** `phone.pair` only (M6): the code to show on the desktop and when it stops working. Never stored. */
      phonePairing?: PhonePairing;
    }
  | {
      ok: false;
      /**
       * unsupported: this agent's origin cannot do it (see AgentCapabilities)
       * expired:     the request was already answered or timed out
       */
      code: 'unsupported' | 'not_found' | 'expired' | 'invalid' | 'failed';
      message: string;
      /** `huddle.ask` only (M5): why it failed, for the UI's words. */
      askError?: AskErrorKind;
      /** `skill.save` only (F28): the skill file exists and `overwrite` was false. */
      exists?: boolean;
    };

/**
 * Read-only questions the UI may ask main (M4, ADR-020: one IPC invoke, `huddle:query`). A query changes nothing and
 * writes no event.
 *   policy.preview: which recent approval requests this rule would have matched, before it is saved
 *   pick.folder:    the system folder picker (the launch dialog's cwd); `defaultPath` is where it opens
 */
export type HuddleQuery =
  | { type: 'policy.preview'; rule: PolicyRule }
  | { type: 'pick.folder'; defaultPath?: string }
  | M5Query
  /** M6 (F26): the private LAN IPv4 addresses phone access may listen on, read now from the network adapters. */
  | { type: 'phone.addresses' }
  /**
   * M6 (F27): what registering (or removing) the self-report MCP server for attached sessions would run and change.
   * Reads `.claude.json` and PATH; runs nothing, writes nothing.
   */
  | { type: 'setup.selfReportPreview'; mode: SelfReportRegistrationMode }
  /** F28: the known projects and the skills in them, plus the user's own skills (read-only). Reads files only. */
  | { type: 'skills.list' }
  /** F28: one project skill's file, for the editor. `projectPath` must be a known project. */
  | { type: 'skill.read'; projectPath: string; name: string };

/**
 * M5 (F22-F25) read-only questions on the same `huddle:query` channel; result shapes are in remember.ts. Limits are
 * clamped at the boundary (HISTORY_PAGE_MAX, HISTORY_EVENTS_MAX); a session id must be a valid store id.
 *   history.list:             a page of runs, newest start first, filtered by outcome and folder (full path)
 *   history.search:           the same over the full-text index (title, folder, first and last prompt); plain words
 *   history.folders:          every folder with a stored run, most recent run first (the Folder filter)
 *   history.open:             a run's head: row, event count, report flag, scrubber markers, quiet gaps
 *   history.stateAt:          the run's state just after event `index` (clamped to the last event), and why-facts
 *   history.events:           a page of the run's events from `fromIndex` (forward, or backward when `backward`),
 *                             one agent's only when `agentKey` is given; whole events only when `full`
 *   history.stats:            runs, bytes and oldest run (Settings, History)
 *   history.retentionPreview: how many runs a retention of `days` would delete
 *   report.get:               the run's report, 'not_ready' while it runs, or 'none'
 *   scorecards.get:           the scorecards over the stored history
 *   ask.preview:              the exact text `huddle.ask` would send for this question now
 */
export type M5Query =
  | { type: 'history.list'; limit: number; before?: HistoryCursor; outcome?: HistoryOutcome; folder?: string }
  | {
      type: 'history.search';
      text: string;
      limit: number;
      before?: HistoryCursor;
      outcome?: HistoryOutcome;
      folder?: string;
    }
  | { type: 'history.folders' }
  | { type: 'history.open'; sessionId: string }
  | { type: 'history.stateAt'; sessionId: string; index: number }
  | {
      type: 'history.events';
      sessionId: string;
      fromIndex: number;
      limit: number;
      backward?: boolean;
      agentKey?: AgentKey;
      full?: boolean;
    }
  | { type: 'history.stats' }
  | { type: 'history.retentionPreview'; days: number }
  | { type: 'report.get'; sessionId: string }
  | { type: 'scorecards.get' }
  | { type: 'ask.preview'; question: string; history?: AskTurn[] };

export type M5QueryType = M5Query['type'];

export type HuddleQueryType = HuddleQuery['type'];

/** One recent approval request a previewed rule would match. Text is the stored, clipped summary. */
export interface PolicyPreviewSample {
  agentKey: AgentKey;
  toolName: string;
  summary: string;
  receivedAt: number;
}

export interface PolicyPreview {
  /** Recent requests looked at. */
  examined: number;
  /** How many of them the rule matches. */
  matched: number;
  /** Some of the matches, newest first. */
  samples: PolicyPreviewSample[];
  /**
   * True: computed from the stored requests, whose input is clipped and masked, so the live rule may decide a little
   * differently (an allow never matches a clipped or masked sample). Absent in older builds: read as true.
   */
  approximate?: boolean;
}

export type QueryResult =
  | { ok: true; type: 'policy.preview'; preview: PolicyPreview }
  /** path: the chosen folder, or null when the user cancelled. */
  | { ok: true; type: 'pick.folder'; path: string | null }
  // M5 (remember.ts)
  | { ok: true; type: 'history.list'; page: HistoryPage }
  | { ok: true; type: 'history.search'; page: HistorySearchPage }
  | { ok: true; type: 'history.folders'; folders: string[] }
  | { ok: true; type: 'history.open'; head: RunHead }
  | { ok: true; type: 'history.stateAt'; moment: ReplayMoment }
  | { ok: true; type: 'history.events'; page: ReplayEventsPage }
  | { ok: true; type: 'history.stats'; stats: HistoryStats }
  | { ok: true; type: 'history.retentionPreview'; preview: RetentionPreview }
  | { ok: true; type: 'report.get'; answer: ReportAnswer }
  | { ok: true; type: 'scorecards.get'; answer: ScorecardsAnswer }
  | { ok: true; type: 'ask.preview'; preview: AskPreview }
  // M6 (phone.ts)
  | { ok: true; type: 'phone.addresses'; addresses: PhoneAddress[] }
  | { ok: true; type: 'setup.selfReportPreview'; preview: SelfReportRegistrationPreview }
  // F28 (orch.ts)
  | { ok: true; type: 'skills.list'; answer: SkillsAnswer }
  | { ok: true; type: 'skill.read'; skill: SkillFile }
  /**
   * not_found:     no stored run with that session id (M5)
   * not_available: this core does not answer that question yet (M5; the UI shows "not available in this build")
   */
  | { ok: false; code: 'unsupported' | 'invalid' | 'failed' | 'not_found' | 'not_available'; message: string };

/** A query result of one type (for typed helpers in main and the renderer). */
export type QueryResultOf<T extends HuddleQuery['type']> = Extract<QueryResult, { ok: true; type: T }>;

/** IPC channel names between Electron main (core) and renderer. One place, no string typos. */
export const IPC = {
  /** renderer -> main, invoke: HuddleCommand -> CommandResult */
  command: 'huddle:command',
  /** renderer -> main, invoke: void -> HuddleState */
  getState: 'huddle:get-state',
  /** renderer -> main, invoke: { agentKey, limit } -> HuddleEvent[] (read-only, zod-checked in main) */
  getEvents: 'huddle:get-events',
  /** main -> renderer, push: HuddleEvent[] (batched, at most every 100 ms) */
  events: 'huddle:events',
  /** renderer -> main, invoke: HuddleQuery -> QueryResult (read-only, zod-checked in main; M4, ADR-020) */
  query: 'huddle:query',
} as const;
