/**
 * The user's settings (M3) in main, ADR-017 pattern: `HuddleState.settings` (and `HuddleState.shortcut`) are filled
 * here next to the core's state, not derived from events. This wraps any CoreHost; every other command goes to the
 * core unchanged.
 *
 * Two kinds of source:
 * - The real core (`HuddleCore`) owns the preferences: it validates `settings.update`, saves it to
 *   `<dataDir>/huddle-settings.json` (re-reading the file before each write) and uses the result itself (question
 *   window, detector thresholds). This host forwards the command and reads `getUserSettings()`.
 * - The canned dev core has no settings, so they are kept in memory here and nothing is written.
 *
 * A change reaches the windows as an empty event batch ("read the state again"), like `connection`. Main hears about
 * it through `onSettingsChanged` (it re-registers the shortcut), including when the core adopts the file's
 * preferences at start.
 *
 * M5: `history.setRetention` and `ask.setEnabled` change settings too, so they take the same path as
 * `settings.update` (the real core owns them; the memory source applies them itself).
 *
 * M6 P6: `startWithWindows` is the one setting main owns. Its truth is the Windows login item (`LoginItem`), read on
 * every `settings()`, never stored: a `settings.update` patch that carries it is applied here and the field is taken
 * out before the rest goes to the core. Without a `LoginItem` (dev runs, other platforms) the field stays absent and
 * a patch that tries to set it is refused, so the renderer shows the switch disabled with its reason.
 */
import {
  applyUserSettingsPatch,
  type CommandResult,
  type HuddleCommand,
  type HuddleState,
  type ShortcutStatus,
  type UserSettings,
  type UserSettingsPatch,
} from '@huddle/shared';
import { parseUserSettings } from '@huddle/core';
import type { CoreHost, EventsListener } from './core-host.js';

/** What the real core offers on top of CoreHost: the preferences it is using now. */
export interface UserSettingsSource {
  getUserSettings(): UserSettings;
}

export interface SettingsHost extends CoreHost {
  settings(): UserSettings;
  /** Called whenever the settings in use change (main re-registers the shortcut). Returns an unsubscribe function. */
  onSettingsChanged(listener: (settings: UserSettings) => void): () => void;
  /** Main reports the shortcut's registration; it shows in `getState().shortcut`. */
  setShortcutStatus(status: ShortcutStatus): void;
}

/** The Windows login item ("Start Agent Huddle when Windows starts"), as main reaches it (index.ts, login-item.ts). */
export interface LoginItem {
  get(): boolean;
  set(on: boolean): void;
}

export interface SettingsHostOptions {
  /** Present only in a packaged Windows build. */
  loginItem?: LoginItem | null;
}

export const START_WITH_WINDOWS_UNAVAILABLE = 'Starting with Windows is only available in the installed app.';
export const START_WITH_WINDOWS_INVALID = 'Start with Windows must be on or off.';
export const START_WITH_WINDOWS_FAILED =
  'Windows did not accept the change. Try again, or check Task Manager, Startup apps.';

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * The real core owns the settings. `settings.update` goes to `core.command`; the host notices a change after the
 * command and on every batch the core emits (the core adopts the file's preferences at start, then emits).
 */
export function createCoreSettingsHost(
  core: CoreHost & UserSettingsSource,
  options: SettingsHostOptions = {},
): SettingsHost {
  return wrap(
    core,
    {
      read: () => core.getUserSettings(),
      update: (cmd) => core.command(cmd),
    },
    options.loginItem ?? null,
  );
}

/**
 * Canned dev core only: settings live in memory, validated the same way, never written. Like the real core, it refuses
 * `huddle.ask` while Ask is off (the canned core would otherwise answer it).
 */
export function createMemorySettingsHost(
  core: CoreHost,
  initial: UserSettings,
  options: SettingsHostOptions = {},
): SettingsHost {
  let current = parseUserSettings(initial);
  return wrap(
    core,
    {
      read: () => current,
      gate: (cmd) =>
        cmd.type === 'huddle.ask' && !current.ask.enabled
          ? {
              ok: false,
              code: 'failed',
              message: 'Ask the Huddle is off. Turn it on in Settings.',
              askError: 'disabled',
            }
          : null,
      update: (cmd) => {
        // parseUserSettings drops any unknown field the patch carried (the IPC schema keeps them) and re-checks ranges.
        if (cmd.type === 'settings.update') current = parseUserSettings(applyUserSettingsPatch(current, cmd.patch));
        else if (cmd.type === 'history.setRetention') {
          current = parseUserSettings({ ...current, history: { retentionDays: cmd.days } });
        } else current = parseUserSettings({ ...current, ask: { enabled: cmd.enabled } });
        return Promise.resolve({ ok: true });
      },
    },
    options.loginItem ?? null,
  );
}

/** Commands that change the user's settings. */
type SettingsUpdate = Extract<HuddleCommand, { type: 'settings.update' | 'history.setRetention' | 'ask.setEnabled' }>;

function isSettingsUpdate(cmd: HuddleCommand): cmd is SettingsUpdate {
  return cmd.type === 'settings.update' || cmd.type === 'history.setRetention' || cmd.type === 'ask.setEnabled';
}

interface Source {
  read(): UserSettings;
  update(cmd: SettingsUpdate): Promise<CommandResult>;
  /** A command answered here instead of by the core (null: pass it on). */
  gate?: (cmd: HuddleCommand) => CommandResult | null;
}

/**
 * Pure: a `settings.update` split into the part main applies (`startWithWindows`) and the part for the core. `rest` is
 * null when nothing is left for the core (the patch only carried `startWithWindows`). `startWithWindows` is null when
 * the patch did not carry it, and 'invalid' when it carried something that is not a boolean (the IPC schema keeps
 * unknown fields without checking them).
 */
export function splitStartWithWindows(cmd: Extract<HuddleCommand, { type: 'settings.update' }>): {
  startWithWindows: boolean | null | 'invalid';
  rest: Extract<HuddleCommand, { type: 'settings.update' }> | null;
} {
  if (!Object.hasOwn(cmd.patch, 'startWithWindows')) return { startWithWindows: null, rest: cmd };
  const { startWithWindows: raw, ...patch } = cmd.patch as UserSettingsPatch & { startWithWindows?: unknown };
  const startWithWindows = typeof raw === 'boolean' ? raw : 'invalid';
  const rest = Object.keys(patch).length > 0 ? { ...cmd, patch } : null;
  return { startWithWindows, rest };
}

function wrap(core: CoreHost, inner: Source, loginItem: LoginItem | null): SettingsHost {
  let shortcut: ShortcutStatus | null = null;
  /** The settings in use, with the login item's current value when there is one. */
  const read = (): UserSettings => {
    const s = inner.read();
    if (loginItem === null) return s;
    let on = false;
    try {
      on = loginItem.get();
    } catch {
      /* unreadable: shown as off */
    }
    return { ...s, startWithWindows: on };
  };
  const source: Source = { ...inner, read };
  let last = source.read();
  const listeners = new Set<EventsListener>();
  const changed = new Set<(settings: UserSettings) => void>();

  const poke = () => {
    for (const l of listeners) l([]);
  };
  /** Tells `onSettingsChanged` listeners when the settings in use differ from the last ones seen. */
  const check = (): boolean => {
    const now = source.read();
    if (same(now, last)) return false;
    last = now;
    for (const l of changed) l(now);
    return true;
  };
  const offCore = core.onEvents(() => {
    check();
  });

  return {
    getState(): HuddleState {
      const state = core.getState();
      return { ...state, settings: source.read(), ...(shortcut ? { shortcut } : {}) };
    },
    getEvents: (agentKey, limit) => core.getEvents(agentKey, limit),
    query: (q) => core.query(q),
    async command(cmd) {
      const gated = source.gate?.(cmd) ?? null;
      if (gated !== null) return gated;
      if (!isSettingsUpdate(cmd)) return core.command(cmd);
      let forCore: SettingsUpdate | null = cmd;
      let autoStart: boolean | null = null;
      if (cmd.type === 'settings.update') {
        const split = splitStartWithWindows(cmd);
        if (split.startWithWindows === 'invalid') {
          return { ok: false, code: 'invalid', message: START_WITH_WINDOWS_INVALID };
        }
        if (split.startWithWindows !== null && loginItem === null) {
          return { ok: false, code: 'unsupported', message: START_WITH_WINDOWS_UNAVAILABLE };
        }
        autoStart = split.startWithWindows;
        forCore = split.rest;
      }
      let result: CommandResult = { ok: true };
      if (forCore !== null) {
        result = await source.update(forCore);
        // Auto-start changes the machine, so it waits until the core has accepted the other fields.
        if (!result.ok) return result;
      }
      if (autoStart !== null && loginItem !== null) {
        try {
          loginItem.set(autoStart);
        } catch {
          if (forCore !== null && check()) poke();
          return { ok: false, code: 'failed', message: START_WITH_WINDOWS_FAILED };
        }
      }
      // The real core also emits an empty batch a moment later; the memory source does not. A second "read the state
      // again" is harmless, a missing one leaves the windows stale, so poke on every change.
      if (check()) poke();
      return result;
    },
    onEvents(listener) {
      listeners.add(listener);
      const off = core.onEvents(listener);
      return () => {
        listeners.delete(listener);
        off();
      };
    },
    dispose: () => {
      offCore();
      return core.dispose();
    },
    settings: () => source.read(),
    onSettingsChanged(listener) {
      changed.add(listener);
      return () => changed.delete(listener);
    },
    setShortcutStatus(status) {
      if (same(status, shortcut)) return;
      shortcut = status;
      poke();
    },
  };
}
