/**
 * The main window's frame (main window redesign, WP2): the title bar (brand, Search Ctrl+K, live counts), the 56 px
 * icon rail (Home, History, Library, Settings; Guide at the bottom), the sidebar splitter, and the Library view
 * (Templates and Rules as tabs). Words and items come from view/shell.ts. Home is components/Home.tsx, the guide
 * components/Guide.tsx.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import type { HomeCounts, HuddleState } from '@huddle/shared';
import { phoneMark } from '../view/phone.js';
import { ViewModeSwitch } from '../viewMode.js';
import {
  clampSidebarWidth,
  countWords,
  LIBRARY_TABS,
  RAIL_ITEMS,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  splitterKey,
  type LibraryTab,
  type RailPlace,
} from '../view/shell.js';

// --- title bar --------------------------------------------------------------------------------------------------

/**
 * "● 3 working  ▲ 1 needs you  ! 0 stuck": glyph and word, the colour only adds to them. `live`: announce changes
 * (the title bar only, so a screen reader hears each change once, not once per copy on screen).
 */
export function LiveCounts({ counts, live = false }: { counts: HomeCounts | null; live?: boolean }) {
  return (
    <span className="counts" aria-live={live ? 'polite' : undefined}>
      {countWords(counts).map((w) => (
        <span key={w.key} className={`count tone-${w.tone}${w.loud ? ' is-loud' : ''}`}>
          <span className={`glyph tone-${w.tone}`} aria-hidden="true">
            {w.glyph}
          </span>{' '}
          {w.text}
        </span>
      ))}
    </span>
  );
}

/**
 * Phone access (M6, F26): "▮ phone connected" while a paired phone has a live stream, "▯ phone access on" while the
 * listener is up with none connected, nothing while off. Shape and words; colour only adds.
 */
export function PhoneMark({ state, compact = false }: { state: HuddleState | null; compact?: boolean }) {
  const mark = phoneMark(state);
  if (mark === null) return null;
  return (
    <span className={`phone-mark tone-${mark.tone}`} title={mark.title}>
      <span className="glyph" aria-hidden="true">
        {mark.glyph}
      </span>{' '}
      {compact ? (mark.tone === 'working' ? 'phone' : 'phone on') : mark.text}
    </span>
  );
}

export function TitleBar({
  counts,
  onSearch,
  searchable = true,
  state = null,
  viewSwitch = false,
}: {
  counts: HomeCounts | null;
  onSearch: () => void;
  /** Show the Simple / Advanced switch (the main window, not the first-run screen). */
  viewSwitch?: boolean;
  /** False on the first-run screen, where there is nothing to search yet. */
  searchable?: boolean;
  /** For the phone mark (M6). */
  state?: HuddleState | null;
}) {
  return (
    <header className="titlebar">
      <span className="app-mark" aria-hidden="true" />
      <span className="app-title">Huddle</span>
      {searchable && (
        <span className="titlebar-actions titlebar-search">
          <button type="button" className="search-button" aria-keyshortcuts="Control+K" onClick={onSearch}>
            <span>Search runs, agents, or ask…</span> <kbd>Ctrl+K</kbd>
          </button>
        </span>
      )}
      <LiveCounts counts={counts} live />
      <PhoneMark state={state} />
      {viewSwitch && <ViewModeSwitch className="titlebar-view" />}
    </header>
  );
}

// --- rail -------------------------------------------------------------------------------------------------------

/** Stroke icons, decorative (the word under each one names it). */
function RailIcon({ place }: { place: RailPlace }) {
  const common = {
    width: 18,
    height: 18,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    focusable: false,
  };
  switch (place) {
    case 'home':
      return (
        <svg {...common}>
          <path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" />
        </svg>
      );
    case 'history':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
      );
    case 'library':
      return (
        <svg {...common}>
          <rect x="4" y="4" width="16" height="16" rx="2" />
          <path d="M8 9h8M8 13h8M8 17h5" />
        </svg>
      );
    case 'settings':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="3" />
          <path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1L7 17M17 7l2.1-2.1" />
        </svg>
      );
    case 'guide':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.5V14" />
          <path d="M12 17h.01" />
        </svg>
      );
  }
}

/** The rail: one button per place, `aria-current` on the current one; Up/Down move between them. */
export function Rail({ current, onPlace }: { current: RailPlace | null; onPlace: (place: RailPlace) => void }) {
  const refs = useRef(new Map<RailPlace, HTMLButtonElement>());
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    let next: number | null = null;
    if (e.key === 'ArrowDown') next = (i + 1) % RAIL_ITEMS.length;
    else if (e.key === 'ArrowUp') next = (i - 1 + RAIL_ITEMS.length) % RAIL_ITEMS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = RAIL_ITEMS.length - 1;
    if (next === null) return;
    e.preventDefault();
    const item = RAIL_ITEMS[next];
    if (item) refs.current.get(item.place)?.focus();
  };
  const button = (item: (typeof RAIL_ITEMS)[number], i: number): ReactNode => (
    <button
      key={item.place}
      ref={(el) => {
        if (el) refs.current.set(item.place, el);
        else refs.current.delete(item.place);
      }}
      type="button"
      className={`rail-button${current === item.place ? ' is-current' : ''}`}
      aria-current={current === item.place ? 'page' : undefined}
      aria-label={item.title}
      title={item.title}
      onClick={() => {
        onPlace(item.place);
      }}
      onKeyDown={(e) => {
        onKey(e, i);
      }}
    >
      <RailIcon place={item.place} />
      <span className="rail-word" aria-hidden="true">
        {item.label}
      </span>
    </button>
  );
  return (
    <nav className="rail-nav" aria-label="Main">
      {RAIL_ITEMS.map((item, i) => (item.bottom ? null : button(item, i)))}
      <span className="rail-gap" />
      {RAIL_ITEMS.map((item, i) => (item.bottom ? button(item, i) : null))}
    </nav>
  );
}

// --- splitter ---------------------------------------------------------------------------------------------------

/** The width the sidebar is drawn at (the element before the splitter); null when it cannot be measured. */
function drawnWidth(el: HTMLElement | null): number | null {
  const side = el?.previousElementSibling;
  if (!(side instanceof HTMLElement)) return null;
  const w = side.getBoundingClientRect().width;
  return w > 0 ? Math.round(w) : null;
}

/**
 * The sidebar's right edge: drag, or focus it and use Left/Right (Shift for bigger steps), Home, End. Both start from
 * the width as drawn, which on a narrow window is less than the stored one, and `aria-valuenow` says that width.
 */
export function Splitter({ width, onWidth }: { width: number; onWidth: (px: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [drawn, setDrawn] = useState<number | null>(null);
  useEffect(() => {
    const side = ref.current?.previousElementSibling;
    if (!(side instanceof HTMLElement) || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      setDrawn(drawnWidth(ref.current));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(side);
    return () => {
      observer.disconnect();
    };
  }, []);
  const now = () => drawnWidth(ref.current) ?? drawn ?? clampSidebarWidth(width);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (typeof el.setPointerCapture === 'function') el.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = now();
    const move = (ev: globalThis.PointerEvent) => {
      onWidth(clampSidebarWidth(startW + ev.clientX - startX));
    };
    const end = (ev: globalThis.PointerEvent) => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', end);
      el.removeEventListener('pointercancel', end);
      if (typeof el.hasPointerCapture === 'function' && el.hasPointerCapture(ev.pointerId))
        el.releasePointerCapture(ev.pointerId);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = splitterKey(e.key, e.shiftKey, now());
    if (next === null) return;
    e.preventDefault();
    onWidth(next);
  };
  return (
    <div
      ref={ref}
      className="splitter"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the sidebar"
      aria-valuemin={SIDEBAR_MIN}
      aria-valuemax={SIDEBAR_MAX}
      aria-valuenow={drawn ?? clampSidebarWidth(width)}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    />
  );
}

// --- library ----------------------------------------------------------------------------------------------------

/** Library: a text tab row (Templates · Rules) above the chosen panel. Left/Right, Home, End move between tabs. */
export function Library({
  tab,
  onTab,
  children,
}: {
  tab: LibraryTab;
  onTab: (tab: LibraryTab) => void;
  children: ReactNode;
}) {
  const idBase = useId();
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    let next: number | null = null;
    if (e.key === 'ArrowRight') next = (i + 1) % LIBRARY_TABS.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + LIBRARY_TABS.length) % LIBRARY_TABS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = LIBRARY_TABS.length - 1;
    if (next === null) return;
    e.preventDefault();
    const t = LIBRARY_TABS[next];
    if (t === undefined) return;
    onTab(t.id);
    document.getElementById(`${idBase}-tab-${t.id}`)?.focus();
  };
  return (
    <div className="library">
      <div className="hist-tabs library-tabs" role="tablist" aria-label="Library">
        {LIBRARY_TABS.map((t, i) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`${idBase}-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`${idBase}-panel`}
            tabIndex={tab === t.id ? 0 : -1}
            className="tab"
            onClick={() => {
              onTab(t.id);
            }}
            onKeyDown={(e) => {
              onKey(e, i);
            }}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div id={`${idBase}-panel`} role="tabpanel" aria-labelledby={`${idBase}-tab-${tab}`} className="library-panel">
        {children}
      </div>
    </div>
  );
}
