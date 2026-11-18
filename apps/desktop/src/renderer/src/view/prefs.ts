/**
 * Per-viewer conveniences kept in the renderer's localStorage (main window redesign, WP3): whether an "Explain this
 * screen" note was dismissed, and whether the first-run guide was seen. Nothing here is agent data, and nothing depends
 * on it: storage can be missing or throw (a locked-down profile, a test), and then every read is "not set" and every
 * write is dropped, so the note shows and the guide may show again next start.
 */

/** The two calls this file needs from `Storage` (so tests can pass a fake, or one that throws). */
export interface FlagStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The window's localStorage, or null when there is none or it cannot be reached. */
export function browserStore(): FlagStore | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** True or false when the flag was stored; null when it was not, or storage failed. */
export function readFlag(store: FlagStore | null, key: string): boolean | null {
  if (store === null) return null;
  try {
    const v = store.getItem(key);
    return v === '1' ? true : v === '0' ? false : null;
  } catch {
    return null;
  }
}

/** Store a flag; false when it could not be stored (the choice then lasts until the window closes). */
export function writeFlag(store: FlagStore | null, key: string, value: boolean): boolean {
  if (store === null) return false;
  try {
    store.setItem(key, value ? '1' : '0');
    return true;
  } catch {
    return false;
  }
}

/** The screens with an "Explain this screen" note. */
export type ExplainScreen = 'home' | 'session';

export const EXPLAIN_KEYS: Record<ExplainScreen, string> = {
  home: 'huddle.explain.home.hidden',
  session: 'huddle.explain.session.hidden',
};

/** The note shows until the viewer hides it once; storage that fails shows it. */
export function explainShown(store: FlagStore | null, screen: ExplainScreen): boolean {
  return readFlag(store, EXPLAIN_KEYS[screen]) !== true;
}

/** Remember the viewer's choice (shown or hidden). */
export function setExplainShown(store: FlagStore | null, screen: ExplainScreen, shown: boolean): boolean {
  return writeFlag(store, EXPLAIN_KEYS[screen], !shown);
}

/** Bumped when the guide changes enough to show it again. */
export const GUIDE_KEY = 'huddle.guide.seen.v1';

/**
 * The first-run guide opens by itself once: not while the first-run consent screen has the window, and not after it was
 * seen (Skip or Start). Storage that fails reads as not seen, so it shows; closing it then lasts for this window.
 */
export function shouldShowGuide(store: FlagStore | null, consentShowing: boolean): boolean {
  return !consentShowing && readFlag(store, GUIDE_KEY) !== true;
}

export function markGuideSeen(store: FlagStore | null): boolean {
  return writeFlag(store, GUIDE_KEY, true);
}

/**
 * Simple or Advanced view (owner's request, 2026-11-17). Simple hides implementation detail: raw model ids, token
 * tables, the finer timeline filters, Claude Code's own words. Advanced shows everything. A per-viewer choice like the
 * flags above, so it lives here (localStorage) rather than in the core's settings file: nothing outside the windows
 * reads it, and a missing or failing store reads as the default, Simple.
 */
export type ViewMode = 'simple' | 'advanced';

export const VIEW_MODE_KEY = 'huddle.viewMode';

export function readViewMode(store: FlagStore | null): ViewMode {
  if (store === null) return 'simple';
  try {
    return store.getItem(VIEW_MODE_KEY) === 'advanced' ? 'advanced' : 'simple';
  } catch {
    return 'simple';
  }
}

/** Store the choice; false when it could not be stored (it then lasts until the window closes). */
export function writeViewMode(store: FlagStore | null, mode: ViewMode): boolean {
  if (store === null) return false;
  try {
    store.setItem(VIEW_MODE_KEY, mode);
    return true;
  } catch {
    return false;
  }
}

export const VIEW_MODE_WORDS = {
  simple: 'Simple',
  advanced: 'Advanced',
  group: 'View',
  simpleHint: 'Fewer details: plain names, bars instead of token tables, the main timeline filters',
  advancedHint: 'Every detail: model ids, token tables, every timeline filter, Claude Code terms',
  switchTo: (mode: ViewMode) => (mode === 'simple' ? 'Switch to simple view' : 'Switch to advanced view'),
} as const;
