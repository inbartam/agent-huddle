/**
 * The global shortcut (F15): `settings.globalShortcut` (default `Control+Alt+H`) shows and focuses the widget, or
 * hides it when it already has focus. Electron's built-in `globalShortcut` (no native module, ADR-003), injected so
 * this file is testable without Electron.
 *
 * Registration can fail: another app holds the combination (Electron returns false) or the accelerator is not one
 * Electron understands (it throws). Either way the failure is reported as `ShortcutStatus` and shown through
 * `HuddleState.shortcut` (ADR-017 pattern: main fills it next to the reducer's state, no IPC channel), and the
 * previous working shortcut is kept.
 */
import type { ShortcutStatus } from '@huddle/shared';

export interface GlobalShortcutLike {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
}

export interface ShortcutManager {
  /** Register `accelerator` (no-op when it is already the active one). Returns the resulting status. */
  apply(accelerator: string): ShortcutStatus;
  status(): ShortcutStatus | null;
  /** Unregister (on quit). */
  dispose(): void;
}

function tryRegister(api: GlobalShortcutLike, accelerator: string, onTrigger: () => void): boolean {
  try {
    return api.register(accelerator, onTrigger);
  } catch {
    return false; // Electron throws for an accelerator it cannot parse
  }
}

function tryUnregister(api: GlobalShortcutLike, accelerator: string): void {
  try {
    api.unregister(accelerator);
  } catch {
    /* nothing registered under that name */
  }
}

export function createShortcutManager(
  api: GlobalShortcutLike,
  onTrigger: () => void,
  onStatus: (status: ShortcutStatus) => void = () => undefined,
): ShortcutManager {
  /** The accelerator registered right now, or null. */
  let active: string | null = null;
  let current: ShortcutStatus | null = null;

  const report = (status: ShortcutStatus): ShortcutStatus => {
    current = status;
    onStatus(status);
    return status;
  };

  return {
    apply(accelerator) {
      if (active === accelerator && current?.registered) return current;
      const previous = active;
      if (previous !== null) tryUnregister(api, previous);
      active = null;
      if (tryRegister(api, accelerator, onTrigger)) {
        active = accelerator;
        return report({ accelerator, registered: true, message: null });
      }
      // Keep the shortcut that worked before, if there was one.
      const kept = previous !== null && tryRegister(api, previous, onTrigger);
      if (kept) active = previous;
      const message = kept
        ? `${accelerator} could not be set as the shortcut; another app may use it. ${previous} still works.`
        : `${accelerator} could not be set as the shortcut; another app may use it. Choose another in Settings.`;
      return report({ accelerator, registered: false, message, ...(kept ? { activeAccelerator: previous } : {}) });
    },
    status: () => current,
    dispose() {
      if (active !== null) tryUnregister(api, active);
      active = null;
    },
  };
}

export type ShortcutAction = 'show' | 'focus' | 'hide';

/** Pure: what the shortcut does to the widget. Hidden: show and focus. Visible, not focused: focus. Focused: hide. */
export function shortcutAction(widget: { visible: boolean; focused: boolean } | null): ShortcutAction {
  if (!widget?.visible) return 'show';
  return widget.focused ? 'hide' : 'focus';
}
