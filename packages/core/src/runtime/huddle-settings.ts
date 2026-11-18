/**
 * The Huddle's own settings file: `<dataDir>/huddle-settings.json`.
 *
 * M1 keeps one fact here: when the owner agreed to let the Huddle attach its hooks (ADR-014, `consentedAt`), for which
 * settings.json (`consentedFor`) and, since M3, for which change (`consentedFingerprint`, ADR-019).
 * Unknown top-level fields are kept on write, so later milestones can add theirs; inside the user settings only
 * the known fields are kept (`parseUserSettings` rebuilds them). The file is the Huddle's, never Claude
 * Code's: it lives in the app's data folder, not in `~/.claude`.
 *
 * Writes are atomic (temp file + rename, with a short retry because Windows can refuse a rename while another
 * process has the file open) and owner-only.
 *
 * M3 adds the user's settings (`UserSettings` from `@huddle/shared`) under the `preferences` key, read and written
 * through `userSettingsOf` / `withUserSettings`; they ride in `extra`, so the consent fields above are untouched.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  CLIP_LIMITS,
  DEFAULT_PHONE_SETTINGS,
  DEFAULT_TEAM_SETTINGS,
  DEFAULT_USER_SETTINGS,
  PHONE_PORT_MAX,
  PHONE_PORT_MIN,
  RETENTION_DAYS_MAX,
  RETENTION_DAYS_MIN,
  ROLE_KINDS,
  isAgentKeyFormat,
  isSafeRoleKey,
  type RoleKind,
  type RoleKindOverrides,
  type AgentKey,
  type UserSettings,
} from '@huddle/shared';
import { parseIPv4 } from '../phone/address.js';
import { writeTextAtomic } from './atomic-file.js';

/** Key in huddle-settings.json that holds the user's settings (M3). */
export const USER_SETTINGS_KEY = 'preferences';

// Bounds: wide enough for any sensible choice, tight enough that a typo cannot disable a feature by accident.
// questionHoldSeconds stays below the PreToolUse hook timeout (600 s, ADR-019) minus the broker's 5 s margin.
const detectorFields = {
  stuckMinutes: z.number().int().min(1).max(240),
  stuckOpenToolMinutes: z.number().int().min(1).max(1440),
  loopRepeat: z.number().int().min(2).max(100),
  loopFailures: z.number().int().min(2).max(100),
  conflictWindowMinutes: z.number().int().min(1).max(1440),
};
const toastFields = {
  approval: z.boolean(),
  question: z.boolean(),
  stuck: z.boolean(),
  loop: z.boolean(),
  conflict: z.boolean(),
  doneOrError: z.boolean(),
  budget: z.boolean(),
  roleDrift: z.boolean(),
};
/** Agent types the user set (2026-11-18). */
const roleKindSchema = z.enum(ROLE_KINDS as [RoleKind, ...RoleKind[]]);
/** Most role types kept; beyond this the file's first ones win. */
export const MAX_ROLE_KINDS = 2000;

/** Pure: the stored role types. Unsafe keys and unknown types are dropped. Never throws. */
export function parseRoleKinds(raw: unknown): RoleKindOverrides {
  const out: RoleKindOverrides = {};
  if (!isRecord(raw)) return out;
  let n = 0;
  for (const [role, kind] of Object.entries(raw)) {
    if (n >= MAX_ROLE_KINDS) break;
    const parsed = roleKindSchema.safeParse(kind);
    if (!isSafeRoleKey(role) || !parsed.success) continue;
    out[role] = parsed.data;
    n += 1;
  }
  return out;
}

const questionHoldSeconds = z.number().int().min(0).max(590);
/** An Electron accelerator such as `Control+Alt+H`: printable ASCII, no spaces. Electron checks it properly. */
const globalShortcut = z.string().regex(/^[\x21-\x7E]{1,100}$/);

/**
 * A `settings.update` patch from the renderer: any subset, every given value in range, unknown fields kept. Its output
 * fits `UserSettingsPatch`; `parseM3Command` in contracts/m3-schemas.ts checks that at compile time.
 */
export const userSettingsPatchSchema = z.looseObject({
  detectors: z.looseObject(detectorFields).partial().optional(),
  toasts: z.looseObject(toastFields).partial().optional(),
  questionHoldSeconds: questionHoldSeconds.optional(),
  globalShortcut: globalShortcut.optional(),
  widgetCollapsed: z.boolean().optional(),
  policy: z.looseObject({ applyToAttached: z.boolean() }).partial().optional(),
  selfReport: z.looseObject({ enabled: z.boolean() }).partial().optional(),
  teams: z.looseObject({ askLeadOnIdle: z.boolean() }).partial().optional(),
  roleKinds: z
    .record(z.string().min(1).max(200), roleKindSchema.nullable())
    .refine((r) => Object.keys(r).length <= MAX_ROLE_KINDS && Object.keys(r).every(isSafeRoleKey))
    .optional(),
});

/** History retention in whole days (M5). */
export const retentionDaysSchema = z.number().int().min(RETENTION_DAYS_MIN).max(RETENTION_DAYS_MAX);

/** The phone address and port last chosen (M6). Only the shape is checked here; the core checks the address on enable. */
const phoneIp = z
  .string()
  .max(15)
  .refine((ip) => parseIPv4(ip) !== null)
  .nullable();
const phonePort = z.number().int().min(PHONE_PORT_MIN).max(PHONE_PORT_MAX);

/** Most nicknames kept (M5); beyond this the file's first ones win. */
export const MAX_NICKNAMES = 5000;
const UNSAFE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Pure: the stored nicknames map (M5). Entries with a malformed agent key or an empty name are dropped; names are
 * trimmed and clipped like a rename (CLIP_LIMITS.summary). Never throws.
 */
export function parseNicknames(raw: unknown): Record<AgentKey, string> {
  const out: Record<AgentKey, string> = {};
  if (!isRecord(raw)) return out;
  let n = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (n >= MAX_NICKNAMES) break;
    if (UNSAFE_KEYS.has(key) || !isAgentKeyFormat(key) || typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed === '') continue;
    out[key] = trimmed.length > CLIP_LIMITS.summary ? trimmed.slice(0, CLIP_LIMITS.summary).trimEnd() : trimmed;
    n += 1;
  }
  return out;
}

function fieldOr<T>(schema: z.ZodType<T>, value: unknown, fallback: T): T {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : fallback;
}

function recordOf(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/**
 * Pure: whatever is stored to complete settings. Field by field: a missing or out-of-range value falls back to its
 * default, so one bad value never resets the rest. Never throws.
 */
export function parseUserSettings(raw: unknown): UserSettings {
  const r = recordOf(raw);
  const d = recordOf(r.detectors);
  const t = recordOf(r.toasts);
  const pol = recordOf(r.policy);
  const hist = recordOf(r.history);
  const ask = recordOf(r.ask);
  const phone = recordOf(r.phone);
  const selfReport = recordOf(r.selfReport);
  const teams = recordOf(r.teams);
  const dd = DEFAULT_USER_SETTINGS.detectors;
  const dt = DEFAULT_USER_SETTINGS.toasts;
  return {
    detectors: {
      stuckMinutes: fieldOr(detectorFields.stuckMinutes, d.stuckMinutes, dd.stuckMinutes),
      stuckOpenToolMinutes: fieldOr(
        detectorFields.stuckOpenToolMinutes,
        d.stuckOpenToolMinutes,
        dd.stuckOpenToolMinutes,
      ),
      loopRepeat: fieldOr(detectorFields.loopRepeat, d.loopRepeat, dd.loopRepeat),
      loopFailures: fieldOr(detectorFields.loopFailures, d.loopFailures, dd.loopFailures),
      conflictWindowMinutes: fieldOr(
        detectorFields.conflictWindowMinutes,
        d.conflictWindowMinutes,
        dd.conflictWindowMinutes,
      ),
    },
    toasts: {
      approval: fieldOr(toastFields.approval, t.approval, dt.approval),
      question: fieldOr(toastFields.question, t.question, dt.question),
      stuck: fieldOr(toastFields.stuck, t.stuck, dt.stuck),
      loop: fieldOr(toastFields.loop, t.loop, dt.loop),
      conflict: fieldOr(toastFields.conflict, t.conflict, dt.conflict),
      doneOrError: fieldOr(toastFields.doneOrError, t.doneOrError, dt.doneOrError),
      budget: fieldOr(toastFields.budget, t.budget, dt.budget),
      roleDrift: fieldOr(toastFields.roleDrift, t.roleDrift, dt.roleDrift),
    },
    questionHoldSeconds: fieldOr(questionHoldSeconds, r.questionHoldSeconds, DEFAULT_USER_SETTINGS.questionHoldSeconds),
    globalShortcut: fieldOr(globalShortcut, r.globalShortcut, DEFAULT_USER_SETTINGS.globalShortcut),
    widgetCollapsed: fieldOr(z.boolean(), r.widgetCollapsed, DEFAULT_USER_SETTINGS.widgetCollapsed),
    policy: {
      applyToAttached: fieldOr(z.boolean(), pol.applyToAttached, DEFAULT_USER_SETTINGS.policy.applyToAttached),
    },
    history: {
      retentionDays: fieldOr(retentionDaysSchema, hist.retentionDays, DEFAULT_USER_SETTINGS.history.retentionDays),
    },
    ask: { enabled: fieldOr(z.boolean(), ask.enabled, DEFAULT_USER_SETTINGS.ask.enabled) },
    nicknames: parseNicknames(r.nicknames),
    phone: {
      ip: fieldOr(phoneIp, phone.ip, DEFAULT_PHONE_SETTINGS.ip),
      port: fieldOr(phonePort, phone.port, DEFAULT_PHONE_SETTINGS.port),
    },
    selfReport: {
      enabled: fieldOr(z.boolean(), selfReport.enabled, DEFAULT_USER_SETTINGS.selfReport?.enabled ?? true),
    },
    teams: {
      askLeadOnIdle: fieldOr(z.boolean(), teams.askLeadOnIdle, DEFAULT_TEAM_SETTINGS.askLeadOnIdle),
    },
    roleKinds: parseRoleKinds(r.roleKinds),
  };
}

/** Pure: the user's settings stored in a settings file (defaults for anything missing). */
export function userSettingsOf(settings: HuddleSettings): UserSettings {
  return parseUserSettings(settings.extra[USER_SETTINGS_KEY]);
}

/** Pure: the settings file with these user settings stored; everything else kept. */
export function withUserSettings(settings: HuddleSettings, user: UserSettings): HuddleSettings {
  return { ...settings, extra: { ...settings.extra, [USER_SETTINGS_KEY]: user } };
}

export const HUDDLE_SETTINGS_FILENAME = 'huddle-settings.json';

export interface HuddleSettings {
  /** ISO time the owner agreed to attach the hooks while the Huddle runs, or null when not (yet) agreed. */
  consentedAt: string | null;
  /**
   * The Claude Code settings.json the consent was given for. Consent counts only for that file, so consent given
   * for a test config folder never attaches to the real `~/.claude` (or the other way round).
   */
  consentedFor: string | null;
  /**
   * `consentFingerprintOf` of the change the owner approved (install-hooks.ts). A start attaches by itself only when
   * the change it would write has this fingerprint; otherwise the first-run screen shows the new change. Null (or
   * absent, in literals) when no change is on record, which includes every consent saved before this field existed:
   * those ask once more. Optional so older callers that write a settings object keep compiling; they store null.
   */
  consentedFingerprint?: string | null;
  /** Every other field found in the file, kept as is. */
  extra: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const NO_CONSENT = { consentedAt: null, consentedFor: null, consentedFingerprint: null } as const;
const FINGERPRINT = /^[0-9a-f]{64}$/;

/** Pure: file text to settings. Anything unreadable means "no consent", never an exception. */
export function parseHuddleSettings(text: string | null): HuddleSettings {
  if (text === null) return { ...NO_CONSENT, extra: {} };
  let raw: unknown;
  try {
    raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return { ...NO_CONSENT, extra: {} };
  }
  if (!isRecord(raw)) return { ...NO_CONSENT, extra: {} };
  const { consentedAt, consentedFor, consentedFingerprint, ...extra } = raw;
  const valid =
    typeof consentedAt === 'string' &&
    Number.isFinite(Date.parse(consentedAt)) &&
    typeof consentedFor === 'string' &&
    consentedFor !== '';
  // Consent without the file it was given for (older file) counts as none: ask again rather than guess.
  if (!valid) return { ...NO_CONSENT, extra };
  // A consent without a (well-formed) fingerprint is kept, but a start shows the change again (needs consent once).
  const fingerprint =
    typeof consentedFingerprint === 'string' && FINGERPRINT.test(consentedFingerprint) ? consentedFingerprint : null;
  return { consentedAt, consentedFor, consentedFingerprint: fingerprint, extra };
}

export function serializeHuddleSettings(settings: HuddleSettings): string {
  return `${JSON.stringify(
    {
      ...settings.extra,
      consentedAt: settings.consentedAt,
      consentedFor: settings.consentedFor,
      consentedFingerprint: settings.consentedFingerprint ?? null,
    },
    null,
    2,
  )}\n`;
}

/** Same settings.json? Paths are compared resolved, and case-insensitively on Windows. */
export function sameSettingsFile(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  const norm = (p: string): string =>
    platform === 'win32' ? path.win32.resolve(p).toLowerCase() : path.posix.resolve(p);
  return norm(a) === norm(b);
}

export function huddleSettingsPath(dataDir: string): string {
  return path.join(path.resolve(dataDir), HUDDLE_SETTINGS_FILENAME);
}

export async function readHuddleSettings(dataDir: string): Promise<HuddleSettings> {
  try {
    return parseHuddleSettings(await fsp.readFile(huddleSettingsPath(dataDir), 'utf8'));
  } catch {
    return parseHuddleSettings(null);
  }
}

export async function writeHuddleSettings(dataDir: string, settings: HuddleSettings): Promise<void> {
  await writeTextAtomic(huddleSettingsPath(dataDir), serializeHuddleSettings(settings));
}

/** Pure: the same settings with no consent on record (every other key kept). Withdraw consent and `--remove-hooks`. */
export function withoutConsent(settings: HuddleSettings): HuddleSettings {
  return { ...settings, consentedAt: null, consentedFor: null, consentedFingerprint: null };
}

/** Is a consent on record? (Any of the three fields set.) */
export function hasConsent(settings: HuddleSettings): boolean {
  return (
    settings.consentedAt !== null || settings.consentedFor !== null || (settings.consentedFingerprint ?? null) !== null
  );
}

/**
 * Forget the remembered consent in `<dataDir>/huddle-settings.json`, as withdrawing consent does, for a process that
 * hosts no HuddleCore (the packaged `--remove-hooks` command, M6 P6). Writes only when a consent is on record, so a
 * missing or unreadable file (read as "no consent") is never rewritten; preferences and every other key are kept.
 * Must not run while a HuddleCore uses the same folder (its writes are not queued with this one).
 */
export async function forgetConsent(dataDir: string): Promise<{ forgotten: boolean; path: string }> {
  const current = await readHuddleSettings(dataDir);
  const file = huddleSettingsPath(dataDir);
  if (!hasConsent(current)) return { forgotten: false, path: file };
  await writeHuddleSettings(dataDir, withoutConsent(current));
  return { forgotten: true, path: file };
}
