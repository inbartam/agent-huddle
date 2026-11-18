import { describe, expect, it, vi } from 'vitest';
import type { ShortcutStatus } from '@huddle/shared';
import { createShortcutManager, shortcutAction, type GlobalShortcutLike } from './shortcut.js';

/** A fake Electron globalShortcut: `taken` combinations belong to another app; `bad` ones throw like Electron does. */
function fakeShortcuts(taken: string[] = [], bad: string[] = []) {
  const registered = new Map<string, () => void>();
  const register = vi.fn((accelerator: string, cb: () => void) => {
    if (bad.includes(accelerator)) throw new Error('conversion failure');
    if (taken.includes(accelerator) || registered.has(accelerator)) return false;
    registered.set(accelerator, cb);
    return true;
  });
  const unregister = vi.fn((accelerator: string) => {
    registered.delete(accelerator);
  });
  const api: GlobalShortcutLike = { register, unregister };
  return { api, registered, register };
}

describe('global shortcut', () => {
  it('registers the default and calls back when pressed', () => {
    const { api, registered } = fakeShortcuts();
    const trigger = vi.fn();
    const statuses: ShortcutStatus[] = [];
    const m = createShortcutManager(api, trigger, (s) => statuses.push(s));
    expect(m.apply('Control+Alt+H')).toEqual({ accelerator: 'Control+Alt+H', registered: true, message: null });
    registered.get('Control+Alt+H')?.();
    expect(trigger).toHaveBeenCalledTimes(1);
    expect(statuses).toHaveLength(1);
  });

  it('applying the same accelerator again does nothing', () => {
    const { api, register } = fakeShortcuts();
    const m = createShortcutManager(api, () => undefined);
    m.apply('Control+Alt+H');
    m.apply('Control+Alt+H');
    expect(register).toHaveBeenCalledTimes(1);
  });

  it('re-registers when the setting changes', () => {
    const { api, registered } = fakeShortcuts();
    const m = createShortcutManager(api, () => undefined);
    m.apply('Control+Alt+H');
    expect(m.apply('Control+Alt+J').registered).toBe(true);
    expect([...registered.keys()]).toEqual(['Control+Alt+J']);
  });

  it('a taken combination is reported, and the previous shortcut keeps working', () => {
    const { api, registered } = fakeShortcuts(['Control+Alt+J']);
    const m = createShortcutManager(api, () => undefined);
    m.apply('Control+Alt+H');
    const s = m.apply('Control+Alt+J');
    expect(s).toMatchObject({ accelerator: 'Control+Alt+J', registered: false, activeAccelerator: 'Control+Alt+H' });
    expect(s.message).toContain('Control+Alt+H still works');
    expect([...registered.keys()]).toEqual(['Control+Alt+H']);
    expect(m.status()).toEqual(s);
  });

  it('a first registration that fails says to choose another; an accelerator Electron rejects does not throw', () => {
    const taken = createShortcutManager(fakeShortcuts(['Control+Alt+H']).api, () => undefined);
    expect(taken.apply('Control+Alt+H')).toMatchObject({ registered: false });
    expect(taken.status()?.message).toContain('Choose another in Settings');
    const bad = createShortcutManager(fakeShortcuts([], ['Nope+Nope']).api, () => undefined);
    expect(() => bad.apply('Nope+Nope')).not.toThrow();
    expect(bad.status()).toMatchObject({ registered: false });
  });

  it('retries a failed accelerator when applied again (the other app may have let go)', () => {
    const taken = ['Control+Alt+H'];
    const { api } = fakeShortcuts(taken);
    const m = createShortcutManager(api, () => undefined);
    expect(m.apply('Control+Alt+H').registered).toBe(false);
    taken.pop();
    expect(m.apply('Control+Alt+H').registered).toBe(true);
  });

  it('unregisters on dispose', () => {
    const { api, registered } = fakeShortcuts();
    const m = createShortcutManager(api, () => undefined);
    m.apply('Control+Alt+H');
    m.dispose();
    expect(registered.size).toBe(0);
  });
});

describe('what the shortcut does to the widget', () => {
  it('shows a hidden widget, focuses an unfocused one, hides a focused one', () => {
    expect(shortcutAction(null)).toBe('show');
    expect(shortcutAction({ visible: false, focused: false })).toBe('show');
    expect(shortcutAction({ visible: true, focused: false })).toBe('focus');
    expect(shortcutAction({ visible: true, focused: true })).toBe('hide');
  });
});
