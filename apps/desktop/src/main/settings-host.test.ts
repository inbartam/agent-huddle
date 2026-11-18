import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_USER_SETTINGS,
  type CommandResult,
  type HuddleCommand,
  type HuddleEvent,
  type UserSettings,
} from '@huddle/shared';
import { createCannedCore } from './canned-core.js';
import type { CoreHost } from './core-host.js';
import {
  createCoreSettingsHost,
  createMemorySettingsHost,
  splitStartWithWindows,
  START_WITH_WINDOWS_UNAVAILABLE,
  type UserSettingsSource,
} from './settings-host.js';
import { parseCommand } from './validate.js';

const update = (patch: unknown): HuddleCommand => {
  const cmd = parseCommand({ type: 'settings.update', patch });
  if (!cmd) throw new Error('rejected');
  return cmd;
};

/**
 * A stand-in for HuddleCore: the canned core's state plus settings it owns. `settings.update` answers with `answer`
 * and, when ok, adopts `next` and emits an empty batch (as HuddleCore does after saving).
 */
function fakeRealCore(answer: CommandResult = { ok: true }) {
  const canned = createCannedCore();
  let settings: UserSettings = DEFAULT_USER_SETTINGS;
  let next: UserSettings = DEFAULT_USER_SETTINGS;
  const listeners = new Set<(b: readonly HuddleEvent[]) => void>();
  const emit = () => {
    for (const l of listeners) l([]);
  };
  const command = vi.fn((cmd: HuddleCommand): Promise<CommandResult> => {
    if (cmd.type !== 'settings.update') return Promise.resolve({ ok: true });
    if (answer.ok) {
      settings = next;
      emit();
    }
    return Promise.resolve(answer);
  });
  const core: CoreHost & UserSettingsSource = {
    getState: () => canned.getState(),
    getEvents: (k, n) => canned.getEvents(k, n),
    query: (q) => canned.query(q),
    command,
    onEvents: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    dispose: () => Promise.resolve(),
    getUserSettings: () => settings,
  };
  return {
    core,
    command,
    willAdopt: (s: UserSettings) => {
      next = s;
    },
    /** The core read the file at start (or something else changed it) and emitted. */
    adoptNow: (s: UserSettings) => {
      settings = s;
      emit();
    },
  };
}

function fakeLoginItem(initial = false) {
  let on = initial;
  return {
    get: vi.fn(() => on),
    set: vi.fn((next: boolean) => {
      on = next;
    }),
  };
}

describe('startWithWindows (M6 P6, main owns it)', () => {
  it('is absent without a login item, and a patch that sets it is refused', async () => {
    const { core, command } = fakeRealCore();
    const host = createCoreSettingsHost(core);
    expect(host.getState().settings?.startWithWindows).toBeUndefined();
    await expect(host.command(update({ startWithWindows: true }))).resolves.toMatchObject({
      ok: false,
      code: 'unsupported',
      message: START_WITH_WINDOWS_UNAVAILABLE,
    });
    expect(command).not.toHaveBeenCalled();
  });

  it('reads the login item (off by default) and applies a patch without the core seeing it', async () => {
    const { core, command } = fakeRealCore();
    const item = fakeLoginItem();
    const host = createCoreSettingsHost(core, { loginItem: item });
    expect(host.getState().settings?.startWithWindows).toBe(false);
    const changed = vi.fn();
    host.onSettingsChanged(changed);
    const batches: number[] = [];
    host.onEvents((b) => batches.push(b.length));

    await expect(host.command(update({ startWithWindows: true }))).resolves.toEqual({ ok: true });
    expect(item.set).toHaveBeenCalledWith(true);
    expect(command).not.toHaveBeenCalled();
    expect(host.settings().startWithWindows).toBe(true);
    expect(changed).toHaveBeenCalledWith(expect.objectContaining({ startWithWindows: true }));
    expect(batches).toContain(0);
  });

  it('passes the rest of a mixed patch to the core without startWithWindows', async () => {
    const { core, command } = fakeRealCore();
    const item = fakeLoginItem();
    const host = createCoreSettingsHost(core, { loginItem: item });
    await host.command(update({ startWithWindows: true, widgetCollapsed: true }));
    expect(item.set).toHaveBeenCalledWith(true);
    expect(command).toHaveBeenCalledWith({ type: 'settings.update', patch: { widgetCollapsed: true } });
  });

  it('leaves auto-start alone when the core refuses the other fields (A4-04)', async () => {
    const { core } = fakeRealCore({ ok: false, code: 'invalid', message: 'bad field' });
    const item = fakeLoginItem();
    const host = createCoreSettingsHost(core, { loginItem: item });
    await expect(host.command(update({ startWithWindows: true, widgetCollapsed: true }))).resolves.toMatchObject({
      ok: false,
      code: 'invalid',
    });
    expect(item.set).not.toHaveBeenCalled();
  });

  it('refuses a value that is not a boolean, and a login item that throws', async () => {
    const item = fakeLoginItem();
    const host = createCoreSettingsHost(fakeRealCore().core, { loginItem: item });
    await expect(host.command(update({ startWithWindows: 'yes' }))).resolves.toMatchObject({
      ok: false,
      code: 'invalid',
    });
    expect(item.set).not.toHaveBeenCalled();
    item.set.mockImplementation(() => {
      throw new Error('registry');
    });
    await expect(host.command(update({ startWithWindows: true }))).resolves.toMatchObject({
      ok: false,
      code: 'failed',
    });
  });

  it('works the same over the canned memory host', async () => {
    const item = fakeLoginItem(true);
    const host = createMemorySettingsHost(createCannedCore(), DEFAULT_USER_SETTINGS, { loginItem: item });
    expect(host.settings().startWithWindows).toBe(true);
    await host.command(update({ startWithWindows: false }));
    expect(host.settings().startWithWindows).toBe(false);
  });

  it('splitStartWithWindows leaves other patches alone', () => {
    const cmd = { type: 'settings.update', patch: { questionHoldSeconds: 30 } } as const;
    expect(splitStartWithWindows(cmd)).toEqual({ startWithWindows: null, rest: cmd });
    expect(splitStartWithWindows({ type: 'settings.update', patch: { startWithWindows: false } })).toEqual({
      startWithWindows: false,
      rest: null,
    });
  });
});

describe('settings host over the real core', () => {
  it('forwards settings.update to core.command and reads the result from getUserSettings()', async () => {
    const { core, command, willAdopt } = fakeRealCore();
    const host = createCoreSettingsHost(core);
    const changed = vi.fn();
    host.onSettingsChanged(changed);
    const batches: number[] = [];
    host.onEvents((b) => batches.push(b.length));
    const cmd = update({ globalShortcut: 'Control+Alt+J' });
    willAdopt({ ...DEFAULT_USER_SETTINGS, globalShortcut: 'Control+Alt+J' });

    await expect(host.command(cmd)).resolves.toEqual({ ok: true });

    expect(command).toHaveBeenCalledWith(cmd);
    expect(host.settings().globalShortcut).toBe('Control+Alt+J');
    expect(host.getState().settings?.globalShortcut).toBe('Control+Alt+J');
    expect(changed).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledWith(expect.objectContaining({ globalShortcut: 'Control+Alt+J' }));
    expect(batches.length).toBeGreaterThan(0);
    expect(batches.every((n) => n === 0)).toBe(true);
  });

  it('a failed update comes back as is and changes nothing', async () => {
    const failed: CommandResult = { ok: false, code: 'failed', message: 'Settings could not be saved.' };
    const { core } = fakeRealCore(failed);
    const host = createCoreSettingsHost(core);
    const changed = vi.fn();
    host.onSettingsChanged(changed);
    await expect(host.command(update({ questionHoldSeconds: 30 }))).resolves.toEqual(failed);
    expect(host.settings().questionHoldSeconds).toBe(DEFAULT_USER_SETTINGS.questionHoldSeconds);
    expect(changed).not.toHaveBeenCalled();
  });

  it('tells onSettingsChanged when the core adopts the file at start (no command involved)', () => {
    const { core, adoptNow } = fakeRealCore();
    const host = createCoreSettingsHost(core);
    const changed = vi.fn();
    host.onSettingsChanged(changed);
    adoptNow({ ...DEFAULT_USER_SETTINGS, globalShortcut: 'Control+Shift+K' });
    expect(changed).toHaveBeenCalledWith(expect.objectContaining({ globalShortcut: 'Control+Shift+K' }));
    // An emit without a change says nothing.
    adoptNow({ ...DEFAULT_USER_SETTINGS, globalShortcut: 'Control+Shift+K' });
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('passes setup.attach through and writes nothing afterwards', async () => {
    const { core, command } = fakeRealCore();
    const host = createCoreSettingsHost(core);
    await host.command({ type: 'setup.attach' });
    expect(command).toHaveBeenCalledTimes(1);
    expect(command).toHaveBeenCalledWith({ type: 'setup.attach' });
  });
});

describe('settings host over the canned core (in memory)', () => {
  it('fills HuddleState.settings and leaves the rest of the state alone', () => {
    const core = createCannedCore();
    const host = createMemorySettingsHost(core, DEFAULT_USER_SETTINGS);
    const state = host.getState();
    expect(state.settings).toEqual(DEFAULT_USER_SETTINGS);
    expect(state.agents).toBe(core.getState().agents);
    expect(state.shortcut).toBeUndefined();
  });

  it('settings.update changes state, tells listeners with an empty batch, and calls onSettingsChanged', async () => {
    const core = createCannedCore();
    const run = vi.spyOn(core, 'command');
    const host = createMemorySettingsHost(core, DEFAULT_USER_SETTINGS);
    const batches: number[] = [];
    host.onEvents((b) => batches.push(b.length));
    const changed = vi.fn();
    host.onSettingsChanged(changed);
    await expect(host.command(update({ toasts: { loop: false }, globalShortcut: 'Control+Alt+J' }))).resolves.toEqual({
      ok: true,
    });
    expect(host.getState().settings?.toasts.loop).toBe(false);
    expect(host.getState().settings?.toasts.approval).toBe(true);
    expect(host.settings().globalShortcut).toBe('Control+Alt+J');
    expect(batches).toEqual([0]);
    expect(changed).toHaveBeenCalledWith(expect.objectContaining({ globalShortcut: 'Control+Alt+J' }));
    expect(run).not.toHaveBeenCalled();
  });

  it('drops unknown fields the patch carried', async () => {
    const host = createMemorySettingsHost(createCannedCore(), DEFAULT_USER_SETTINGS);
    await host.command(update({ toasts: { stuck: false, evil: 1 }, extra: true }));
    expect(host.settings().toasts).toEqual({ ...DEFAULT_USER_SETTINGS.toasts, stuck: false });
    expect(Object.keys(host.settings())).toEqual(Object.keys(DEFAULT_USER_SETTINGS));
  });

  it('passes every other command to the core', async () => {
    const core = createCannedCore();
    const run = vi.spyOn(core, 'command');
    const host = createMemorySettingsHost(core, DEFAULT_USER_SETTINGS);
    await host.command({ type: 'agent.pause', agentKey: 's1' });
    expect(run).toHaveBeenCalledWith({ type: 'agent.pause', agentKey: 's1' });
  });

  it('shows the shortcut status and pokes listeners only when it changes', () => {
    const host = createMemorySettingsHost(createCannedCore(), DEFAULT_USER_SETTINGS);
    const batches: number[] = [];
    host.onEvents((b) => batches.push(b.length));
    const status = { accelerator: 'Control+Alt+H', registered: false, message: 'taken' };
    host.setShortcutStatus(status);
    host.setShortcutStatus({ ...status });
    expect(host.getState().shortcut).toEqual(status);
    expect(batches).toEqual([0]);
  });
});
