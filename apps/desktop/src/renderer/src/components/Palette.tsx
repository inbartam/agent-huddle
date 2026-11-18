/**
 * The command palette (F15, Ctrl+K in the main window). A dialog with a search field (combobox) and a list of
 * actions (listbox). Up and Down move, Enter runs, Escape closes and gives focus back. Disabled actions stay in the
 * list with their reason. Matching and keys are pure (view/palette.ts).
 *
 * The top request is taken once, when the palette mounts (it mounts on every open), so allow and deny act on the
 * request the user saw. From the keyboard they run only after the user typed or moved with a key; a click counts too.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { AgentKey, HuddleState } from '@huddle/shared';
import { paletteActions, paletteKey, paletteList, paletteOpened, type PaletteAction } from '../view/palette.js';
import type { ViewMode } from '../view/prefs.js';

export interface PaletteProps {
  state: HuddleState;
  renames: ReadonlyMap<AgentKey, string>;
  /** The current view, so the palette offers the other one; null: no view switch. */
  viewMode?: ViewMode | null;
  onRun: (action: PaletteAction) => void;
  onClose: () => void;
  /** Start with this text (tests). */
  initialQuery?: string;
}

export function Palette({ state, renames, viewMode = null, onRun, onClose, initialQuery = '' }: PaletteProps) {
  const [query, setQuery] = useState(initialQuery);
  const [index, setIndex] = useState(0);
  const [blocked, setBlocked] = useState<string | null>(null);
  /** Set once the user moved the selection with a key (typing counts through `query`). */
  const [moved, setMoved] = useState(false);
  const [opened] = useState(() => paletteOpened(state));
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const all = useMemo(() => paletteActions(state, renames, opened, viewMode), [state, renames, opened, viewMode]);
  const list = useMemo(() => paletteList(all, query), [all, query]);
  const active = list[Math.min(index, Math.max(0, list.length - 1))];
  const optionId = (a: PaletteAction) => `${listId}-${String(list.indexOf(a))}`;

  useEffect(() => {
    input.current?.focus();
  }, []);
  // Only when the highlighted option changes: a state refresh re-renders the palette and must not undo the user's scroll.
  const activeId = active === undefined ? null : optionId(active);
  useEffect(() => {
    if (activeId !== null) document.getElementById(activeId)?.scrollIntoView({ block: 'nearest' });
  }, [activeId]);

  const run = (a: PaletteAction) => {
    if (!a.control.enabled) {
      setBlocked(a.control.reason);
      return;
    }
    onRun(a);
  };

  return (
    <div
      className="palette-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <input
          ref={input}
          className="text-input palette-input"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={active ? optionId(active) : undefined}
          placeholder="Type an action or an agent's name"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
            setBlocked(null);
          }}
          onKeyDown={(e) => {
            const r = paletteKey(e.key, index, list, moved || query.trim() !== '');
            if (r.kind === 'none') return;
            e.preventDefault();
            if (r.kind === 'close') onClose();
            else if (r.kind === 'move') {
              setIndex(r.index);
              setMoved(true);
              setBlocked(null);
            } else if (r.kind === 'run') run(r.action);
            else setBlocked(r.reason);
          }}
        />
        <ul className="palette-list" role="listbox" id={listId} aria-label="Actions">
          {list.length === 0 && <li className="palette-empty">Nothing matches.</li>}
          {list.map((a, i) => {
            const off = !a.control.enabled;
            return (
              <li
                key={a.id}
                id={optionId(a)}
                role="option"
                aria-selected={a === active}
                aria-disabled={off ? true : undefined}
                className={`palette-row${a === active ? ' is-active' : ''}${off ? ' is-off' : ''}`}
                title={off ? (a.control.reason ?? undefined) : undefined}
                onMouseMove={() => {
                  if (i !== index) setIndex(i);
                }}
                onClick={() => {
                  run(a);
                }}
              >
                <span className="palette-label">{a.label}</span>
                <span className="palette-hint">{off ? a.control.reason : a.hint}</span>
              </li>
            );
          })}
        </ul>
        {blocked && (
          <p className="palette-blocked" role="status">
            {blocked}
          </p>
        )}
        <p className="palette-keys" aria-hidden="true">
          ↑ ↓ to move, Enter to run, Esc to close
        </p>
      </div>
    </div>
  );
}
