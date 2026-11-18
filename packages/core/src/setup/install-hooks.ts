/**
 * Product version of scripts/install-hooks.mjs (ADR-014, "attach while running").
 *
 * Two layers:
 *  - Pure planning: (current settings JSON, options) -> new settings, notes, warnings, and a line diff for the
 *    first-run consent screen. No clock, no I/O.
 *  - The I/O edge (`HookInstaller`): reads settings.json, asks for nothing itself, and writes only when `apply()`
 *    gets `{ consent: true }`. It re-reads settings.json right before writing, writes atomically (temp file +
 *    rename), and keeps rotated backups. Config dir, clock and token source are injected.
 *
 * What belongs to the Huddle: HTTP hooks whose URL is exactly http://127.0.0.1:<port>/huddle/hooks/<Event>, the
 * SessionStart command hook exactly as the installer writes it (node "<abs>/agent-huddle/huddle-forward-hook.mjs"),
 * and the telemetry env vars when they point at 127.0.0.1 with our token header. Everything else in settings.json is
 * the user's and is never changed.
 */
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { isSecretName, maskSecrets } from '../privacy/redact.js';
import { renameWithRetry, tmpPathFor as tmpPath, writeFileAtomic as writeAtomic } from '../runtime/atomic-file.js';

export const DEFAULT_PORT = 47821;
export const HOOK_PATH_PREFIX = '/huddle/hooks/';
export const FORWARDER_FILENAME = 'huddle-forward-hook.mjs';
/** Status line bridge (F9, ADR-018): the wrapper the `statusLine` command runs, copied into the Huddle folder. */
export const STATUSLINE_WRAPPER_FILENAME = 'huddle-statusline.mjs';
/** The user's own `statusLine`, saved by the installer before it wraps it. Read by the wrapper; written only here. */
export const STATUSLINE_ORIGINAL_FILENAME = 'statusline-original.json';
/** `statusLine` keys copied from the user's line onto the bridge, so the bar looks and refreshes the same. */
const STATUSLINE_KEPT_KEYS = ['padding', 'refreshInterval', 'hideVimModeIndicator'] as const;
export const HUDDLE_DIRNAME = 'agent-huddle';
export const DEFAULT_KEEP_BACKUPS = 5;
export const BACKUP_PREFIX = 'settings.json.huddle-backup-';
/** Copy of settings.json from before the Huddle's first write. Never rotated away. */
export const ORIGINAL_BACKUP_NAME = `${BACKUP_PREFIX}original`;

// Same lists as scripts/install-hooks.mjs. See that file for why the other events are not registered.
export const CORE_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Notification',
  'UserPromptSubmit',
  'Stop',
  'SubagentStart',
  'SubagentStop',
  'TaskCreated',
  'TaskCompleted',
  'PreCompact',
  'PostCompact',
  'SessionEnd',
] as const;
export const NEWER_EVENTS = [
  'PermissionDenied',
  'StopFailure',
  'TeammateIdle',
  'PostModelSwitch',
  'InstructionsLoaded',
] as const;

/**
 * Seconds. Observation hooks get 5 s so a hung Huddle cannot stall an agent for long. PermissionRequest is long
 * because the Huddle holds it while the user decides. PreToolUse is long so the Huddle can hold it for a pause (F13)
 * or a question window (ADR-019); unheld calls are still answered in about 2 ms. Same table as
 * scripts/install-hooks.mjs (checked by the parity test in install-hooks.test.ts).
 */
export const DEFAULT_TIMEOUT = 5;
/** PreToolUse hook timeout in seconds (ADR-019). The longest a held PreToolUse can last before Claude Code closes it. */
export const HOLD_TIMEOUT_S = 600;
/** PermissionRequest hook timeout in seconds. The longest a held permission request can last. */
export const PERMISSION_TIMEOUT_S = 600;
const TIMEOUTS: Readonly<Partial<Record<string, number>>> = {
  PreToolUse: HOLD_TIMEOUT_S,
  PermissionRequest: PERMISSION_TIMEOUT_S,
  SessionEnd: 1,
};

/** The installed timeout of an event's HTTP hook, in seconds, before any `--timeout` override. */
export function defaultTimeoutFor(event: string): number {
  return TIMEOUTS[event] ?? DEFAULT_TIMEOUT;
}

export const TELEMETRY_KEYS = [
  'CLAUDE_CODE_ENABLE_TELEMETRY',
  'OTEL_LOGS_EXPORTER',
  'OTEL_METRICS_EXPORTER',
  'OTEL_EXPORTER_OTLP_PROTOCOL',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_HEADERS',
  'OTEL_LOGS_EXPORT_INTERVAL',
  'OTEL_METRIC_EXPORT_INTERVAL',
] as const;

type JsonObject = Record<string, unknown>;

export function isPlainObject(v: unknown): v is JsonObject {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Drops a leading byte-order mark (Windows editors add one). */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Windows paths with forward slashes work in Git Bash, PowerShell and cmd alike. */
export function toPosixPath(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * A path inside `node "<path>"` is expanded by Git Bash and PowerShell when it holds `$` or a backtick, ended early
 * by `"`, and expanded by cmd with `%`. No single quoting works in all three shells, so the planner refuses such a
 * path instead of writing a command that silently breaks. Same rule in scripts/lib/common.mjs.
 */
export function shellUnsafePathChar(p: string): string | null {
  const m = /[$`"%]/.exec(p);
  return m ? m[0] : null;
}

function unsafePathError(what: string, p: string): string {
  const ch = shellUnsafePathChar(p) ?? '';
  const shown = ch === '`' ? 'a backtick' : `"${ch}"`;
  return `The ${what} path (${p}) contains ${shown}, so a command with it cannot be quoted safely for every shell. Use a config folder without $, backtick, " or %.`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Ownership
// ---------------------------------------------------------------------------------------------------------------------

/** The URL `planInstall` writes: local, plain http, one event name, nothing after it. */
const HUDDLE_HOOK_URL = /^http:\/\/127\.0\.0\.1:\d{1,5}\/huddle\/hooks\/[A-Za-z]+$/;
/**
 * The command `planInstall` writes: node "<absolute path>/agent-huddle/huddle-forward-hook.mjs". Mixed slashes are
 * tolerated (an older install, a hand-edited path); anything around it (a wrapper, `&& …`) makes it the user's.
 */
const HUDDLE_FORWARDER_COMMAND =
  /^node "(?:[A-Za-z]:)?[\\/](?:[^"\n]*[\\/])?agent-huddle[\\/]huddle-forward-hook\.mjs"$/;

/**
 * A hook entry belongs to the Huddle only when it is exactly what the installer writes. A user's own hook that
 * merely mentions /huddle/hooks/ or the forwarder's file name is the user's and survives uninstall.
 */
export function isHuddleHook(hook: unknown): boolean {
  if (!isPlainObject(hook)) return false;
  if (hook.type === 'http') return typeof hook.url === 'string' && HUDDLE_HOOK_URL.test(hook.url);
  if (hook.type === 'command') return typeof hook.command === 'string' && HUDDLE_FORWARDER_COMMAND.test(hook.command);
  return false;
}

/** The bridge command `planInstall` writes: node "<absolute path>/agent-huddle/huddle-statusline.mjs", nothing around it. */
const HUDDLE_STATUSLINE_COMMAND =
  /^node "(?:[A-Za-z]:)?[\\/](?:[^"\n]*[\\/])?agent-huddle[\\/]huddle-statusline\.mjs"$/;

/** A `statusLine` value is the Huddle's only when its command is exactly the bridge command. */
export function isHuddleStatusLine(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    value.type === 'command' &&
    typeof value.command === 'string' &&
    HUDDLE_STATUSLINE_COMMAND.test(value.command)
  );
}

/** What `statusline-original.json` holds: the user's `statusLine` exactly as it was, or null when there was none. */
export interface SavedStatusLine {
  statusLine: unknown;
}

/** Telemetry env is the Huddle's only when it points at a local Huddle with our token header. */
export function telemetryIsHuddles(env: unknown): boolean {
  if (!isPlainObject(env)) return false;
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const headers = env.OTEL_EXPORTER_OTLP_HEADERS;
  return (
    typeof endpoint === 'string' &&
    /^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint) &&
    typeof headers === 'string' &&
    headers.startsWith('X-Huddle-Token=')
  );
}

/** Removes Huddle hook entries in place; returns how many were removed. Drops groups and events left empty. */
function stripHuddleHooks(settings: JsonObject): number {
  const hooks = settings.hooks;
  if (!isPlainObject(hooks)) return 0;
  let removed = 0;
  for (const event of Object.keys(hooks)) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    const kept: unknown[] = [];
    for (const group of groups as unknown[]) {
      if (!isPlainObject(group) || !Array.isArray(group.hooks)) {
        kept.push(group);
        continue;
      }
      const inner = group.hooks as unknown[];
      const mine = inner.filter((h) => !isHuddleHook(h));
      removed += inner.length - mine.length;
      if (mine.length) kept.push({ ...group, hooks: mine });
    }
    if (kept.length) hooks[event] = kept;
    else Reflect.deleteProperty(hooks, event);
  }
  if (!Object.keys(hooks).length) Reflect.deleteProperty(settings, 'hooks');
  return removed;
}

function stripHuddleTelemetry(settings: JsonObject): number {
  const env = settings.env;
  if (!isPlainObject(env) || !telemetryIsHuddles(env)) return 0;
  let removed = 0;
  for (const key of TELEMETRY_KEYS) {
    if (key in env) {
      Reflect.deleteProperty(env, key);
      removed += 1;
    }
  }
  if (!Object.keys(env).length) Reflect.deleteProperty(settings, 'env');
  return removed;
}

/** The Huddle-owned part of a settings object: our hook entries per event (in order) and our telemetry env. */
function huddlePart(settings: JsonObject): JsonObject {
  const hooks: JsonObject = {};
  if (isPlainObject(settings.hooks)) {
    for (const [event, groups] of Object.entries(settings.hooks)) {
      if (!Array.isArray(groups)) continue;
      const ours: unknown[] = [];
      for (const group of groups as unknown[]) {
        if (isPlainObject(group) && Array.isArray(group.hooks)) {
          ours.push(...(group.hooks as unknown[]).filter(isHuddleHook));
        }
      }
      if (ours.length) hooks[event] = ours;
    }
  }
  const env: JsonObject = {};
  if (telemetryIsHuddles(settings.env) && isPlainObject(settings.env)) {
    for (const key of TELEMETRY_KEYS) if (key in settings.env) env[key] = settings.env[key];
  }
  const part: JsonObject = { hooks, env };
  if (isHuddleStatusLine(settings.statusLine)) part.statusLine = settings.statusLine;
  return part;
}

/** The user-owned rest of a settings object. */
function userPart(settings: JsonObject): JsonObject {
  const copy = structuredClone(settings);
  stripHuddleHooks(copy);
  stripHuddleTelemetry(copy);
  if (isHuddleStatusLine(copy.statusLine)) Reflect.deleteProperty(copy, 'statusLine');
  return copy;
}

/** JSON with sorted object keys, for comparing values regardless of key order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  // JSON.stringify returns undefined for undefined and functions, although its type says string.
  const text = JSON.stringify(value) as string | undefined;
  return text ?? 'null';
}

// ---------------------------------------------------------------------------------------------------------------------
// --timeout overrides (deferred minor M4: warn when an override cannot have an effect)
// ---------------------------------------------------------------------------------------------------------------------

export type EventSet = 'all' | 'core';

export function eventsFor(set: EventSet): readonly string[] {
  return set === 'core' ? CORE_EVENTS : [...CORE_EVENTS, ...NEWER_EVENTS];
}

export interface TimeoutCheck {
  errors: string[];
  warnings: string[];
  /** Overrides that apply to an installed HTTP hook. */
  effective: Record<string, number>;
}

export function checkTimeoutOverrides(
  mode: 'install' | 'uninstall',
  events: EventSet,
  overrides: Readonly<Record<string, number>> = {},
): TimeoutCheck {
  const known = [...CORE_EVENTS, ...NEWER_EVENTS, 'SessionStart'] as readonly string[];
  const installed = eventsFor(events);
  const out: TimeoutCheck = { errors: [], warnings: [], effective: {} };
  for (const [event, seconds] of Object.entries(overrides)) {
    if (!known.includes(event)) {
      out.errors.push(`--timeout: unknown event "${event}". Known events: ${known.join(', ')}`);
      continue;
    }
    if (!Number.isInteger(seconds) || seconds <= 0) {
      out.errors.push(`--timeout ${event}: expected a positive whole number of seconds, got ${String(seconds)}`);
      continue;
    }
    if (mode === 'uninstall') out.warnings.push(`--timeout ${event}=... has no effect with uninstall.`);
    else if (event === 'SessionStart')
      out.warnings.push(
        '--timeout SessionStart=... has no effect: the SessionStart command hook keeps its default timeout.',
      );
    else if (!installed.includes(event))
      out.warnings.push(`--timeout ${event}=... has no effect: ${event} is not installed with events "${events}".`);
    else out.effective[event] = seconds;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Pure planning
// ---------------------------------------------------------------------------------------------------------------------

export interface InstallOptions {
  port: number;
  token: string;
  /** Absolute path of the forwarder copy (inside <configDir>/agent-huddle/). Mixed slashes are fine. */
  forwarderPath: string;
  events?: EventSet;
  /** Add the OpenTelemetry env vars (default true). */
  otel?: boolean;
  /** Per-event HTTP hook timeout overrides, in seconds. */
  timeouts?: Readonly<Record<string, number>>;
  /**
   * F9, opt-in (default false): wrap the user's `statusLine` with the bridge. False never touches `statusLine`, so an
   * installed bridge stays as it is (ADR-018).
   */
  statusLine?: boolean;
  /** Absolute path of the wrapper copy (inside <configDir>/agent-huddle/). Required with `statusLine: true`. */
  statuslineWrapperPath?: string;
}

export interface UninstallOptions {
  /**
   * Also remove the Huddle's telemetry env vars. Default false: quitting the Huddle leaves them installed
   * (ADR-014: a dead exporter is silent). A full uninstall from the tray passes true.
   */
  removeTelemetry?: boolean;
  timeouts?: Readonly<Record<string, number>>;
  /**
   * F9: put the user's own `statusLine` back (or remove the key when there was none). Default false: quitting the
   * Huddle leaves the bridge in place, because it is silent while the Huddle is down (ADR-018).
   */
  restoreStatusLine?: boolean;
  /** Contents of statusline-original.json; `HookInstaller` reads it. Null or absent: nothing was saved. */
  statusLineOriginal?: SavedStatusLine | null;
  /** Leave the Huddle's hooks in place (to remove only the status line bridge). Default false. */
  keepHooks?: boolean;
}

export interface SettingsPlan {
  ok: true;
  mode: 'install' | 'uninstall';
  changed: boolean;
  before: JsonObject;
  after: JsonObject;
  notes: string[];
  warnings: string[];
  /**
   * Hash of the Huddle-owned part of `after`. Consent covers this. If a fresh plan made just before writing has a
   * different fingerprint, the change the user agreed to is no longer the change that would be written.
   */
  fingerprint: string;
  /**
   * Hash of what the owner's remembered consent covers (`consentFingerprintOf(after)`): the Huddle's hook table and
   * telemetry env, with the endpoint (port, token) masked and the status line left out. Stored with the consent in
   * huddle-settings.json; a start whose plan has another value shows the change again instead of attaching.
   */
  consentFingerprint: string;
  /**
   * Install with `statusLine: true` replacing a line that is not the bridge: the user's line to save in
   * statusline-original.json before settings.json is written. Absent otherwise (an installed bridge is never saved
   * as "the original").
   */
  statusLineToSave?: SavedStatusLine;
  /** Uninstall with `restoreStatusLine`: statusline-original.json is done with and is deleted after the write. */
  forgetStatusLineOriginal?: boolean;
}

export interface PlanError {
  ok: false;
  error: string;
}

export type PlanResult = SettingsPlan | PlanError;

function validateSettings(current: unknown): { ok: true; settings: JsonObject } | PlanError {
  const value = current ?? {};
  if (!isPlainObject(value)) return { ok: false, error: 'settings.json does not contain a JSON object.' };
  if ('hooks' in value && !isPlainObject(value.hooks))
    return { ok: false, error: '"hooks" in settings.json is not an object.' };
  if ('env' in value && !isPlainObject(value.env))
    return { ok: false, error: '"env" in settings.json is not an object.' };
  return { ok: true, settings: value };
}

function fingerprintOf(mode: 'install' | 'uninstall', after: JsonObject, saved?: SavedStatusLine): string {
  // The saved original is part of what the user agreed to: if their status line changed since the preview, it is stale.
  const savedPart = saved === undefined ? '' : `\n${canonicalJson(saved)}`;
  return createHash('sha256')
    .update(`${mode}\n${canonicalJson(huddlePart(after))}${savedPart}`)
    .digest('hex');
}

const ENDPOINT_PORT = /^http:\/\/127\.0\.0\.1:\d+/;

/** One Huddle hook entry with its endpoint masked: the port in the URL and every header value. */
function maskedHook(hook: unknown): unknown {
  if (!isPlainObject(hook)) return hook;
  const copy: JsonObject = { ...hook };
  if (typeof copy.url === 'string') copy.url = copy.url.replace(ENDPOINT_PORT, 'http://127.0.0.1:<port>');
  if (isPlainObject(copy.headers)) {
    copy.headers = Object.fromEntries(Object.keys(copy.headers).map((k) => [k, '<secret>']));
  }
  return copy;
}

/**
 * Pure. The fingerprint the remembered consent is tied to (ADR-019 follow-up): the Huddle's hook entries per event
 * (types, timeouts, commands) and its telemetry env keys, with the port and the token masked. Port and token are left
 * out because the Huddle owns them (a new token or a test's ephemeral port is not a new change for the owner); the
 * status line is left out because a start never writes it (ADR-018: the bridge is opt-in and stays as it is).
 * Anything else the Huddle would write differently, such as a new timeout or another event, changes it.
 */
export function consentFingerprintOf(settings: JsonObject): string {
  const part = huddlePart(settings);
  const hooks: JsonObject = {};
  if (isPlainObject(part.hooks)) {
    for (const [event, entries] of Object.entries(part.hooks)) {
      hooks[event] = Array.isArray(entries) ? (entries as unknown[]).map(maskedHook) : entries;
    }
  }
  const env: JsonObject = isPlainObject(part.env) ? { ...part.env } : {};
  if (typeof env.OTEL_EXPORTER_OTLP_ENDPOINT === 'string') {
    env.OTEL_EXPORTER_OTLP_ENDPOINT = env.OTEL_EXPORTER_OTLP_ENDPOINT.replace(ENDPOINT_PORT, 'http://127.0.0.1:<port>');
  }
  if (typeof env.OTEL_EXPORTER_OTLP_HEADERS === 'string') env.OTEL_EXPORTER_OTLP_HEADERS = '<secret>';
  return createHash('sha256')
    .update(`consent\n${canonicalJson({ hooks, env })}`)
    .digest('hex');
}

/** A command for the notes, masked and shortened (the consent screen shows notes as text). */
function shownCommand(value: unknown): string {
  const command = isPlainObject(value) && typeof value.command === 'string' ? value.command : '(not a command)';
  const masked = maskSecrets(command);
  return masked.length > 120 ? `${masked.slice(0, 117)}...` : masked;
}

/**
 * Install part for F9. Replaces `statusLine` in place (same key position) with the bridge, keeping padding,
 * refreshInterval and hideVimModeIndicator from the user's line. Returns what to save as the original.
 */
function planStatusLine(
  next: JsonObject,
  wrapperPath: string,
  notes: string[],
  warnings: string[],
): SavedStatusLine | undefined {
  const current = next.statusLine;
  if (isHuddleStatusLine(current)) return undefined; // already wrapped; the saved original stays as it is
  const bridge: JsonObject = { type: 'command', command: `node "${toPosixPath(path.resolve(wrapperPath))}"` };
  if (isPlainObject(current)) {
    for (const key of STATUSLINE_KEPT_KEYS) if (key in current) bridge[key] = current[key];
  }
  next.statusLine = bridge;
  if (current === undefined) {
    notes.push('add a status line bridge: it sends the status line data to the Huddle and prints nothing');
    return { statusLine: null };
  }
  if (!isPlainObject(current) || current.type !== 'command' || typeof current.command !== 'string') {
    warnings.push(
      'Your statusLine is not a command, so the bridge cannot run it; it is saved and put back on uninstall.',
    );
  } else {
    notes.push(`wrap your status line: ${shownCommand(current)} keeps running and is shown as before`);
  }
  return { statusLine: structuredClone(current) };
}

/** Uninstall part for F9: restore the saved line exactly, remove the key when there was none, or leave a user's line. */
function restoreStatusLine(
  next: JsonObject,
  saved: SavedStatusLine | null | undefined,
  notes: string[],
  warnings: string[],
): void {
  const current = next.statusLine;
  if (!isHuddleStatusLine(current)) {
    if (saved !== null && saved !== undefined) {
      notes.push('leave statusLine as it is: it was changed after the Huddle installed its bridge');
    }
    return;
  }
  if (saved === null || saved === undefined) {
    Reflect.deleteProperty(next, 'statusLine');
    warnings.push('The saved original status line is missing, so the bridge is removed and no status line is set.');
    return;
  }
  if (saved.statusLine === null || saved.statusLine === undefined) {
    Reflect.deleteProperty(next, 'statusLine');
    notes.push('remove the status line bridge (you had no status line before)');
    return;
  }
  const restored = structuredClone(saved.statusLine);
  // The bridge was installed with the original's display keys (planStatusLine copies them), so a key whose value on
  // the bridge differs from the original was changed by the user since: carry that change over instead of undoing it.
  const carried: string[] = [];
  if (isPlainObject(restored) && isPlainObject(current)) {
    for (const key of STATUSLINE_KEPT_KEYS) {
      if (canonicalJson(current[key]) === canonicalJson(restored[key])) continue;
      if (key in current) restored[key] = structuredClone(current[key]);
      else Reflect.deleteProperty(restored, key);
      carried.push(key);
    }
  }
  next.statusLine = restored;
  notes.push(`restore your status line: ${shownCommand(saved.statusLine)}`);
  if (carried.length > 0) notes.push(`keep the ${carried.join(', ')} you set on the bridge since it was installed`);
}

function plural(n: number, one: string, many: string): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

export function planInstall(current: unknown, options: InstallOptions): PlanResult {
  const valid = validateSettings(current);
  if (!valid.ok) return valid;
  const base = valid.settings;
  const { port, token } = options;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    return { ok: false, error: 'port must be an integer between 1024 and 65535.' };
  }
  if (!/^[A-Za-z0-9_-]{8,}$/.test(token)) return { ok: false, error: 'token must be at least 8 URL-safe characters.' };
  const eventSet = options.events ?? 'all';
  const timeouts = checkTimeoutOverrides('install', eventSet, options.timeouts);
  if (timeouts.errors.length) return { ok: false, error: timeouts.errors.join('\n') };

  const forwarderPath = path.resolve(options.forwarderPath);
  if (shellUnsafePathChar(forwarderPath) !== null)
    return { ok: false, error: unsafePathError('hook forwarder', forwarderPath) };
  if (options.statusLine === true && options.statuslineWrapperPath !== undefined) {
    const wrapper = path.resolve(options.statuslineWrapperPath);
    if (shellUnsafePathChar(wrapper) !== null)
      return { ok: false, error: unsafePathError('status line wrapper', wrapper) };
  }
  if (isPlainObject(base.hooks)) {
    for (const event of [...eventsFor(eventSet), 'SessionStart']) {
      if (event in base.hooks && !Array.isArray(base.hooks[event])) {
        return { ok: false, error: `"hooks.${event}" in settings.json is not an array.` };
      }
    }
  }

  const next = structuredClone(base);
  const notes: string[] = [];
  const warnings = [...timeouts.warnings];

  const replaced = stripHuddleHooks(next);
  if (replaced) notes.push(`replace ${plural(replaced, 'existing Huddle hook entry', 'existing Huddle hook entries')}`);
  const hooks: JsonObject = isPlainObject(next.hooks) ? next.hooks : {};
  next.hooks = hooks;
  const events = eventsFor(eventSet);
  for (const event of events) {
    const entry = {
      type: 'http',
      url: `http://127.0.0.1:${String(port)}${HOOK_PATH_PREFIX}${event}`,
      timeout: timeouts.effective[event] ?? defaultTimeoutFor(event),
      headers: { 'X-Huddle-Token': token },
    };
    const existing = hooks[event];
    hooks[event] = [...(Array.isArray(existing) ? (existing as unknown[]) : []), { hooks: [entry] }];
  }
  // SessionStart only supports command hooks. Shell form with forward slashes runs in Git Bash and PowerShell.
  const forwarder = toPosixPath(path.resolve(options.forwarderPath));
  const startEntry = { type: 'command', command: `node "${forwarder}"`, timeout: DEFAULT_TIMEOUT };
  const existingStart = hooks.SessionStart;
  hooks.SessionStart = [...(Array.isArray(existingStart) ? (existingStart as unknown[]) : []), { hooks: [startEntry] }];
  notes.push(
    `add HTTP hooks for ${String(events.length)} events -> http://127.0.0.1:${String(port)}${HOOK_PATH_PREFIX}<Event>`,
  );
  notes.push(`add a SessionStart command hook -> node "${forwarder}"`);

  if (options.otel === false) {
    const removedEnv = stripHuddleTelemetry(next);
    if (removedEnv > 0) {
      notes.push(
        `remove ${plural(removedEnv, 'Huddle telemetry env var', 'Huddle telemetry env vars')} from an earlier install`,
      );
    }
    notes.push('skip telemetry: the Huddle will not see token usage');
  } else {
    stripHuddleTelemetry(next);
    const env: JsonObject = isPlainObject(next.env) ? next.env : {};
    const foreign = TELEMETRY_KEYS.filter((k) => k in env);
    if (foreign.length) {
      warnings.push(
        `You already have telemetry settings (${foreign.join(', ')}). They are left untouched, so the Huddle will not receive token usage.`,
      );
    } else {
      next.env = {
        ...env,
        CLAUDE_CODE_ENABLE_TELEMETRY: '1',
        OTEL_LOGS_EXPORTER: 'otlp',
        OTEL_METRICS_EXPORTER: 'otlp',
        OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
        OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${String(port)}`,
        OTEL_EXPORTER_OTLP_HEADERS: `X-Huddle-Token=${token}`,
        OTEL_LOGS_EXPORT_INTERVAL: '2000',
        OTEL_METRIC_EXPORT_INTERVAL: '10000',
      };
      notes.push(
        `add ${String(TELEMETRY_KEYS.length)} telemetry env vars (OTLP http/json -> http://127.0.0.1:${String(port)})`,
      );
    }
  }

  let statusLineToSave: SavedStatusLine | undefined;
  if (options.statusLine === true) {
    if (options.statuslineWrapperPath === undefined) {
      return { ok: false, error: 'statusLine needs the path of the status line wrapper.' };
    }
    statusLineToSave = planStatusLine(next, options.statuslineWrapperPath, notes, warnings);
  }

  // Idempotent: the same user content and the same Huddle content is no change, even if our entries moved.
  const same =
    canonicalJson(userPart(base)) === canonicalJson(userPart(next)) &&
    canonicalJson(huddlePart(base)) === canonicalJson(huddlePart(next));
  const after = same ? structuredClone(base) : next;
  return {
    ok: true,
    mode: 'install',
    changed: !same,
    before: base,
    after,
    notes: same ? ['the Huddle hooks are already installed'] : notes,
    warnings,
    fingerprint: fingerprintOf('install', after, statusLineToSave),
    consentFingerprint: consentFingerprintOf(after),
    ...(statusLineToSave !== undefined ? { statusLineToSave } : {}),
  };
}

export function planUninstall(current: unknown, options: UninstallOptions = {}): PlanResult {
  const valid = validateSettings(current);
  if (!valid.ok) return valid;
  const base = valid.settings;
  const timeouts = checkTimeoutOverrides('uninstall', 'all', options.timeouts);
  if (timeouts.errors.length) return { ok: false, error: timeouts.errors.join('\n') };
  const next = structuredClone(base);
  const notes: string[] = [];
  const warnings = [...timeouts.warnings];
  if (options.keepHooks !== true) {
    const removedHooks = stripHuddleHooks(next);
    notes.push(`remove ${plural(removedHooks, 'Huddle hook entry', 'Huddle hook entries')}`);
  }
  if (options.removeTelemetry) {
    const removedEnv = stripHuddleTelemetry(next);
    notes.push(`remove ${plural(removedEnv, 'Huddle telemetry env var', 'Huddle telemetry env vars')}`);
  } else if (telemetryIsHuddles(next.env)) {
    notes.push('keep the telemetry env vars (a stopped Huddle makes them silent)');
  }
  if (options.restoreStatusLine === true) {
    restoreStatusLine(next, options.statusLineOriginal, notes, warnings);
  } else if (isHuddleStatusLine(next.statusLine)) {
    notes.push('keep the status line bridge (it is silent while the Huddle is not running)');
  }
  const changed = canonicalJson(base) !== canonicalJson(next);
  return {
    ok: true,
    mode: 'uninstall',
    changed,
    before: base,
    after: changed ? next : structuredClone(base),
    notes,
    warnings,
    fingerprint: fingerprintOf('uninstall', next),
    consentFingerprint: consentFingerprintOf(next),
    ...(options.restoreStatusLine === true ? { forgetStatusLineOriginal: true } : {}),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Human-readable diff for the consent screen
// ---------------------------------------------------------------------------------------------------------------------

export interface DiffLine {
  op: ' ' | '+' | '-';
  text: string;
}

/** Settings serialized the way the installer writes them. */
export function serializeSettings(settings: JsonObject): string {
  return `${JSON.stringify(settings, null, 2)}\n`;
}

const MAX_DIFF_CELLS = 4_000_000;

export const HIDDEN = '<hidden>';
const TOKEN_PLACEHOLDER = '<token>';
const HUDDLE_TOKEN_HEADER = /^x-huddle-token$/i;
/** Header names whose values are credentials even when `isSecretName` does not say so. */
const CREDENTIAL_HEADER = /auth|cookie|session/i;

/** One header value for the consent screen: our token as <token>, credentials hidden, the rest masked. */
function displayHeader(name: string, value: string): string {
  if (HUDDLE_TOKEN_HEADER.test(name.trim())) return TOKEN_PLACEHOLDER;
  if (isSecretName(name) || CREDENTIAL_HEADER.test(name)) return HIDDEN;
  return maskSecrets(value);
}

/** OTEL_EXPORTER_OTLP_HEADERS is `name=value,name=value`: each value goes through `displayHeader`. */
function displayOtelHeaders(value: string): string {
  return value
    .split(',')
    .map((pair) => {
      const eq = pair.indexOf('=');
      if (eq < 0) return HIDDEN;
      const name = pair.slice(0, eq);
      const shown = displayHeader(name, pair.slice(eq + 1));
      return `${name}=${shown === TOKEN_PLACEHOLDER || shown === HIDDEN ? shown : HIDDEN}`;
    })
    .join(',');
}

function displayValue(key: string, value: unknown, inHeaders: boolean): unknown {
  if (typeof value === 'string') {
    if (inHeaders) return displayHeader(key, value);
    if (isSecretName(key)) return HIDDEN;
    return maskSecrets(value);
  }
  if (Array.isArray(value)) return value.map((item) => displayValue('', item, false));
  if (isPlainObject(value)) {
    // The values of a `headers` object are header values (inHeaders); deeper objects are ordinary again.
    const childrenAreHeaders = key === 'headers';
    const out: JsonObject = {};
    for (const [k, v] of Object.entries(value)) out[k] = displayValue(k, v, childrenAreHeaders);
    return out;
  }
  return value;
}

/**
 * A copy of settings safe to show on the consent screen. Env vars that are not the Huddle's own are `<hidden>` (the
 * user's other settings can hold API keys); any X-Huddle-Token is `<token>`, not only the current one; header
 * values that look like credentials are hidden; every other string goes through `maskSecrets`.
 */
export function settingsForDisplay(settings: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(settings)) {
    if (key === 'env' && isPlainObject(value)) {
      const env: JsonObject = {};
      for (const [name, v] of Object.entries(value)) {
        if (!(TELEMETRY_KEYS as readonly string[]).includes(name)) env[name] = HIDDEN;
        else if (name === 'OTEL_EXPORTER_OTLP_HEADERS' && typeof v === 'string') env[name] = displayOtelHeaders(v);
        else env[name] = displayValue(name, v, false);
      }
      out[key] = env;
    } else {
      out[key] = displayValue(key, value, false);
    }
  }
  return out;
}

/**
 * Line diff (LCS) of two settings objects, as the consent screen shows it: both sides go through
 * `settingsForDisplay`, and `secrets` are replaced by <token> as a last pass so the screen never shows them.
 */
export function diffSettings(before: JsonObject, after: JsonObject, secrets: readonly string[] = []): DiffLine[] {
  const redact = (s: string): string =>
    secrets.filter(Boolean).reduce((acc, secret) => acc.split(secret).join(TOKEN_PLACEHOLDER), s);
  const a = redact(JSON.stringify(settingsForDisplay(before), null, 2)).split('\n');
  const b = redact(JSON.stringify(settingsForDisplay(after), null, 2)).split('\n');
  if (a.length * b.length > MAX_DIFF_CELLS) {
    return [...a.map((text) => ({ op: '-' as const, text })), ...b.map((text) => ({ op: '+' as const, text }))];
  }
  // Lines are matched without a trailing comma, so a line that only gained a comma (because a key was added after it)
  // is not shown as changed. A kept line is shown as it will be written.
  const ka = a.map((l) => l.replace(/,$/, ''));
  const kb = b.map((l) => l.replace(/,$/, ''));
  // lcs[i][j] = length of the LCS of a[i..] and b[j..]
  const width = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * width + j] =
        ka[i] === kb[j]
          ? (lcs[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(lcs[(i + 1) * width + j] ?? 0, lcs[i * width + j + 1] ?? 0);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const ai = a[i] ?? '';
    const bj = b[j] ?? '';
    if (ka[i] === kb[j]) {
      out.push({ op: ' ', text: bj });
      i++;
      j++;
    } else if ((lcs[(i + 1) * width + j] ?? 0) >= (lcs[i * width + j + 1] ?? 0)) {
      out.push({ op: '-', text: ai });
      i++;
    } else {
      out.push({ op: '+', text: bj });
      j++;
    }
  }
  for (; i < a.length; i++) out.push({ op: '-', text: a[i] ?? '' });
  for (; j < b.length; j++) out.push({ op: '+', text: b[j] ?? '' });
  return out;
}

/** Unified-style text with `context` unchanged lines around each change; "..." marks skipped lines. */
export function formatDiff(lines: readonly DiffLine[], context = 3): string {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((line, idx) => {
    if (line.op === ' ') return;
    for (let k = Math.max(0, idx - context); k <= Math.min(lines.length - 1, idx + context); k++) keep[k] = true;
  });
  const out: string[] = [];
  let skipped = false;
  lines.forEach((line, idx) => {
    if (keep[idx]) {
      out.push(`${line.op} ${line.text}`);
      skipped = false;
    } else if (!skipped) {
      out.push('  ...');
      skipped = true;
    }
  });
  return out.join('\n');
}

// ---------------------------------------------------------------------------------------------------------------------
// I/O edge
// ---------------------------------------------------------------------------------------------------------------------

export interface InstallerDeps {
  /** Claude Code's config directory (CLAUDE_CONFIG_DIR or ~/.claude). Resolved with node:path; mixed slashes are fine. */
  configDir: string;
  now: () => Date;
  /** Makes a new token when none is configured yet. */
  newToken: () => string;
  /** The forwarder file shipped with the app; install copies it into <configDir>/agent-huddle/. */
  forwarderSource: string;
  /** How many timestamped backups of settings.json to keep (default 5). The "original" backup is kept besides. */
  keepBackups?: number;
  /** Shown by the SessionStart hint when the Huddle is not running, e.g. the app's "remove hooks" command line. */
  uninstallCommand?: string;
  /** The status line wrapper shipped with the app (scripts/huddle-statusline.mjs in dev). Needed for `statusLine`. */
  statuslineSource?: string;
}

export interface PrepareInstallOptions {
  port?: number;
  token?: string;
  events?: EventSet;
  otel?: boolean;
  timeouts?: Readonly<Record<string, number>>;
  /** F9, opt-in: wrap the user's status line with the bridge (default false: `statusLine` is not touched). */
  statusLine?: boolean;
}

export interface PreparedChange {
  mode: 'install' | 'uninstall';
  settingsPath: string;
  settingsExisted: boolean;
  plan: SettingsPlan;
  /** For the consent screen. The token is shown as <token>. */
  diff: DiffLine[];
  /** Install only: what install will write to <configDir>/agent-huddle/config.json. */
  port: number | null;
  token: string | null;
  installOptions: InstallOptions | null;
  uninstallOptions: UninstallOptions | null;
}

/**
 * The user's go-ahead. The app passes `{ consent: true }` after the first-run screen showed the diff, and on later
 * starts and quits once that consent is recorded. Typed loosely on purpose: `apply` checks for the literal `true`.
 */
export interface Consent {
  consent: unknown;
}

export type ApplyResult =
  | { status: 'written'; settingsPath: string; backupPath: string | null }
  | { status: 'unchanged'; settingsPath: string }
  /** No consent: nothing was written. */
  | { status: 'needs-consent' }
  /** settings.json changed in a way that changes the Huddle's part of the edit; show `prepared` again. */
  | { status: 'stale'; prepared: PreparedChange }
  | { status: 'error'; error: string };

interface ReadResult {
  exists: boolean;
  text: string | null;
  value?: unknown;
  error?: string;
}

function errorCode(err: unknown): string {
  return isPlainObject(err) && typeof err.code === 'string' ? err.code : '';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 1-based line and column of a character offset. */
function lineColumn(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, Math.max(0, Math.min(offset, text.length)));
  const lastBreak = before.lastIndexOf('\n');
  return { line: before.split('\n').length, column: before.length - lastBreak };
}

/**
 * Where a JSON.parse failure is, in words: "not valid JSON at line N, column M", or just "not valid JSON".
 * Only numbers are taken from the error: V8's message quotes the text around the error, which in settings.json can be
 * an API key or a token, so the message itself is never shown or logged.
 */
export function describeJsonError(text: string, err: unknown): string {
  const message = err instanceof Error ? err.message : '';
  const lc = /\(line (\d+) column (\d+)\)/.exec(message);
  if (lc) return `not valid JSON at line ${lc[1] ?? '?'}, column ${lc[2] ?? '?'}`;
  const position = /at position (\d+)/.exec(message);
  if (position) {
    const { line, column } = lineColumn(text, Number(position[1]));
    return `not valid JSON at line ${String(line)}, column ${String(column)}`;
  }
  if (/end of (JSON|data)/i.test(message)) {
    const { line, column } = lineColumn(text, text.length);
    return `not valid JSON at line ${String(line)}, column ${String(column)}`;
  }
  return 'not valid JSON';
}

async function readText(file: string): Promise<string | null> {
  try {
    return await fsp.readFile(file, 'utf8');
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return null;
    throw err;
  }
}

/** Temp files of the installer are tagged so a leftover one is recognizably ours. */
const TMP_TAG = 'huddle-tmp';

function tmpPathFor(file: string): string {
  return tmpPath(file, TMP_TAG);
}

/** Temp file + rename (retried on Windows' transient refusals); the temp file is removed on any error. */
function writeFileAtomic(file: string, data: string | Buffer, mode?: number): Promise<void> {
  return writeAtomic(file, data, { mode, tmpTag: TMP_TAG });
}

/** 20261113-164137-123 (UTC), sortable as text. */
export function backupStamp(date: Date): string {
  const iso = date.toISOString(); // 2026-11-13T16:41:37.123Z
  return `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}-${iso.slice(20, 23)}`;
}

const MAX_APPLY_ATTEMPTS = 3;
/**
 * settings.json, its backups and config.json carry the ingest token, so they are owner-only (SECURITY.md).
 * On Windows the mode bits are mostly ignored and the user-profile ACL does the work; elsewhere they matter.
 */
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIR_MODE = 0o700;

export class HookInstaller {
  readonly configDir: string;
  readonly settingsPath: string;
  readonly huddleDir: string;
  readonly configPath: string;
  readonly forwarderTarget: string;
  readonly statuslineTarget: string;
  readonly statuslineOriginalPath: string;
  private readonly deps: InstallerDeps;

  constructor(deps: InstallerDeps) {
    this.deps = deps;
    this.configDir = path.resolve(deps.configDir);
    this.settingsPath = path.join(this.configDir, 'settings.json');
    this.huddleDir = path.join(this.configDir, HUDDLE_DIRNAME);
    this.configPath = path.join(this.huddleDir, 'config.json');
    this.forwarderTarget = path.join(this.huddleDir, FORWARDER_FILENAME);
    this.statuslineTarget = path.join(this.huddleDir, STATUSLINE_WRAPPER_FILENAME);
    this.statuslineOriginalPath = path.join(this.huddleDir, STATUSLINE_ORIGINAL_FILENAME);
  }

  /** statusline-original.json, or null when it is missing or unreadable (then nothing can be restored from it). */
  async readSavedStatusLine(): Promise<SavedStatusLine | null> {
    try {
      const text = await readText(this.statuslineOriginalPath);
      if (text === null) return null;
      const value: unknown = JSON.parse(stripBom(text));
      return isPlainObject(value) && 'statusLine' in value ? { statusLine: value.statusLine } : null;
    } catch {
      return null;
    }
  }

  /**
   * For Ask the Huddle (M5 security review L1), read-only: the key names of settings.json's `env` block and whether it
   * sets `apiKeyHelper`. No value is returned, kept or logged (the env block can hold a key or a token). A missing file
   * has neither; a file that cannot be read or is not a JSON object answers null (unknown).
   */
  async readAskRelevantKeys(): Promise<{ envKeys: string[]; apiKeyHelper: boolean } | null> {
    let read: ReadResult;
    try {
      read = await this.readSettings();
    } catch {
      return null;
    }
    if (!read.exists) return { envKeys: [], apiKeyHelper: false };
    if (!('value' in read) || !isPlainObject(read.value)) return null;
    const env = read.value['env'];
    const helper = read.value['apiKeyHelper'];
    return {
      envKeys: isPlainObject(env) ? Object.keys(env) : [],
      apiKeyHelper: helper !== undefined && helper !== null && helper !== '',
    };
  }

  private async readSettings(): Promise<ReadResult> {
    const raw = await readText(this.settingsPath);
    if (raw === null) return { exists: false, text: null, value: undefined };
    const text = stripBom(raw);
    if (text.trim() === '') return { exists: true, text: raw, value: {} };
    try {
      return { exists: true, text: raw, value: JSON.parse(text) as unknown };
    } catch (err) {
      return { exists: true, text: raw, error: describeJsonError(text, err) };
    }
  }

  private async readConfig(): Promise<JsonObject> {
    try {
      const text = await readText(this.configPath);
      const value: unknown = text === null ? {} : JSON.parse(stripBom(text));
      return isPlainObject(value) ? value : {};
    } catch {
      return {};
    }
  }

  private plan(change: PreparedChange, current: unknown): PlanResult {
    return change.mode === 'install' && change.installOptions
      ? planInstall(current, change.installOptions)
      : planUninstall(current, change.uninstallOptions ?? {});
  }

  private build(
    mode: 'install' | 'uninstall',
    read: ReadResult,
    plan: SettingsPlan,
    installOptions: InstallOptions | null,
    uninstallOptions: UninstallOptions | null,
  ): PreparedChange {
    const token = installOptions?.token ?? null;
    return {
      mode,
      settingsPath: this.settingsPath,
      settingsExisted: read.exists,
      plan,
      diff: diffSettings(plan.before, plan.after, token ? [token] : []),
      port: installOptions?.port ?? null,
      token,
      installOptions,
      uninstallOptions,
    };
  }

  /** Reads settings.json and returns the change for the consent screen. Writes nothing. */
  async prepareInstall(options: PrepareInstallOptions = {}): Promise<PreparedChange | PlanError> {
    const read = await this.readSettings();
    if (read.error !== undefined) return this.unreadable(read.error);
    const config = await this.readConfig();
    const port = options.port ?? (typeof config.port === 'number' ? config.port : DEFAULT_PORT);
    const token =
      options.token ?? (typeof config.token === 'string' && config.token ? config.token : this.deps.newToken());
    const installOptions: InstallOptions = {
      port,
      token,
      forwarderPath: this.forwarderTarget,
      events: options.events ?? 'all',
      otel: options.otel ?? true,
      timeouts: options.timeouts ?? {},
    };
    if (options.statusLine === true) {
      if (this.deps.statuslineSource === undefined) {
        return { ok: false, error: 'The status line bridge is not available in this build.' };
      }
      installOptions.statusLine = true;
      installOptions.statuslineWrapperPath = this.statuslineTarget;
    }
    const plan = planInstall(read.value, installOptions);
    if (!plan.ok) return plan;
    return this.build('install', read, plan, installOptions, null);
  }

  /** Reads settings.json and returns the removal for review. Writes nothing. */
  async prepareUninstall(options: UninstallOptions = {}): Promise<PreparedChange | PlanError> {
    const read = await this.readSettings();
    if (read.error !== undefined) return this.unreadable(read.error);
    const withSaved: UninstallOptions =
      options.restoreStatusLine === true && options.statusLineOriginal === undefined
        ? { ...options, statusLineOriginal: await this.readSavedStatusLine() }
        : options;
    const plan = planUninstall(read.value, withSaved);
    if (!plan.ok) return plan;
    return this.build('uninstall', read, plan, null, withSaved);
  }

  /** `where` comes from `describeJsonError`: a line and column at most, never a fragment of the file. */
  private unreadable(where: string): PlanError {
    return {
      ok: false,
      error: `${this.settingsPath} is ${where}. Fix or remove the file first; the Huddle will not overwrite a file it cannot read.`,
    };
  }

  /**
   * The file a write replaces. When settings.json is a symbolic link (dotfiles kept in a repo), the link's target is
   * written, so the link survives; renaming a temp file over the link itself would replace it with a plain file.
   */
  private async writeTarget(): Promise<string> {
    try {
      const stat = await fsp.lstat(this.settingsPath);
      if (stat.isSymbolicLink()) return await fsp.realpath(this.settingsPath);
    } catch (err) {
      if (errorCode(err) !== 'ENOENT') throw err;
    }
    return this.settingsPath;
  }

  /**
   * Writes a prepared change. Nothing is written without `{ consent: true }`.
   * settings.json is re-read and the change re-planned right before the write, so edits made since `prepare` are
   * kept. If those edits change the Huddle's own part of the result, nothing is written and `stale` returns the
   * new change to show again.
   */
  async apply(prepared: PreparedChange, consent: Consent): Promise<ApplyResult> {
    // Only the literal `true` counts: a truthy string or object from a sloppy caller is not consent.
    if (consent.consent !== true) return { status: 'needs-consent' };
    try {
      for (let attempt = 0; attempt < MAX_APPLY_ATTEMPTS; attempt++) {
        const read = await this.readSettings();
        if (read.error !== undefined) return { status: 'error', error: this.unreadable(read.error).error };
        const fresh = this.plan(prepared, read.value);
        if (!fresh.ok) return { status: 'error', error: fresh.error };
        if (fresh.fingerprint !== prepared.plan.fingerprint) {
          return {
            status: 'stale',
            prepared: this.build(prepared.mode, read, fresh, prepared.installOptions, prepared.uninstallOptions),
          };
        }
        // The saved original and the wrapper land before settings.json points at them.
        if (prepared.mode === 'install') await this.writeHuddleFiles(prepared, fresh);
        if (!fresh.changed) {
          if (fresh.forgetStatusLineOriginal === true) await this.forgetSavedStatusLine();
          return { status: 'unchanged', settingsPath: this.settingsPath };
        }

        await fsp.mkdir(this.configDir, { recursive: true });
        const target = await this.writeTarget();
        // Same folder as the target, so the final rename stays on one volume and is atomic.
        const tmp = tmpPathFor(target);
        let backupPath: string | null = null;
        // From the temp write to the rename, any error removes the temp file (a failed write can leave a partial one).
        try {
          await fsp.writeFile(tmp, serializeSettings(fresh.after), { mode: PRIVATE_FILE_MODE });
          // Last check: nobody changed settings.json while we planned and wrote the temp file.
          const again = await readText(this.settingsPath);
          if (again !== read.text) {
            await fsp.rm(tmp, { force: true });
            continue;
          }
          if (read.text !== null) backupPath = await this.backup(read.text);
          await renameWithRetry(tmp, target);
        } catch (err) {
          await fsp.rm(tmp, { force: true }).catch(() => undefined);
          throw err;
        }
        if (backupPath !== null) await this.rotateBackups();
        if (fresh.forgetStatusLineOriginal === true) await this.forgetSavedStatusLine();
        return { status: 'written', settingsPath: this.settingsPath, backupPath };
      }
      return { status: 'error', error: `${this.settingsPath} kept changing while the Huddle tried to update it.` };
    } catch (err) {
      return { status: 'error', error: errorMessage(err) };
    }
  }

  /** Attach: prepare and apply the install in one step (after the first-run consent was given). */
  async install(options: PrepareInstallOptions, consent: Consent): Promise<ApplyResult> {
    const prepared = await this.prepareInstall(options);
    if ('ok' in prepared) return { status: 'error', error: prepared.error };
    return this.apply(prepared, consent);
  }

  /** Detach (quit): remove only the Huddle's hooks; telemetry stays unless asked. */
  async uninstall(options: UninstallOptions, consent: Consent): Promise<ApplyResult> {
    const prepared = await this.prepareUninstall(options);
    if ('ok' in prepared) return { status: 'error', error: prepared.error };
    return this.apply(prepared, consent);
  }

  /** Removes statusline-original.json after a restore; a missing file is fine. */
  private async forgetSavedStatusLine(): Promise<void> {
    await fsp.rm(this.statuslineOriginalPath, { force: true });
  }

  /**
   * config.json (port, token, the hint's uninstall command), the forwarder copy and, when the bridge is in the plan,
   * the status line wrapper and the saved original line. All written atomically.
   */
  private async writeHuddleFiles(prepared: PreparedChange, fresh: SettingsPlan): Promise<void> {
    await fsp.mkdir(this.huddleDir, { recursive: true, mode: PRIVATE_DIR_MODE });
    // mkdir's mode applies only when it creates the folder; tighten one that already existed. Best effort: on Windows
    // chmod only toggles read-only (0o700 keeps it writable) and the user-profile ACL does the work.
    await fsp.chmod(this.huddleDir, PRIVATE_DIR_MODE).catch(() => undefined);
    // Both scripts run as `node "<file>"`, so they need no exec bit: owner read/write only.
    const source = await fsp.readFile(this.deps.forwarderSource);
    await writeFileAtomic(this.forwarderTarget, source, PRIVATE_FILE_MODE);
    if (this.deps.statuslineSource !== undefined && isHuddleStatusLine(fresh.after.statusLine)) {
      await writeFileAtomic(this.statuslineTarget, await fsp.readFile(this.deps.statuslineSource), PRIVATE_FILE_MODE);
    }
    if (fresh.statusLineToSave !== undefined) {
      const saved = { statusLine: fresh.statusLineToSave.statusLine, savedAt: this.deps.now().toISOString() };
      await writeFileAtomic(this.statuslineOriginalPath, `${JSON.stringify(saved, null, 2)}\n`, PRIVATE_FILE_MODE);
    }
    const existing = await this.readConfig();
    const config: JsonObject = {
      ...existing,
      port: prepared.port,
      token: prepared.token,
      updatedAt: this.deps.now().toISOString(),
    };
    if (this.deps.uninstallCommand !== undefined) config.uninstallCommand = this.deps.uninstallCommand;
    await writeFileAtomic(this.configPath, `${JSON.stringify(config, null, 2)}\n`, PRIVATE_FILE_MODE);
  }

  /** Saves `text` (the settings the write is based on) as a timestamped backup; keeps a first-ever "original". */
  private async backup(text: string): Promise<string> {
    const names = await this.backupNames();
    const originalPath = path.join(this.configDir, ORIGINAL_BACKUP_NAME);
    if ((await readText(originalPath)) === null) {
      // The oldest backup (possibly from the M0 script) is the closest to the user's own file.
      const oldest = names[0];
      const originalText = oldest ? await readText(path.join(this.configDir, oldest)) : null;
      await writeFileAtomic(originalPath, originalText ?? text, PRIVATE_FILE_MODE);
    }
    const base = `${BACKUP_PREFIX}${backupStamp(this.deps.now())}`;
    let name = base;
    for (let n = 2; names.includes(name); n++) name = `${base}-${String(n)}`;
    const backupPath = path.join(this.configDir, name);
    await writeFileAtomic(backupPath, text, PRIVATE_FILE_MODE);
    return backupPath;
  }

  /** Timestamped backups, oldest first. */
  private async backupNames(): Promise<string[]> {
    const entries = await fsp.readdir(this.configDir).catch(() => [] as string[]);
    return entries.filter((n) => n.startsWith(BACKUP_PREFIX) && n !== ORIGINAL_BACKUP_NAME).sort();
  }

  private async rotateBackups(): Promise<void> {
    const keep = this.deps.keepBackups ?? DEFAULT_KEEP_BACKUPS;
    const names = await this.backupNames();
    for (const name of names.slice(0, Math.max(0, names.length - keep))) {
      await fsp.rm(path.join(this.configDir, name), { force: true });
    }
  }
}
