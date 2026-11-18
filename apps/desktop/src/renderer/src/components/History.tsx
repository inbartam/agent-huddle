/**
 * History (M5, F22): the "Runs · Scorecards" view in the detail pane, and the run view's shared head with its
 * "Report · Replay" tabs (DESIGN.md "M5: Remember"). Read-only: nothing here goes to an agent.
 *
 * Runs: a search box (debounced 250 ms, `history.search`), Outcome and Folder selects, day headers and 28 px rows drawn
 * with fixed-height windowing like the timeline, and "Show 200 more" pages. The list state lives in `HistoryPanel`, so
 * opening a run and coming back keeps the rows, and focus goes back to that run's row.
 *
 * Every string from a run (title, topic, folder, prompt snippet) is a text node. A search match is drawn by cutting the
 * plain text at the core's offsets (view/history.ts `splitHighlight`) into text nodes and `<mark>` elements.
 *
 * Replay (U2) is components/Replay.tsx, Report and Scorecards (U3) are components/Report.tsx and Scorecards.tsx; Ask
 * (U4) is a placeholder here.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type UIEvent } from 'react';
import type { AgentKey, HistoryOutcome, HistorySearchHit, QueryResult, RunHead } from '@huddle/shared';
import { loadFolders, loadRuns, openRun, type HeadAnswer } from '../history-query.js';
import { migrationPoll } from '../history-refresh.js';
import type { QueryFn } from '../query.js';
import type { CommandFn } from '../report-query.js';
import { clockTime, clockTimeFull, folderName, UNKNOWN } from '../view/format.js';
import {
  appendPage,
  emptyWords,
  followActive,
  hasFilters,
  historyFailure,
  historyItems,
  HISTORY_WORDS,
  isHistoryOutcome,
  isSearchShortcut,
  listKey,
  matchCount,
  matchLabel,
  matchSegments,
  matchText,
  NO_FILTERS,
  noMatchWords,
  originWords,
  OUTCOME_OPTIONS,
  outcomeLook,
  refreshList,
  retentionFooter,
  runAccessibleName,
  runDuration,
  runFailure,
  runModel,
  runTitle,
  runTokens,
  rowParts,
  searchText,
  startWords,
  type HistoryFilters,
  type HistoryItem,
  type HistoryRequest,
  type HistoryTab,
  type RunsList,
  type RowParts,
  type RunTab,
  type TextSegment,
} from '../view/history.js';
import { useNow } from '../useNow.js';
import { Replay, type ReplayInitial } from './Replay.js';
import { Report, type ReportInitial } from './Report.js';
import { Scorecards, type ScorecardsInitial } from './Scorecards.js';
import { isTextField, useDelayed } from './ui-util.js';

type Failed = Extract<QueryResult, { ok: false }>;

const ROW = 28;
/** A run row with a match line under it (DESIGN "History (F22)", Search): one 28 px line plus a 16 px line. */
const MATCH_ROW = 44;
const OVERSCAN = 8;
/** Rows drawn before the first scroll measurement (and in static render tests). */
const INITIAL_WINDOW = 40;
const SEARCH_DEBOUNCE_MS = 250;
const LOADING_DELAY_MS = 300;

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

export function OutcomeBadge({ outcome }: { outcome: string }) {
  const look = outcomeLook(outcome);
  return (
    <span className={`status hist-outcome tone-${look.tone}`}>
      <span
        className={`glyph${look.breathes ? ' is-working' : ''}`}
        data-status={look.breathes ? 'working' : undefined}
        aria-hidden="true"
      >
        {look.glyph}
      </span>
      <span className="status-label">{look.label}</span>
    </span>
  );
}

/** Plain segments as text nodes, marked ones in `<mark>`; never markup from the core. */
export function Highlighted({ segments }: { segments: readonly TextSegment[] }) {
  return <>{segments.map((s, i) => (s.mark ? <mark key={i}>{s.text}</mark> : <span key={i}>{s.text}</span>))}</>;
}

function Tabs<T extends string>({
  label,
  tabs,
  value,
  onChange,
  idBase,
}: {
  label: string;
  tabs: readonly { id: T; label: string }[];
  value: T;
  onChange: (id: T) => void;
  idBase: string;
}) {
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    let next: number | null = null;
    if (e.key === 'ArrowRight') next = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    if (next === null) return;
    e.preventDefault();
    const t = tabs[next];
    if (t === undefined) return;
    onChange(t.id);
    document.getElementById(`${idBase}-tab-${t.id}`)?.focus();
  };
  return (
    <div className="hist-tabs" role="tablist" aria-label={label}>
      {tabs.map((t, i) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          id={`${idBase}-tab-${t.id}`}
          aria-selected={value === t.id}
          aria-controls={`${idBase}-panel-${t.id}`}
          tabIndex={value === t.id ? 0 : -1}
          className="tab"
          onClick={() => {
            onChange(t.id);
          }}
          onKeyDown={(e) => {
            onKey(e, i);
          }}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

const HISTORY_TABS: readonly { id: HistoryTab; label: string }[] = [
  { id: 'runs', label: HISTORY_WORDS.tabRuns },
  { id: 'scorecards', label: HISTORY_WORDS.tabScorecards },
];
const RUN_TABS: readonly { id: RunTab; label: string }[] = [
  { id: 'report', label: HISTORY_WORDS.tabReport },
  { id: 'replay', label: HISTORY_WORDS.tabReplay },
];

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

/** What tests (and nothing else) hand in instead of asking the core. */
export interface HistoryInitial {
  list?: RunsList;
  listError?: Failed;
  folders?: readonly string[];
  /** The run view's head answer, when `request.run` is set. */
  head?: HeadAnswer;
  /** The Replay tab's first answers. */
  replay?: ReplayInitial;
  /** The Report tab's first answer. */
  report?: ReportInitial;
  /** The Scorecards tab's first answer. */
  scorecards?: ScorecardsInitial;
  /** Text typed in the search box. */
  input?: string;
  active?: number;
}

export interface HistoryPanelProps {
  query: QueryFn | null;
  request: HistoryRequest;
  /** Settings, History; null when the core has not sent settings. */
  retentionDays: number | null;
  /** Clock for day headers; defaults to a minute tick (tests pass a fixed time). */
  now?: number;
  initial?: HistoryInitial;
  /** Replay's "Show live" on a running run: select that session's main agent in the team (closes History). */
  onShowLive?: (key: AgentKey) => void;
  /** The report's commands (make, open the file, copy its path), by session id. Null: this build cannot send them. */
  onCommand?: CommandFn | null;
}

export function HistoryPanel({
  query,
  request,
  retentionDays,
  now: fixedNow,
  initial,
  onShowLive,
  onCommand = null,
}: HistoryPanelProps) {
  const ticking = useNow(60_000);
  const now = fixedNow ?? ticking;
  const [tab, setTab] = useState<HistoryTab>(request.tab);
  const [run, setRun] = useState(request.run);
  const [returnTo, setReturnTo] = useState<string | null>(null);
  const runs = useRuns(query, initial, run === null && tab === 'runs');
  const idBase = useId();

  if (run !== null) {
    return (
      <RunView
        key={run.sessionId}
        query={query}
        sessionId={run.sessionId}
        tab={run.tab}
        startIndex={run.index ?? null}
        now={now}
        initialHead={initial?.head}
        initialReplay={initial?.replay}
        initialReport={initial?.report}
        onShowLive={onShowLive}
        onCommand={onCommand}
        onBack={() => {
          setReturnTo(run.sessionId);
          setTab('runs');
          setRun(null);
        }}
      />
    );
  }

  return (
    <article className="detail history" aria-label="History">
      <header className="detail-head hist-head">
        <div className="name-block">
          <h1 className="visually-hidden">{HISTORY_WORDS.title}</h1>
          <Tabs label="History sections" tabs={HISTORY_TABS} value={tab} onChange={setTab} idBase={idBase} />
        </div>
      </header>
      {tab === 'runs' ? (
        <div
          className="panel hist-panel"
          role="tabpanel"
          id={`${idBase}-panel-runs`}
          aria-labelledby={`${idBase}-tab-runs`}
        >
          <RunsView
            runs={runs}
            now={now}
            retentionDays={retentionDays}
            returnTo={returnTo}
            onReturned={() => {
              setReturnTo(null);
            }}
            onOpen={(sessionId) => {
              setRun({ sessionId, tab: null });
            }}
          />
        </div>
      ) : (
        <div
          className="panel"
          role="tabpanel"
          id={`${idBase}-panel-scorecards`}
          aria-labelledby={`${idBase}-tab-scorecards`}
        >
          <Scorecards query={query} now={now} initial={initial?.scorecards} />
        </div>
      )}
    </article>
  );
}

// ---------------------------------------------------------------------------
// The runs list's state: filters, pages, folders
// ---------------------------------------------------------------------------

interface Runs {
  input: string;
  setInput: (text: string) => void;
  filters: HistoryFilters;
  setOutcome: (o: HistoryOutcome | null) => void;
  setFolder: (f: string | null) => void;
  clearSearch: () => void;
  clearFilters: () => void;
  list: RunsList | null;
  error: Failed | null;
  pending: boolean;
  retry: () => void;
  more: { busy: boolean; error: string | null };
  loadMore: () => void;
  folders: readonly string[];
  active: number;
  setActive: (i: number) => void;
}

/** `shown`: the runs list is on screen (not a run's view, not Scorecards). */
function useRuns(query: QueryFn | null, initial: HistoryInitial | undefined, shown: boolean): Runs {
  const start = initial?.list?.filters ?? NO_FILTERS;
  const [input, setInputRaw] = useState(initial?.input ?? start.text);
  const [filters, setFilters] = useState<HistoryFilters>(start);
  const [list, setList] = useState<RunsList | null>(initial?.list ?? null);
  const [error, setError] = useState<Failed | null>(initial?.listError ?? null);
  const [pending, setPending] = useState(initial === undefined);
  const [reload, setReload] = useState(0);
  const [more, setMore] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const [folders, setFolders] = useState<readonly string[]>(initial?.folders ?? []);
  const [active, setActive] = useState(initial?.active ?? 0);
  const seq = useRef(0);
  const skipFirst = useRef(initial !== undefined);

  // The search text reaches the query 250 ms after the last key.
  useEffect(() => {
    if (input === filters.text) return;
    const t = setTimeout(() => {
      setFilters((f) => ({ ...f, text: input }));
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(t);
    };
  }, [input, filters.text]);

  const { text, outcome, folder } = filters;
  useEffect(() => {
    if (skipFirst.current) {
      skipFirst.current = false;
      return;
    }
    const n = ++seq.current;
    const asked: HistoryFilters = { text, outcome, folder };
    setPending(true);
    setMore({ busy: false, error: null });
    void loadRuns(query, asked).then((a) => {
      if (n !== seq.current) return; // a newer question is on its way
      setPending(false);
      if (a.ok) {
        setList({ filters: asked, hits: a.hits, total: a.total, next: a.next, migrating: a.migrating });
        setError(null);
        setActive(0);
      } else {
        setError(a);
      }
    });
  }, [query, text, outcome, folder, reload]);

  useEffect(() => {
    if (initial?.folders !== undefined) return;
    void loadFolders(query).then((a) => {
      if (a.ok) setFolders(a.folders);
    });
  }, [query, initial?.folders]);

  // While older history is still coming in, ask again every 2 s (and once on focus, or when the list is shown again)
  // so the list shows what has arrived. The search box, scroll position and selected run stay as they are.
  const listRef = useRef(list);
  listRef.current = list;
  const activeRef = useRef(active);
  activeRef.current = active;
  const wasShown = useRef(shown);
  const migrating = list?.migrating === true && !pending;
  const migratingFilters = list?.filters;
  useEffect(() => {
    const cameBack = shown && !wasShown.current;
    wasShown.current = shown;
    if (!migrating || !shown || migratingFilters === undefined) return;
    const n = seq.current;
    const poll = migrationPoll({
      load: () => loadRuns(query, migratingFilters),
      onAnswer: (a) => {
        const cur = listRef.current;
        if (n !== seq.current || cur === null) return; // the filters changed since; that answer wins
        const next = refreshList(cur, a);
        setActive(followActive(cur.hits, next.hits, activeRef.current));
        setList(next);
      },
    });
    poll.start(cameBack);
    const onFocus = () => {
      poll.poke();
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') poll.poke();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
      poll.stop();
    };
  }, [query, migrating, migratingFilters, shown]);

  const loadMore = () => {
    if (list === null || list.next === null || more.busy) return;
    const n = seq.current;
    const base = list;
    setMore({ busy: true, error: null });
    void loadRuns(query, base.filters, list.next).then((a) => {
      if (n !== seq.current) return;
      if (a.ok) {
        setList((cur) => (cur === null ? cur : appendPage(cur, a)));
        setMore({ busy: false, error: null });
      } else {
        setMore({ busy: false, error: historyFailure(a) });
      }
    });
  };

  return {
    input,
    setInput: setInputRaw,
    filters,
    setOutcome: (o) => {
      setFilters((f) => ({ ...f, outcome: o }));
    },
    setFolder: (fo) => {
      setFilters((f) => ({ ...f, folder: fo }));
    },
    clearSearch: () => {
      setInputRaw('');
      setFilters((f) => ({ ...f, text: '' }));
    },
    clearFilters: () => {
      setFilters((f) => ({ ...f, outcome: null, folder: null }));
    },
    list,
    error,
    pending,
    retry: () => {
      setError(null);
      setReload((r) => r + 1);
    },
    more,
    loadMore,
    folders,
    active,
    setActive,
  };
}

// ---------------------------------------------------------------------------
// The runs list
// ---------------------------------------------------------------------------

/** Folder options: the last segment, or the full path when two folders share a name. */
function folderOptions(folders: readonly string[]): { value: string; label: string }[] {
  const counts = new Map<string, number>();
  for (const f of folders) counts.set(folderName(f), (counts.get(folderName(f)) ?? 0) + 1);
  return folders.map((f) => ({ value: f, label: (counts.get(folderName(f)) ?? 0) > 1 ? f : folderName(f) }));
}

function RunsView({
  runs,
  now,
  retentionDays,
  returnTo,
  onReturned,
  onOpen,
}: {
  runs: Runs;
  now: number;
  retentionDays: number | null;
  returnTo: string | null;
  onReturned: () => void;
  onOpen: (sessionId: string) => void;
}) {
  const search = useRef<HTMLInputElement>(null);
  const listEl = useRef<HTMLDivElement>(null);
  const listId = useId();
  const [view, setView] = useState({ top: 0, height: INITIAL_WINDOW * ROW });
  const { list, error, filters } = runs;
  const hits = useMemo(() => list?.hits ?? [], [list]);
  const items = useMemo(() => historyItems(hits, now), [hits, now]);
  const layout = useMemo(() => listLayout(items), [items]);
  const { runPos, tops } = layout;
  const showLoading = useDelayed(runs.pending, LOADING_DELAY_MS);

  /** Scroll so run `index` (and its day header, for the first row of a day) is in view. */
  const reveal = useCallback(
    (index: number) => {
      const el = listEl.current;
      const pos = runPos[index];
      if (el === null || pos === undefined) return;
      const top = tops[pos > 0 && items[pos - 1]?.kind === 'day' ? pos - 1 : pos] ?? 0;
      const bottom = tops[pos + 1] ?? 0;
      if (top < el.scrollTop) el.scrollTop = top;
      else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
    },
    [runPos, tops, items],
  );

  // Ctrl+F, or `/` outside a text field, focuses the search.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!isSearchShortcut(e, isTextField(e.target))) return;
      e.preventDefault();
      search.current?.focus();
      search.current?.select();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  // Back from a run: focus that run's row again.
  const { setActive } = runs;
  useEffect(() => {
    if (returnTo === null) return;
    const index = hits.findIndex((h) => h.row.sessionId === returnTo);
    if (index >= 0) {
      setActive(index);
      reveal(index);
      listEl.current?.focus();
    } else {
      search.current?.focus();
    }
    onReturned();
  }, [returnTo, hits, reveal, setActive, onReturned]);

  const active = Math.min(runs.active, Math.max(0, hits.length - 1));
  const activeHit = hits[active];

  const onListKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const pageSize = Math.max(1, Math.floor((listEl.current?.clientHeight ?? 10 * ROW) / ROW) - 1);
    const r = listKey(e.key, active, hits.length, pageSize);
    if (r.kind === 'none') return;
    e.preventDefault();
    if (r.kind === 'search') search.current?.focus();
    else if (r.kind === 'move') {
      runs.setActive(r.index);
      reveal(r.index);
    } else {
      const hit = hits[r.index];
      if (hit) onOpen(hit.row.sessionId);
    }
  };

  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape' && runs.input !== '') {
      e.preventDefault();
      runs.clearSearch();
    } else if (e.key === 'ArrowDown' && hits.length > 0) {
      e.preventDefault();
      reveal(active);
      listEl.current?.focus();
    }
  };

  const onScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    setView({ top: el.scrollTop, height: el.clientHeight });
  };

  const first = Math.max(0, itemAt(tops, view.top) - OVERSCAN);
  const last = Math.min(items.length, itemAt(tops, view.top + view.height) + 1 + OVERSCAN);
  const shownText = list ? searchText(list.filters) : '';
  const filtersOn = hasFilters(filters);
  const optionId = (index: number) => `${listId}-run-${String(index)}`;

  return (
    <section className="hist-runs" aria-label="Runs">
      <div className="hist-toolbar" role="search">
        <label className="visually-hidden" htmlFor={`${listId}-search`}>
          {HISTORY_WORDS.searchLabel}
        </label>
        <input
          ref={search}
          id={`${listId}-search`}
          className="text-input hist-search"
          type="search"
          placeholder={`${HISTORY_WORDS.searchPlaceholder}…`}
          aria-keyshortcuts="Control+F /"
          autoComplete="off"
          spellCheck={false}
          value={runs.input}
          onChange={(e) => {
            runs.setInput(e.target.value);
          }}
          onKeyDown={onSearchKey}
        />
        <label className="hist-filter">
          <span>{HISTORY_WORDS.outcome}</span>
          <select
            className="text-input select-input"
            value={filters.outcome ?? ''}
            onChange={(e) => {
              const v = e.target.value;
              runs.setOutcome(isHistoryOutcome(v) ? v : null);
            }}
          >
            <option value="">{HISTORY_WORDS.all}</option>
            {OUTCOME_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="hist-filter">
          <span>{HISTORY_WORDS.folder}</span>
          <select
            className="text-input select-input hist-folder"
            value={filters.folder ?? ''}
            title={filters.folder ?? undefined}
            onChange={(e) => {
              runs.setFolder(e.target.value === '' ? null : e.target.value);
            }}
          >
            <option value="">{HISTORY_WORDS.all}</option>
            {folderOptions(runs.folders).map((o) => (
              <option key={o.value} value={o.value} title={o.value}>
                {o.label}
              </option>
            ))}
            {filters.folder !== null && !runs.folders.includes(filters.folder) && (
              <option value={filters.folder}>{folderName(filters.folder)}</option>
            )}
          </select>
        </label>
        {filtersOn && (
          <button type="button" className="quiet-button" onClick={runs.clearFilters}>
            {HISTORY_WORDS.clearFilters}
          </button>
        )}
      </div>

      <div className="hist-status" aria-live="polite">
        {showLoading && <p className="muted hist-line">{HISTORY_WORDS.loading}</p>}
        {list?.migrating === true && <p className="muted hist-line">{HISTORY_WORDS.migrating}</p>}
        {/* With no hit, the no-match message below says it once; the count would repeat it. */}
        {list !== null && error === null && shownText !== '' && hits.length > 0 && (
          <p className="muted hist-line">{matchCount(list.total)}</p>
        )}
      </div>

      {error !== null ? (
        <div className="hist-message">
          <p
            className={error.code === 'not_available' || error.code === 'unsupported' ? 'empty-line' : 'inline-error'}
            role="alert"
          >
            {historyFailure(error)}
          </p>
          {error.code !== 'not_available' && error.code !== 'unsupported' && (
            <button type="button" className="quiet-button" onClick={runs.retry}>
              {HISTORY_WORDS.tryAgain}
            </button>
          )}
        </div>
      ) : list !== null && hits.length === 0 ? (
        <div className="hist-message">
          {shownText !== '' ? (
            <>
              <p className="empty-line">{noMatchWords(shownText)}</p>
              <button type="button" className="quiet-button" onClick={runs.clearSearch}>
                {HISTORY_WORDS.clearSearch}
              </button>
            </>
          ) : hasFilters(list.filters) ? (
            <>
              <p className="empty-line">{HISTORY_WORDS.noFilterMatch}</p>
              <button type="button" className="quiet-button" onClick={runs.clearFilters}>
                {HISTORY_WORDS.clearFilters}
              </button>
            </>
          ) : (
            <p className="empty-line">{emptyWords(retentionDays)}</p>
          )}
        </div>
      ) : list !== null ? (
        <>
          <RunColumns />
          <div
            ref={listEl}
            className="hist-scroll"
            role="listbox"
            aria-label="Runs, newest first"
            tabIndex={0}
            aria-activedescendant={activeHit ? optionId(active) : undefined}
            onKeyDown={onListKey}
            onScroll={onScroll}
          >
            <div className="hist-spacer" role="presentation" style={{ height: layout.total }}>
              <div role="presentation" style={{ transform: `translateY(${String(tops[first] ?? 0)}px)` }}>
                {items.slice(first, last).map((it) =>
                  it.kind === 'day' ? (
                    <div key={it.key} className="hist-day" role="presentation" aria-hidden="true">
                      {it.label}
                    </div>
                  ) : (
                    <RunRow
                      key={it.key}
                      id={optionId(it.index)}
                      hit={it.hit}
                      parts={layout.parts[it.index] ?? rowParts(it.hit)}
                      day={it.day}
                      index={it.index}
                      setSize={hits.length}
                      active={it.index === active}
                      now={now}
                      onOpen={() => {
                        runs.setActive(it.index);
                        onOpen(it.hit.row.sessionId);
                      }}
                    />
                  ),
                )}
              </div>
            </div>
          </div>
        </>
      ) : null}

      {list !== null && list.next !== null && error === null && (
        <div className="hist-more">
          <button type="button" className="quiet-button" onClick={runs.loadMore} disabled={runs.more.busy}>
            {runs.more.busy ? HISTORY_WORDS.loading : HISTORY_WORDS.showMore}
          </button>
          {runs.more.error !== null && (
            <span className="inline-error" role="alert">
              {runs.more.error}
            </span>
          )}
        </div>
      )}

      <p className="hist-foot muted">{retentionFooter(retentionDays)}</p>
    </section>
  );
}

/** Where each list item starts (day headers and plain rows 28 px, a row with a match line 44 px), and each row's parts. */
interface ListLayout {
  /** `tops[i]` is item i's offset; `tops[items.length]` is the total height. */
  tops: number[];
  total: number;
  /** Item position of run `index`. */
  runPos: number[];
  /** Cells and match line of run `index`. */
  parts: RowParts[];
}

function listLayout(items: readonly HistoryItem[]): ListLayout {
  const tops: number[] = [];
  const runPos: number[] = [];
  const parts: RowParts[] = [];
  let y = 0;
  items.forEach((it, i) => {
    tops.push(y);
    if (it.kind === 'run') {
      const p = rowParts(it.hit);
      parts[it.index] = p;
      runPos[it.index] = i;
      y += p.line !== null ? MATCH_ROW : ROW;
    } else {
      y += ROW;
    }
  });
  tops.push(y);
  return { tops, total: y, runPos, parts };
}

/** The item at offset `y`: the last one whose top is at or above it. */
function itemAt(tops: readonly number[], y: number): number {
  let lo = 0;
  let hi = Math.max(0, tops.length - 2);
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((tops[mid] ?? 0) <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * The column names over the run rows, so "1.2M" and "3" say what they count. Sighted readers only: each row's
 * accessible name already says it in words (`runAccessibleName`). Same classes as the cells, so the narrow-window
 * rules hide a column's name with its cells.
 */
function RunColumns() {
  return (
    <div className="hist-row hist-columns" aria-hidden="true">
      <span className="hc-outcome">Outcome</span>
      <span className="hc-title">Run</span>
      <span className="hc-folder">Folder</span>
      <span className="hc-start">Start</span>
      <span className="hc-duration">Took</span>
      <span className="hc-model">Model</span>
      <span className="hc-tokens">Tokens</span>
      <span className="hc-agents">Agents</span>
    </div>
  );
}

function RunRow({
  id,
  hit,
  parts,
  day,
  index,
  setSize,
  active,
  onOpen,
  now,
}: {
  now: number;
  id: string;
  hit: HistorySearchHit;
  parts: RowParts;
  day: string;
  index: number;
  setSize: number;
  active: boolean;
  onOpen: () => void;
}) {
  const r = hit.row;
  const t = runTitle(r);
  const tokens = runTokens(r.tokens);
  const look = outcomeLook(r.outcome);
  return (
    <div
      id={id}
      role="option"
      aria-selected={active}
      aria-posinset={index + 1}
      aria-setsize={setSize}
      aria-label={runAccessibleName(hit, day)}
      className={`hist-row${active ? ' is-active' : ''}${parts.line ? ' has-match' : ''}`}
      onClick={onOpen}
    >
      <span className="hc-outcome" title={look.label}>
        <OutcomeBadge outcome={r.outcome} />
      </span>
      <span className="hc-title" title={[t.title, t.topic].filter((x) => x !== null).join(' ')}>
        <span className="hc-title-text">
          <Highlighted segments={parts.title} />
        </span>
        {parts.topic !== null && (
          <span className="hc-topic">
            <Highlighted segments={parts.topic} />
          </span>
        )}
      </span>
      <span className="hc-folder code" title={r.folder ?? undefined}>
        <Highlighted segments={parts.folder} />
      </span>
      <span className="hc-start" title={clockTimeFull(r.startTs)}>
        {clockTime(r.startTs)}
      </span>
      <span className="hc-duration">{runDuration(r, now)}</span>
      <span className="hc-model" title={r.model ?? undefined}>
        {runModel(r)}
      </span>
      <span className="hc-tokens" title={tokens.label}>
        {tokens.text}
      </span>
      <span className="hc-agents" title={`${String(r.agentCount)} ${r.agentCount === 1 ? 'agent' : 'agents'}`}>
        {String(r.agentCount)}
      </span>
      {parts.line && (
        <span className="hc-match" title={matchText(parts.line)}>
          {matchLabel(parts.line.field)}: <Highlighted segments={matchSegments(parts.line)} />
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The run view: shared head, Report and Replay tabs
// ---------------------------------------------------------------------------

export function RunView({
  query,
  sessionId,
  tab: askedTab,
  startIndex = null,
  now,
  onBack,
  initialHead,
  initialReplay,
  initialReport,
  onShowLive,
  onCommand = null,
}: {
  query: QueryFn | null;
  sessionId: string;
  tab: RunTab | null;
  /** Open Replay at this event ("Show in replay"); null opens it at the last event. */
  startIndex?: number | null;
  now: number;
  onBack: () => void;
  initialHead?: HeadAnswer;
  initialReplay?: ReplayInitial;
  initialReport?: ReportInitial;
  /** Replay's "Show live" on a running run: select its main agent in the team and close History. */
  onShowLive?: (key: AgentKey) => void;
  /** The report's commands, by session id. */
  onCommand?: CommandFn | null;
}) {
  const [head, setHead] = useState<HeadAnswer | null>(initialHead ?? null);
  const [tab, setTab] = useState<RunTab | null>(askedTab ?? (startIndex !== null ? 'replay' : null));
  // Where Replay opens. `n` remounts it, so a second "Show in replay" moves it again.
  const [replayAt, setReplayAt] = useState<{ index: number | null; n: number }>({ index: startIndex, n: 0 });
  const showInReplay = useCallback((index: number | null) => {
    setReplayAt((prev) => ({ index, n: prev.n + 1 }));
    setTab('replay');
  }, []);
  const back = useRef<HTMLButtonElement>(null);
  const idBase = useId();
  const showLoading = useDelayed(head === null, LOADING_DELAY_MS);

  useEffect(() => {
    if (initialHead !== undefined) return;
    let live = true;
    void openRun(query, sessionId).then((a) => {
      if (live) setHead(a);
    });
    return () => {
      live = false;
    };
  }, [query, sessionId, initialHead]);

  // Replay's "Load newer events": ask for the head again; the old one stays until the new one is here.
  const reloadHead = useCallback(() => {
    void openRun(query, sessionId).then((a) => {
      if (a.ok) setHead(a);
    });
  }, [query, sessionId]);

  useEffect(() => {
    back.current?.focus();
  }, []);

  // Alt+Left goes back, like "← All runs".
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.altKey && !e.ctrlKey && e.key === 'ArrowLeft') {
        e.preventDefault();
        onBack();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [onBack]);

  const ready: RunHead | null = head?.ok ? head.head : null;
  const shown: RunTab = tab ?? (ready?.hasReport ? 'report' : 'replay');
  const title = ready ? runTitle(ready.row) : null;

  return (
    <article className="detail history run-view" aria-label={title ? `Run ${title.title}` : 'Run'}>
      <header className="detail-head run-head">
        <div className="run-head-top">
          <button ref={back} type="button" className="quiet-button" onClick={onBack} aria-keyshortcuts="Alt+ArrowLeft">
            {HISTORY_WORDS.allRuns}
          </button>
          {ready && <Tabs label="Run sections" tabs={RUN_TABS} value={shown} onChange={setTab} idBase={idBase} />}
        </div>
        {ready && title && (
          <>
            <h1 className="agent-name">{title.title}</h1>
            <p className="identity-line">
              <span className="code identity-path" title={ready.row.folder ?? undefined}>
                {ready.row.folder ?? UNKNOWN}
              </span>
              <span className="sep" aria-hidden="true">
                ·
              </span>
              <span title={clockTimeFull(ready.row.startTs)}>{startWords(ready.row.startTs, now)}</span>
              <span className="sep" aria-hidden="true">
                ·
              </span>
              {ready.row.outcome !== 'running' && (
                <>
                  <span>{runDuration(ready.row)}</span>
                  <span className="sep" aria-hidden="true">
                    ·
                  </span>
                </>
              )}
              <OutcomeBadge outcome={ready.row.outcome} />
              <span className="sep" aria-hidden="true">
                ·
              </span>
              <span>{originWords(ready.row.origin)}</span>
            </p>
            {title.topic !== null && (
              <p className="topic-line" title={title.topic}>
                {title.topic}
              </p>
            )}
          </>
        )}
      </header>
      {head === null ? (
        <div className="panel">{showLoading && <p className="muted">{HISTORY_WORDS.openingRun}</p>}</div>
      ) : !head.ok ? (
        <div className="panel">
          <p className={head.code === 'failed' ? 'inline-error' : 'empty-line'} role="alert">
            {runFailure(head)}
          </p>
        </div>
      ) : (
        <div
          className="panel"
          role="tabpanel"
          id={`${idBase}-panel-${shown}`}
          aria-labelledby={`${idBase}-tab-${shown}`}
        >
          {shown === 'report' ? (
            <Report
              query={query}
              onCommand={onCommand}
              head={head.head}
              onShowInReplay={showInReplay}
              initial={initialReport}
            />
          ) : (
            <Replay
              key={replayAt.n}
              query={query}
              head={head.head}
              startIndex={replayAt.index}
              onShowLive={onShowLive}
              onLoadNewer={reloadHead}
              initial={initialReplay}
            />
          )}
        </div>
      )}
    </article>
  );
}
