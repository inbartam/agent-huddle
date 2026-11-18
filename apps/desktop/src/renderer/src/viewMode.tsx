/**
 * The Simple / Advanced view preference (view/prefs.ts) as React state shared by one window: a provider at the
 * window's root reads the stored choice (default Simple) and follows changes made in another window (the `storage`
 * event). Components read it with `useViewMode()`. Outside a provider (component tests, the widget) it reads
 * Advanced, so a component drawn on its own shows everything it can.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  browserStore,
  readViewMode,
  VIEW_MODE_KEY,
  VIEW_MODE_WORDS as W,
  writeViewMode,
  type FlagStore,
  type ViewMode,
} from './view/prefs.js';

export interface ViewModeValue {
  mode: ViewMode;
  simple: boolean;
  setMode: (mode: ViewMode) => void;
}

const ADVANCED: ViewModeValue = { mode: 'advanced', simple: false, setMode: () => undefined };

const ViewModeContext = createContext<ViewModeValue>(ADVANCED);

export function useViewMode(): ViewModeValue {
  return useContext(ViewModeContext);
}

export function ViewModeProvider({
  children,
  store = browserStore(),
  initial,
}: {
  children: ReactNode;
  /** Tests: a fake store (null: storage unavailable). */
  store?: FlagStore | null;
  /** Tests: start in this mode instead of the stored one. */
  initial?: ViewMode;
}) {
  const [mode, setState] = useState<ViewMode>(() => initial ?? readViewMode(store));
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onStorage = (e: StorageEvent) => {
      if (e.key === VIEW_MODE_KEY) setState(readViewMode(store));
    };
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('storage', onStorage);
    };
  }, [store]);
  const setMode = useCallback(
    (next: ViewMode) => {
      setState(next);
      writeViewMode(store, next);
    },
    [store],
  );
  const value = useMemo(() => ({ mode, simple: mode === 'simple', setMode }), [mode, setMode]);
  return <ViewModeContext.Provider value={value}>{children}</ViewModeContext.Provider>;
}

/** Two buttons, "Simple" and "Advanced", the current one pressed. */
export function ViewModeSwitch({ className = '' }: { className?: string }) {
  const { mode, setMode } = useViewMode();
  return (
    <span className={`view-switch segmented ${className}`.trim()} role="group" aria-label={W.group}>
      {(['simple', 'advanced'] as const).map((m) => (
        <button
          key={m}
          type="button"
          className="segment"
          aria-pressed={mode === m}
          title={m === 'simple' ? W.simpleHint : W.advancedHint}
          onClick={() => {
            setMode(m);
          }}
        >
          {W[m]}
        </button>
      ))}
    </span>
  );
}
