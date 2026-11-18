/**
 * "ⓘ Explain this screen" (main window redesign, WP3): a toggle and a short note under the screen's head. In the
 * Simple view it starts hidden and shows when asked for; in Advanced it shows until the viewer hides it once, and that
 * choice is remembered per viewer (view/prefs.ts; storage that fails just forgets). The note never covers content: it sits in the flow and pushes the rest down.
 */
import { useState, type ReactNode } from 'react';
import { useViewMode } from '../viewMode.js';
import { browserStore, explainShown, setExplainShown, type ExplainScreen, type FlagStore } from '../view/prefs.js';

export interface Explain {
  shown: boolean;
  toggle: () => void;
}

export function useExplain(screen: ExplainScreen, store: FlagStore | null = browserStore()): Explain {
  // The Simple view shows no explanatory banner until asked for (owner review 2026-11-17).
  // The Simple view shows it only when asked for there, also when the view switched to Simple while the screen was open
  // (the Advanced choice is not carried over); asking in Simple is not remembered.
  const { simple } = useViewMode();
  const [shown, setShown] = useState(() => explainShown(store, screen));
  const [asked, setAsked] = useState(false);
  return {
    shown: simple ? asked : shown,
    toggle: () => {
      if (simple) {
        setAsked(!asked);
        return;
      }
      const next = !shown;
      setShown(next);
      setExplainShown(store, screen, next);
    },
  };
}

export function ExplainButton({ explain, controls }: { explain: Explain; controls: string }) {
  return (
    <button
      type="button"
      className="control control-quiet explain-button"
      aria-pressed={explain.shown}
      aria-controls={controls}
      title={explain.shown ? 'Hide the explanation' : 'Show what this screen is for'}
      onClick={explain.toggle}
    >
      <span aria-hidden="true">ⓘ</span>
      <span className="visually-hidden">Explain this screen</span>
    </button>
  );
}

export function ExplainNote({ id, shown, children }: { id: string; shown: boolean; children: ReactNode }) {
  if (!shown) return <div id={id} hidden />;
  return (
    <div id={id} className="explain-note" role="note">
      <span aria-hidden="true">ⓘ</span>
      <div>{children}</div>
    </div>
  );
}
