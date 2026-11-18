/**
 * Small DOM and timing helpers the History and Replay views share.
 */
import { useEffect, useState } from 'react';

/** True once `on` has stayed true for `ms` (a loading line or a muted state does not flash). */
export function useDelayed(on: boolean, ms: number, initial = false): boolean {
  const [shown, setShown] = useState(initial);
  useEffect(() => {
    if (!on) {
      setShown(false);
      return;
    }
    const t = setTimeout(() => {
      setShown(true);
    }, ms);
    return () => {
      clearTimeout(t);
    };
  }, [on, ms]);
  return on && shown;
}

const NOT_TEXT_INPUTS: ReadonlySet<string> = new Set(['checkbox', 'radio', 'button', 'submit', 'range']);

/** A field where a typed letter is text (or a select's type-ahead), so single-key shortcuts stay off. */
export function isTextField(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  return el instanceof HTMLInputElement && !NOT_TEXT_INPUTS.has(el.type);
}
