/**
 * The widget collapsed to one line (Widget v2). The choice is a user setting (`UserSettings.widgetCollapsed`), owned
 * and saved by the core through `settings.update`, so it survives a restart. The renderer applies a click at once
 * (optimistic) and then follows the saved value when the state arrives. Pure.
 */
import type { ConnectionStatus, HuddleCommand, HuddleState } from '@huddle/shared';

/** The saved choice; false until the settings arrive (and for a settings file written before the field existed). */
export function savedCollapsed(state: HuddleState | null): boolean {
  return state?.settings?.widgetCollapsed ?? false;
}

/** What to show: a click not yet confirmed wins over the saved value. */
export function shownCollapsed(saved: boolean, pending: boolean | null): boolean {
  return pending ?? saved;
}

/** The command that saves the choice. */
export function collapseCommand(collapsed: boolean): HuddleCommand {
  return { type: 'settings.update', patch: { widgetCollapsed: collapsed } };
}

export const COLLAPSE_HINT = 'Collapse to one line';
export const EXPAND_HINT = 'Expand';

/** A short word for the one-line widget when Huddle is not connected, so a broken connection stays visible. */
export function connectionWord(connection: ConnectionStatus | undefined): { word: string; tone: string } | null {
  if (connection === undefined || connection.status === 'attached') return null;
  switch (connection.status) {
    case 'needs_consent':
      return { word: 'not connected', tone: 'needs-you' };
    case 'port_in_use':
      return { word: 'port in use', tone: 'failed' };
    case 'error':
      return { word: 'connection error', tone: 'failed' };
  }
}
