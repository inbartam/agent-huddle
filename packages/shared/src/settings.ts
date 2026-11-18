/**
 * The user's Huddle settings (M3): detector thresholds, which attention kinds raise a toast, how long a question is
 * held before the terminal box appears, the global shortcut, and whether the widget is collapsed to one line.
 *
 * Plain types and defaults only: `packages/shared` has no runtime dependencies, so the zod schema that checks a
 * settings file or a `settings.update` patch lives in core (`packages/core/src/runtime/huddle-settings.ts`). The
 * renderer reads these through the optional `HuddleState.settings` (ADR-017 pattern) and imports only this file.
 */
import type { AgentKey } from './model.js';
import { DEFAULT_PHONE_SETTINGS, type PhoneSettings } from './phone.js';
import { DEFAULT_RETENTION_DAYS } from './remember.js';
import { isSafeRoleKey, withRoleKind, type RoleKind, type RoleKindOverrides } from './roles.js';

export interface DetectorSettings {
  /** A working agent with no event for this long is stuck. */
  stuckMinutes: number;
  /** Same, while a tool call is still open (long builds and tests are normal). */
  stuckOpenToolMinutes: number;
  /** The same tool input digest this many times in a row is a loop. */
  loopRepeat: number;
  /** This many tool failures in a row is a loop. */
  loopFailures: number;
  /** Two agents editing the same file under the same cwd within this window is a conflict. */
  conflictWindowMinutes: number;
}

/** One switch per attention kind that can raise a desktop toast. */
export interface ToastSettings {
  approval: boolean;
  question: boolean;
  stuck: boolean;
  loop: boolean;
  conflict: boolean;
  /** An agent finished or failed. */
  doneOrError: boolean;
  /** A budget is nearly or fully used (M4, F19). A file without the field loads as true. */
  budget: boolean;
  /** A reviewer or researcher started editing files (2026-11-18). Absent (an older file or core): read as true. */
  roleDrift?: boolean;
}

/** Approval rules (M4, F18). */
export interface PolicySettings {
  /**
   * Apply the rules to attached sessions too, not only to the ones the Huddle launched. Off by default until spike S15
   * is run (ADR-020 §3). A file without the field loads as false.
   */
  applyToAttached: boolean;
}

/** History (M5, F22). Changed only by the `history.setRetention` command, never by a `settings.update` patch. */
export interface HistorySettings {
  /** Runs older than this many whole days are deleted once a day (RETENTION_DAYS_MIN..MAX). Default 30. */
  retentionDays: number;
}

/** Ask the Huddle (M5, F25). Changed only by the `ask.setEnabled` command. */
export interface AskSettings {
  /** Off by default (owner decision): the one feature that sends anything off this computer. */
  enabled: boolean;
}

/** Self-reported progress (M6, F27, ADR-025). */
export interface SelfReportSettings {
  /**
   * Managed runs get the Huddle's `report_progress` MCP tool (per-run `--mcp-config`), its permission and one prompt
   * line asking for reports. On by default. Attached sessions are separate: they get the tool only through the opt-in
   * registration step (`setup.selfReport.register`). A file without the field loads as on.
   */
  enabled: boolean;
}

/** Agent teams (M6 P5b, ADR-027). */
export interface TeamSettings {
  /**
   * When a teammate goes idle, the Huddle sends its lead one message asking whether that teammate is finished or
   * waiting, to be answered with the `report_teammate` tool. Only where the Huddle MCP server is available to the lead.
   * On by default. A file without the field loads as on.
   */
  askLeadOnIdle: boolean;
}

export interface UserSettings {
  detectors: DetectorSettings;
  toasts: ToastSettings;
  /** How long a held AskUserQuestion waits for an answer in the Huddle before the terminal box appears. */
  questionHoldSeconds: number;
  /** Electron accelerator for showing the Huddle. */
  globalShortcut: string;
  /** The widget is collapsed to one line (Widget v2). A file without the field loads as false. */
  widgetCollapsed: boolean;
  /** Approval rules (M4). */
  policy: PolicySettings;
  /** History retention (M5). A file without the field loads as the default. */
  history: HistorySettings;
  /** Ask the Huddle (M5). A file without the field loads as off. */
  ask: AskSettings;
  /**
   * Agent nicknames kept outside the event log (M5, owner decision): delete-all and retention delete the
   * `control.applied` rename events that carry nicknames (ADR-015), so main copies the latest nickname per agent here
   * first and they survive. AgentKey -> name (trimmed, clipped to CLIP_LIMITS.summary). Written by main only; not part of
   * a `settings.update` patch. A file without the field loads as {}.
   */
  nicknames: Record<AgentKey, string>;
  /**
   * Phone access (M6, F26): the address and port last chosen. Changed only by `phone.enable`, never by a
   * `settings.update` patch. Phone access itself is not a setting: it always starts off. Absent (an older core, the
   * canned dev core): read as DEFAULT_PHONE_SETTINGS.
   */
  phone?: PhoneSettings;
  /** Self-reported progress for managed runs (M6, F27). Absent (an older core, the canned dev core): read as on. */
  selfReport?: SelfReportSettings;
  /**
   * Start Agent Huddle when Windows starts (M6 P6). Owned by desktop main, not the core: the value is read from the
   * Windows login item (`app.getLoginItemSettings`), never stored in the settings file. Absent: not available (a dev
   * run, the canned core, another platform), so Settings shows the switch disabled with the reason. Off by default.
   */
  startWithWindows?: boolean;
  /** Agent teams (M6 P5b). Absent (an older core, the canned dev core): read as DEFAULT_TEAM_SETTINGS. */
  teams?: TeamSettings;
  /**
   * Agent types the user set by role name (2026-11-18, Library > Roles): role -> type. Wins over the guess in
   * `roleKindOf`. Absent (an older file, the canned dev core): read as {} (every role guessed).
   */
  roleKinds?: RoleKindOverrides;
}

export const DEFAULT_TEAM_SETTINGS: TeamSettings = { askLeadOnIdle: true };

/** A `settings.update` patch: any subset, one level deep. */
export interface UserSettingsPatch {
  detectors?: Partial<DetectorSettings>;
  toasts?: Partial<ToastSettings>;
  questionHoldSeconds?: number;
  globalShortcut?: string;
  widgetCollapsed?: boolean;
  policy?: Partial<PolicySettings>;
  /** M6 (F27): self-reported progress for managed runs on or off. */
  selfReport?: Partial<SelfReportSettings>;
  /** M6 P6: the Windows login item on or off. Desktop main applies it and takes it out before the core sees the patch. */
  startWithWindows?: boolean;
  /** M6 P5b: ask the lead about idle teammates on or off. */
  teams?: Partial<TeamSettings>;
  /** 2026-11-18: set a role's type, or clear it with null (back to the guess). Other roles are kept. */
  roleKinds?: Record<string, RoleKind | null>;
}

export const DEFAULT_USER_SETTINGS: UserSettings = {
  detectors: {
    stuckMinutes: 5,
    stuckOpenToolMinutes: 15,
    loopRepeat: 5,
    loopFailures: 3,
    conflictWindowMinutes: 10,
  },
  toasts: {
    approval: true,
    question: true,
    stuck: true,
    loop: true,
    conflict: true,
    doneOrError: true,
    budget: true,
    roleDrift: true,
  },
  questionHoldSeconds: 120,
  globalShortcut: 'Control+Alt+H',
  widgetCollapsed: false,
  policy: { applyToAttached: false },
  history: { retentionDays: DEFAULT_RETENTION_DAYS },
  ask: { enabled: false },
  nicknames: {},
  phone: { ...DEFAULT_PHONE_SETTINGS },
  selfReport: { enabled: true },
  teams: { ...DEFAULT_TEAM_SETTINGS },
  roleKinds: {},
};

/**
 * Where a budget warns when its own `warnAtFraction` is unusable (F19). Every budget carries its own fraction (checked
 * 0..1 at the boundary), so this only guards a value that is not a finite number. The launch dialog's default is the
 * same 80%.
 */
export const DEFAULT_BUDGET_WARN_AT_FRACTION = 0.8;

/** Pure: apply a patch. Returns new objects; never mutates either argument. */
export function applyUserSettingsPatch(settings: UserSettings, patch: UserSettingsPatch): UserSettings {
  return {
    detectors: { ...settings.detectors, ...patch.detectors },
    toasts: { ...settings.toasts, ...patch.toasts },
    questionHoldSeconds: patch.questionHoldSeconds ?? settings.questionHoldSeconds,
    globalShortcut: patch.globalShortcut ?? settings.globalShortcut,
    widgetCollapsed: patch.widgetCollapsed ?? settings.widgetCollapsed,
    policy: { ...settings.policy, ...patch.policy },
    // M5: not patchable; carried over unchanged.
    history: { ...settings.history },
    ask: { ...settings.ask },
    nicknames: { ...settings.nicknames },
    // M6: not patchable; carried over unchanged.
    ...(settings.phone !== undefined ? { phone: { ...settings.phone } } : {}),
    // M6 (F27): patchable. A settings object without it reads as on.
    ...(settings.selfReport !== undefined || patch.selfReport !== undefined
      ? { selfReport: { enabled: true, ...settings.selfReport, ...patch.selfReport } }
      : {}),
    // M6 P5b: patchable. A settings object without it reads as DEFAULT_TEAM_SETTINGS.
    ...(settings.teams !== undefined || patch.teams !== undefined
      ? { teams: { ...DEFAULT_TEAM_SETTINGS, ...settings.teams, ...patch.teams } }
      : {}),
    // 2026-11-18: patchable per role; null clears one.
    ...(settings.roleKinds !== undefined || patch.roleKinds !== undefined
      ? { roleKinds: mergeRoleKinds(settings.roleKinds, patch.roleKinds) }
      : {}),
  };
}

function mergeRoleKinds(
  current: RoleKindOverrides | undefined,
  patch: Record<string, RoleKind | null> | undefined,
): RoleKindOverrides {
  let next: RoleKindOverrides = { ...current };
  for (const [role, kind] of Object.entries(patch ?? {})) {
    if (!isSafeRoleKey(role)) continue;
    next = withRoleKind(next, role, kind);
  }
  return next;
}
