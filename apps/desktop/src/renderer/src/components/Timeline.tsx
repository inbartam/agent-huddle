/**
 * Activity timeline (F8). 28 px rows: time | tool | one-line summary | duration, newest first.
 * Up to 500 rows, drawn with simple fixed-height windowing (no library): only the rows in view
 * plus a small overscan are in the DOM. A row whose text does not fit on its line (a long reply, a
 * multi-line prompt) opens in the reader below the list: click it, or focus it and press Enter.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type UIEvent } from 'react';
import { clockTime, clockTimeFull, duration } from '../view/format.js';
import {
  effectiveFilter,
  filterTimeline,
  hasMore,
  visibleFilters,
  withoutFlags,
  type TimelineFilter,
  type TimelineRow,
} from '../view/timeline.js';
import { MessageText } from './MessageText.js';

const ROW = 28;
const OVERSCAN = 8;
/** Rows drawn before the first scroll measurement (and in static render tests). */
const INITIAL_WINDOW = 40;

export interface TimelineProps {
  rows: readonly TimelineRow[];
  filter: TimelineFilter;
  onFilter: (filter: TimelineFilter) => void;
  loading: boolean;
  /** The Simple view: All, Failures and Approvals only, commands without their flags, no durations. */
  simple?: boolean;
}

export function Timeline({ rows, filter: chosen, onFilter, loading, simple = false }: TimelineProps) {
  const filter = effectiveFilter(chosen, simple);
  const shown = filterTimeline(rows, filter);
  const [view, setView] = useState({ top: 0, height: INITIAL_WINDOW * ROW });
  const [openId, setOpenId] = useState<string | null>(null);
  // The open row closes by itself when it leaves the list (another filter, another agent).
  const open = openId === null ? undefined : shown.find((r) => r.id === openId);
  const toggle = (r: TimelineRow) => {
    setOpenId((cur) => (cur === r.id ? null : r.id));
  };
  // Wherever the list sits on the page, the reader that just opened is brought into view.
  const reader = useRef<HTMLElement>(null);
  const openedId = open?.id ?? null;
  useEffect(() => {
    if (openedId !== null) reader.current?.scrollIntoView({ block: 'nearest' });
  }, [openedId]);

  const onScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    setView({ top: el.scrollTop, height: el.clientHeight });
  };

  const first = Math.max(0, Math.floor(view.top / ROW) - OVERSCAN);
  const last = Math.min(shown.length, Math.ceil((view.top + view.height) / ROW) + OVERSCAN);
  const windowRows = shown.slice(first, last);

  return (
    <section className="timeline" aria-label="Timeline">
      <div className="filters" role="toolbar" aria-label="Filter timeline by kind">
        {visibleFilters(rows, filter, simple).map((f) => (
          <button
            key={f.id}
            type="button"
            className="filter"
            aria-pressed={filter === f.id}
            onClick={() => {
              onFilter(f.id);
            }}
          >
            {f.label}
          </button>
        ))}
        <span className="filters-count" aria-live="polite">
          {loading && rows.length === 0 ? 'Loading…' : `${String(shown.length)} of ${String(rows.length)}`}
        </span>
      </div>
      {shown.length === 0 && !loading ? (
        <p className="empty-line">
          {rows.length === 0 ? 'Nothing has happened in this agent yet.' : 'Nothing of this kind yet.'}
        </p>
      ) : (
        <div
          className="timeline-scroll"
          role="table"
          aria-label="Timeline events, newest first"
          aria-rowcount={shown.length}
          onScroll={onScroll}
          tabIndex={0}
        >
          <div className="timeline-spacer" style={{ height: shown.length * ROW }}>
            <div style={{ transform: `translateY(${String(first * ROW)}px)` }} role="rowgroup">
              {windowRows.map((r, i) => {
                const more = hasMore(r);
                const isOpen = open?.id === r.id;
                return (
                  <div
                    key={r.id}
                    role="row"
                    aria-rowindex={first + i + 1}
                    aria-selected={more ? isOpen : undefined}
                    tabIndex={more ? 0 : undefined}
                    title={more ? (isOpen ? 'Close the reader' : 'Open in the reader') : undefined}
                    className={`tl-row kind-${r.filter}${more ? ' has-more' : ''}${isOpen ? ' is-open' : ''}`}
                    onClick={
                      more
                        ? () => {
                            toggle(r);
                          }
                        : undefined
                    }
                    onKeyDown={
                      more
                        ? (e: KeyboardEvent<HTMLDivElement>) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              toggle(r);
                            }
                          }
                        : undefined
                    }
                  >
                    <span role="cell" className="tl-time" title={clockTimeFull(r.ts)}>
                      {clockTime(r.ts)}
                    </span>
                    <span role="cell" className="tl-label" title={r.title}>
                      {r.filter === 'failure' && (
                        <span className="tl-fail" aria-hidden="true">
                          ✕{' '}
                        </span>
                      )}
                      {r.title}
                    </span>
                    <span
                      role="cell"
                      className={`tl-summary${r.code ? ' code' : ''}`}
                      title={more ? undefined : (r.detail ?? undefined)}
                    >
                      {simple && r.code ? withoutFlags(r.line) : r.line}
                    </span>
                    <span role="cell" className="tl-duration">
                      {r.kind === 'tool' && !simple ? (
                        duration(r.durationMs)
                      ) : more ? (
                        <span className="tl-more">Read</span>
                      ) : (
                        ''
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
      {open?.detail != null && (
        <section ref={reader} className="tl-reader" aria-label={`${open.title}, ${clockTimeFull(open.ts)}`}>
          <header className="tl-reader-head">
            <span className="tl-reader-title">
              {open.title} <span className="tl-reader-time">{clockTime(open.ts)}</span>
            </span>
            <button
              type="button"
              className="filter"
              onClick={() => {
                setOpenId(null);
              }}
            >
              Close
            </button>
          </header>
          <div className="tl-reader-body" tabIndex={0}>
            {open.code ? (
              <pre className="md-pre">
                <code>{open.detail}</code>
              </pre>
            ) : (
              <MessageText text={open.detail} />
            )}
          </div>
        </section>
      )}
    </section>
  );
}
