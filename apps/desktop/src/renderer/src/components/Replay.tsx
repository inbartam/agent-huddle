/**
 * Replay (M5, F22): the Replay tab of a past run (DESIGN.md "Replay (F22)"). A scrubber over the run's event index,
 * the team as it stood at that event, and why anything needed the user then.
 *
 * Not live, and it says so three ways: the band, the frame, and nothing breathes. There are no controls at all: no
 * Allow, Deny, Message, Pause or Stop, and no `ControlButton`. `TeamTree` runs in `mode="replay"` (rows expand and
 * select, nothing else) and the meters drop the ETA. The only things a press can do here are move the position, pick
 * an agent, filter the list and expand a row; none of it reaches an agent or the core's state.
 *
 * Moving asks `history.stateAt` (at once for keys, buttons and markers; debounced while dragging). An answer that
 * comes back for an older position is dropped (`LatestLoader`), and the previous moment stays on screen, muted after a
 * moment, until the new one is ready, so nothing flashes empty.
 *
 * Every string from the run (agent names, item titles and details, tool summaries, errors, timeline rows) is a text
 * node.
 */
import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import {
  agentKey as sessionRootKey,
  HISTORY_EVENTS_MAX,
  LEAD_AGENT,
  selectTree,
  type AgentKey,
  type AgentNode,
  type HuddleEvent,
  type HuddleState,
  type QueryResult,
  type ReplayMarker,
  type ReplayMoment,
  type ReplayWhy,
  type RunHead,
} from '@huddle/shared';
import type { QueryFn } from '../query.js';
import {
  LatestLoader,
  loadEventsUpTo,
  loadMoment,
  type EventsAnswer,
  type EventsAsk,
  type MomentAnswer,
} from '../replay-query.js';
import { displayName } from '../store.js';
import { clockTimeFull, duration, UNKNOWN } from '../view/format.js';
import {
  attentionKey,
  calmLine,
  canRetry,
  clampIndex,
  fateWords,
  gapMarks,
  isJumpFilter,
  JUMP_OPTIONS,
  lateStartWords,
  laterWords,
  layoutMarkers,
  loadingWords,
  nextAttention,
  positionWords,
  quietWords,
  REPLAY_WORDS,
  replayFailure,
  replayToggles,
  scrubKey,
  snapshotWords,
  teamAt,
  thumbLabel,
  trackPct,
  valueText,
  waitedWords,
  splitWhy,
  replayEventRows,
  currentRow,
  whyKind,
  type JumpFilter,
  type ThumbLabel,
} from '../view/replay.js';
import { filterTimeline, TIMELINE_FILTERS, type TimelineFilter } from '../view/timeline.js';
import { buildRows } from '../view/tree.js';
import { ContextSection, ProgressSection, Section, UsageSection } from './Meters.js';
import { StatusBadge } from './Status.js';
import { TeamTree } from './TeamTree.js';
import { isTextField, useDelayed } from './ui-util.js';

type Failed = Extract<QueryResult, { ok: false }>;

const NO_RENAMES: ReadonlyMap<AgentKey, string> = new Map();
const LOADING_DELAY_MS = 300;
/** A position answer slower than this mutes the old moment and shows "…" in the thumb label. */
const PENDING_DELAY_MS = 150;
const EVENTS_DEBOUNCE_MS = 150;
/** Timeline rows shown at first, and added by "Show earlier". */
const ROWS_STEP = 50;
/** Events asked for at first: several per row, since usage and context events draw no row. */
const EVENTS_FIRST = 200;
/** Track width before the first measurement (and in static render tests). */
const TRACK_DEFAULT_PX = 600;

/** An agent's name in the replay: the replayed tree's own words (the core's name, no session label), so the head, the
 * markers and the tree agree. */
export function replayName(state: HuddleState, key: AgentKey): string {
  const node = state.agents[key];
  if (node === undefined) return UNKNOWN;
  // The main agent is "Lead agent" inside its session, as in the live session view (never the raw "main").
  return node.kind === 'main' ? LEAD_AGENT : displayName(node, NO_RENAMES);
}

/** What tests (and nothing else) hand in instead of asking the core. */
export interface ReplayInitial {
  moment?: MomentAnswer;
  events?: EventsAnswer;
  index?: number;
  follow?: boolean;
  picked?: AgentKey | null;
  jump?: JumpFilter;
}

export interface ReplayProps {
  query: QueryFn | null;
  head: RunHead;
  /** Open at this event ("Show in replay" in the report); otherwise at the last event. */
  startIndex?: number | null;
  /** "Show live": select this session's main agent in the team and close History. */
  onShowLive?: (key: AgentKey) => void;
  /** "Load newer events": ask for the run's head again (a live run has grown). */
  onLoadNewer?: () => void;
  initial?: ReplayInitial;
  /** Track width for marker merging in tests. */
  trackPx?: number;
}

export function Replay({ query, head, startIndex, onShowLive, onLoadNewer, initial, trackPx }: ReplayProps) {
  const n = head.eventCount;
  const sessionId = head.row.sessionId;
  const live = head.row.outcome === 'running';

  const [index, setIndex] = useState(() => clampIndex(initial?.index ?? startIndex ?? n - 1, n));
  const [moment, setMoment] = useState<ReplayMoment | null>(initial?.moment?.ok ? initial.moment.moment : null);
  const [error, setError] = useState<Failed | null>(
    initial?.moment !== undefined && !initial.moment.ok ? initial.moment : null,
  );
  const [follow, setFollow] = useState(initial?.follow ?? true);
  const [picked, setPicked] = useState<AgentKey | null>(initial?.picked ?? null);
  const [jump, setJump] = useState<JumpFilter>(initial?.jump ?? 'everything');
  const [toggled, setToggled] = useState<ReadonlySet<AgentKey>>(new Set());
  const [events, setEvents] = useState<{ ask: EventsAsk | null; answer: EventsAnswer } | null>(
    initial?.events ? { ask: null, answer: initial.events } : null,
  );
  const [eventFilter, setEventFilter] = useState<TimelineFilter>('all');
  const [rowsShown, setRowsShown] = useState(ROWS_STEP);
  const [eventsLimit, setEventsLimit] = useState(EVENTS_FIRST);
  const [trackWidth, setTrackWidth] = useState(trackPx ?? TRACK_DEFAULT_PX);

  const momentLoader = useRef<LatestLoader<number, MomentAnswer> | null>(null);
  const eventsLoader = useRef<LatestLoader<EventsAsk, EventsAnswer> | null>(null);
  const firstIndex = useRef(index);
  const skipFirstMoment = useRef(initial?.moment !== undefined);
  const skipFirstEvents = useRef(initial?.events !== undefined);
  const toTail = useRef(false);
  const track = useRef<HTMLDivElement>(null);
  const frameId = useId();

  // One loader per run; answers only ever replace the screen for the newest question.
  useEffect(() => {
    const moments = new LatestLoader<number, MomentAnswer>(
      (i) => loadMoment(query, sessionId, i),
      (a, asked) => {
        if (a.ok) {
          setMoment(a.moment);
          setError(null);
          if (a.moment.index !== asked) setIndex(a.moment.index); // the core clamped it
        } else {
          setError(a);
        }
      },
    );
    const list = new LatestLoader<EventsAsk, EventsAnswer>(
      (ask) => loadEventsUpTo(query, ask),
      (answer, ask) => {
        setEvents({ ask, answer });
      },
      EVENTS_DEBOUNCE_MS,
    );
    momentLoader.current = moments;
    eventsLoader.current = list;
    if (skipFirstMoment.current) skipFirstMoment.current = false;
    else if (n > 0) moments.go(firstIndex.current);
    return () => {
      moments.dispose();
      list.dispose();
      momentLoader.current = null;
      eventsLoader.current = null;
    };
    // `n` is read only for the first question; a grown run moves by `toTail` below.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-creating the loaders whenever the run grows would drop the in-flight load
  }, [query, sessionId]);

  const move = useCallback(
    (i: number, how: 'now' | 'later' = 'now') => {
      if (n === 0) return;
      const c = clampIndex(i, n);
      setIndex(c);
      momentLoader.current?.go(c, how);
    },
    [n],
  );

  // "Load newer events": once the new head is here, go to its last event.
  useEffect(() => {
    if (!toTail.current) return;
    toTail.current = false;
    move(n - 1);
  }, [n, move]);

  // The track's width decides which markers merge.
  useEffect(() => {
    const el = track.current;
    if (trackPx !== undefined || el === null || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w !== undefined && w > 0) setTrackWidth(w);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, [trackPx]);

  const selectedKey: AgentKey | null =
    moment === null ? null : follow ? moment.event.agentKey : (picked ?? moment.event.agentKey);
  const shownIndex = moment?.index ?? null;

  // A new agent starts its list from the top again.
  useEffect(() => {
    setRowsShown(ROWS_STEP);
    setEventsLimit(EVENTS_FIRST);
  }, [selectedKey]);

  useEffect(() => {
    if (shownIndex === null || selectedKey === null) return;
    if (skipFirstEvents.current) {
      skipFirstEvents.current = false;
      return;
    }
    eventsLoader.current?.go({ sessionId, index: shownIndex, agentKey: selectedKey, limit: eventsLimit }, 'later');
  }, [sessionId, shownIndex, selectedKey, eventsLimit]);

  const pending = moment !== null && moment.index !== index;
  const showPending = useDelayed(pending, PENDING_DELAY_MS);
  const showLoading = useDelayed(moment === null && error === null, LOADING_DELAY_MS);

  const jumpTo = (m: ReplayMarker | null) => {
    if (m === null) return;
    if (!follow) setPicked(m.agentKey);
    move(m.index);
  };
  const prev = nextAttention(head.markers, index, jump, -1);
  const next = nextAttention(head.markers, index, jump, 1);

  // N and Shift+N anywhere in the frame, except in a text field.
  const onFrameKey = (e: KeyboardEvent<HTMLElement>) => {
    const to = attentionKey(e, isTextField(e.target), head.markers, index, jump);
    if (to === undefined) return;
    e.preventDefault();
    jumpTo(to);
  };

  const onRangeKey = (e: KeyboardEvent<HTMLInputElement>) => {
    // Alt+Left is "← All runs"; Ctrl and Meta keys belong to the window.
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const to = scrubKey(e.key, e.shiftKey, index, n);
    if (to === null) return;
    e.preventDefault();
    move(to);
  };

  const label: ThumbLabel | null =
    moment === null
      ? null
      : thumbLabel(
          moment.event,
          head.row.startTs,
          head.markers,
          head.quietGaps,
          moment.gapBeforeMs,
          replayName(moment.state, moment.event.agentKey),
        );
  const labelCurrent = !pending ? label : null;
  const groups = useMemo(() => layoutMarkers(head.markers, n, trackWidth), [head.markers, n, trackWidth]);
  const gaps = useMemo(() => gapMarks(head.quietGaps, n), [head.quietGaps, n]);
  const pct = trackPct(index, n);
  const markerAt = (i: number) => head.markers.find((m) => m.index === i) ?? null;

  const band = (
    <div className="rp-band">
      <p className="rp-band-line">
        <span className="rp-band-title">{REPLAY_WORDS.band}</span>
        <span className="muted">{REPLAY_WORDS.bandNote}</span>
      </p>
      {live && (
        <p className="rp-band-line">
          <span>{snapshotWords(head.lastTs)}</span>
          {onLoadNewer && (
            <button
              type="button"
              className="quiet-button"
              onClick={() => {
                toTail.current = true;
                onLoadNewer();
              }}
            >
              {REPLAY_WORDS.loadNewer}
            </button>
          )}
          {onShowLive && (
            <button
              type="button"
              className="quiet-button"
              onClick={() => {
                onShowLive(sessionRootKey(sessionId));
              }}
            >
              {REPLAY_WORDS.showLive}
            </button>
          )}
        </p>
      )}
      {!head.startsWithSession && <p className="rp-band-line muted">{lateStartWords(head.row.startTs)}</p>}
    </div>
  );

  if (n === 0) {
    return (
      <section className="replay" aria-label="Replay, not live">
        {band}
        <p className="empty-line rp-empty">{REPLAY_WORDS.empty}</p>
      </section>
    );
  }

  const retry = () => {
    setError(null);
    move(index);
  };

  return (
    <section className="replay" aria-label="Replay, not live" onKeyDown={onFrameKey}>
      {band}
      <div className="rp-scrub">
        <div className="rp-steps" role="toolbar" aria-label="Move through the run">
          <StepButton
            label={REPLAY_WORDS.first}
            glyph="|◀"
            off={index === 0}
            onPress={() => {
              move(0);
            }}
          />
          <StepButton
            label={REPLAY_WORDS.back}
            glyph="◀"
            off={index === 0}
            onPress={() => {
              move(index - 1);
            }}
          />
          <StepButton
            label={REPLAY_WORDS.forward}
            glyph="▶"
            off={index >= n - 1}
            onPress={() => {
              move(index + 1);
            }}
          />
          <StepButton
            label={REPLAY_WORDS.last}
            glyph="▶|"
            off={index >= n - 1}
            onPress={() => {
              move(n - 1);
            }}
          />
          <span className="rp-steps-gap" aria-hidden="true" />
          <NavButton
            off={prev === null}
            reason={REPLAY_WORDS.noMoreBefore}
            shortcut="Shift+N"
            onPress={() => {
              jumpTo(prev);
            }}
          >
            ◂ {REPLAY_WORDS.prevAttention}
          </NavButton>
          <NavButton
            off={next === null}
            reason={REPLAY_WORDS.noMoreAfter}
            shortcut="N"
            onPress={() => {
              jumpTo(next);
            }}
          >
            {REPLAY_WORDS.nextAttention} ▸
          </NavButton>
          <label className="hist-filter rp-jump">
            <span>{REPLAY_WORDS.jumpBetween}</span>
            <select
              className="text-input select-input"
              value={jump}
              onChange={(e) => {
                if (isJumpFilter(e.target.value)) setJump(e.target.value);
              }}
            >
              {JUMP_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <span className="rp-pos">{positionWords(index, n)}</span>
        </div>

        <div className="rp-track" ref={track}>
          <input
            id={`${frameId}-range`}
            className="rp-range"
            type="range"
            min={0}
            max={n - 1}
            step={1}
            value={index}
            aria-label={REPLAY_WORDS.position}
            aria-valuetext={valueText(index, n, labelCurrent)}
            aria-keyshortcuts="N Shift+N"
            onChange={(e) => {
              move(Number(e.target.value), 'later');
            }}
            onKeyDown={onRangeKey}
          />
          <div className="rp-marks">
            {gaps.map((g) => (
              <span key={g.key} className="rp-gap" style={{ left: `${String(g.leftPct)}%` }} title={g.title}>
                ⋯<span className="visually-hidden">{g.title}</span>
              </span>
            ))}
            {groups.map((g) => (
              <button
                key={g.key}
                type="button"
                tabIndex={-1}
                className={`rp-mark tone-${g.tone}`}
                style={{ left: `${String(g.leftPct)}%` }}
                title={g.title}
                aria-label={g.title}
                onClick={() => {
                  jumpTo(markerAt(g.index));
                }}
              >
                {g.glyph}
              </button>
            ))}
          </div>
          <div className="rp-thumb-lane" aria-hidden="true">
            <span
              className="rp-thumb-label"
              style={{ left: `${String(pct)}%`, transform: `translateX(-${String(pct)}%)` }}
            >
              {labelCurrent !== null ? (
                <ThumbText label={labelCurrent} />
              ) : showPending || label === null ? (
                REPLAY_WORDS.pending
              ) : (
                <ThumbText label={label} />
              )}
            </span>
          </div>
        </div>
        {head.markersTruncated && <p className="rp-note muted">{REPLAY_WORDS.markersCut}</p>}
        {moment !== null && error !== null && <ErrorLine error={error} onRetry={retry} />}
      </div>

      {moment === null ? (
        error !== null ? (
          <div className="rp-message">
            <ErrorLine error={error} onRetry={retry} />
          </div>
        ) : (
          <div className="rp-message" aria-live="polite">
            {showLoading && <p className="muted">{loadingWords(n)}</p>}
          </div>
        )
      ) : (
        <div className={`rp-body${showPending ? ' is-pending' : ''}`} aria-busy={pending || undefined}>
          <aside className="rp-team" aria-label={teamAt(moment.event.ts)}>
            <h2 className="section-title rp-team-title">{teamAt(moment.event.ts)}</h2>
            <ReplayTree
              moment={moment}
              selectedKey={selectedKey}
              toggled={toggled}
              onToggle={(key) => {
                setToggled((prevSet) => {
                  const s = new Set(prevSet);
                  if (s.has(key)) s.delete(key);
                  else s.add(key);
                  return s;
                });
              }}
              onPick={(key) => {
                setPicked(key);
                setFollow(false);
              }}
            />
            <button
              type="button"
              className="filter rp-follow"
              aria-pressed={follow}
              onClick={() => {
                if (follow) {
                  setPicked(selectedKey);
                  setFollow(false);
                } else {
                  setFollow(true);
                }
              }}
            >
              {follow ? '✓ ' : ''}
              {REPLAY_WORDS.follow}
            </button>
          </aside>
          <MomentPane
            moment={moment}
            selectedKey={selectedKey}
            events={events}
            eventFilter={eventFilter}
            onEventFilter={setEventFilter}
            rowsShown={rowsShown}
            onShowEarlier={(rowsAvailable, more) => {
              setRowsShown((r) => r + ROWS_STEP);
              if (rowsAvailable < rowsShown + ROWS_STEP && more) {
                setEventsLimit((l) => Math.min(HISTORY_EVENTS_MAX, l * 2));
              }
            }}
            onMove={(i) => {
              move(i);
            }}
            onPick={(key) => {
              setPicked(key);
              setFollow(false);
            }}
          />
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

/** A glyph-only stepping button: its words are its accessible name and tooltip. */
function StepButton({
  label,
  glyph,
  off,
  onPress,
}: {
  label: string;
  glyph: string;
  off: boolean;
  onPress: () => void;
}) {
  return (
    <button
      type="button"
      className="quiet-button rp-step"
      aria-label={label}
      title={label}
      aria-disabled={off || undefined}
      onClick={() => {
        if (!off) onPress();
      }}
    >
      {glyph}
    </button>
  );
}

/** Previous / Next attention. Off stays focusable (`aria-disabled`) so its tooltip can say why. */
function NavButton({
  off,
  reason,
  shortcut,
  onPress,
  children,
}: {
  off: boolean;
  reason: string;
  shortcut: string;
  onPress: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`quiet-button rp-nav${off ? ' is-off' : ''}`}
      aria-disabled={off || undefined}
      aria-keyshortcuts={shortcut}
      title={off ? reason : `Shortcut: ${shortcut}`}
      data-reason={off ? reason : undefined}
      onClick={() => {
        if (!off) onPress();
      }}
    >
      {children}
    </button>
  );
}

function ThumbText({ label }: { label: ThumbLabel }) {
  return (
    <>
      <span className="rp-thumb-time">{label.time}</span>
      <span className="sep"> · </span>
      <span>{label.what}</span>
      <span className="sep"> · </span>
      <span className="rp-thumb-agent">{label.agent}</span>
      {label.quiet !== null && <span className="muted"> {label.quiet}</span>}
    </>
  );
}

function ErrorLine({ error, onRetry }: { error: Failed; onRetry: () => void }) {
  const retry = canRetry(error);
  return (
    <p className="rp-error-line">
      <span className={retry ? 'inline-error' : 'empty-line'} role="alert">
        {replayFailure(error)}
      </span>
      {retry && (
        <button type="button" className="quiet-button" onClick={onRetry}>
          {REPLAY_WORDS.tryAgain}
        </button>
      )}
    </p>
  );
}

function ReplayTree({
  moment,
  selectedKey,
  toggled,
  onToggle,
  onPick,
}: {
  moment: ReplayMoment;
  selectedKey: AgentKey | null;
  toggled: ReadonlySet<AgentKey>;
  onToggle: (key: AgentKey) => void;
  onPick: (key: AgentKey) => void;
}) {
  const sessions = useMemo(() => selectTree(moment.state), [moment.state]);
  const rows = useMemo(
    () =>
      buildRows(sessions, {
        toggled: replayToggles(
          sessions.filter((s) => s.ended).map((s) => s.rootKey),
          toggled,
        ),
      }),
    [sessions, toggled],
  );
  if (rows.length === 0) return <p className="empty-line">{REPLAY_WORDS.notStarted}</p>;
  return (
    <TeamTree
      roleKinds={moment.state.settings?.roleKinds}
      rows={rows}
      renames={NO_RENAMES}
      selectedKey={selectedKey}
      onActivate={(row) => {
        onPick(row.key);
      }}
      onToggle={onToggle}
      mode="replay"
      leadLabel
      label={teamAt(moment.event.ts)}
    />
  );
}

function MomentPane({
  moment,
  selectedKey,
  events,
  eventFilter,
  onEventFilter,
  rowsShown,
  onShowEarlier,
  onMove,
  onPick,
}: {
  moment: ReplayMoment;
  selectedKey: AgentKey | null;
  events: { ask: EventsAsk | null; answer: EventsAnswer } | null;
  eventFilter: TimelineFilter;
  onEventFilter: (f: TimelineFilter) => void;
  rowsShown: number;
  onShowEarlier: (rowsAvailable: number, more: boolean) => void;
  onMove: (index: number) => void;
  /** Select another agent (the "Also needs attention" line); turns following off, like a pick in the tree. */
  onPick: (key: AgentKey) => void;
}) {
  const { state } = moment;
  const agent: AgentNode | null = selectedKey === null ? null : (state.agents[selectedKey] ?? null);
  // Only the selected agent's items in full; the other agents with open items get one compact line.
  const { mine, others } = splitWhy(moment.why, selectedKey);
  const also = others.length > 0 ? <AlsoLine others={others} state={state} onPick={onPick} /> : null;

  if (agent === null) {
    return (
      <div className="rp-moment">
        <p className="empty-line">{REPLAY_WORDS.notStarted}</p>
        {mine.length > 0 && <WhySection why={mine} moment={moment} />}
        {also}
      </div>
    );
  }

  const parent = agent.parentKey === null ? null : (state.agents[agent.parentKey] ?? null);
  return (
    <div className="rp-moment">
      <header className="rp-moment-head">
        <h2 className="rp-agent-name">{replayName(state, agent.key)}</h2>
        <StatusBadge status={agent.status} still kind={agent.kind} />
        {agent.kind !== 'main' && (
          <span className="muted">reports to {parent ? replayName(state, parent.key) : UNKNOWN}</span>
        )}
      </header>
      {mine.length > 0 ? (
        <WhySection why={mine} moment={moment} />
      ) : (
        <p className="meter-line rp-calm">{calmLine(agent.currentActivity, agent.lastEventAt, moment.event.ts)}</p>
      )}
      {also}
      <ProgressSection state={state} agent={agent} now={moment.event.ts} replay />
      <UsageSection state={state} agent={agent} />
      <ContextSection agent={agent} />
      <EventsHere
        agentKey={agent.key}
        at={moment.index}
        events={events}
        filter={eventFilter}
        onFilter={onEventFilter}
        rowsShown={rowsShown}
        onShowEarlier={onShowEarlier}
        onMove={onMove}
      />
    </div>
  );
}

function WhySection({ why, moment }: { why: readonly ReplayWhy[]; moment: ReplayMoment }) {
  return (
    <Section title={REPLAY_WORDS.why}>
      {why.map((w) => (
        <WhyBlock key={w.itemId} why={w} state={moment.state} />
      ))}
    </Section>
  );
}

/** "Also needs attention at this point:" and each other agent with open items (name, kind words); a click selects it. */
function AlsoLine({
  others,
  state,
  onPick,
}: {
  others: readonly { agentKey: AgentKey; items: readonly ReplayWhy[] }[];
  state: HuddleState;
  onPick: (key: AgentKey) => void;
}) {
  return (
    <p className="rp-also">
      <span className="muted">{REPLAY_WORDS.alsoNeeds}</span>{' '}
      {others.map((o, i) => {
        const kinds = o.items.map((w) => whyKind(w, state));
        const words = [...new Set(kinds.map((k) => k.words))].join(', ');
        const glyph = kinds.some((k) => k.glyph === '▲') ? '▲' : '!';
        const name = replayName(state, o.agentKey);
        return (
          <Fragment key={o.agentKey}>
            {i > 0 && (
              <span className="sep" aria-hidden="true">
                {' · '}
              </span>
            )}
            <button
              type="button"
              className="link-button rp-also-agent"
              aria-label={`Select ${name}: ${words}`}
              onClick={() => {
                onPick(o.agentKey);
              }}
            >
              <span className="glyph tone-needs-you" aria-hidden="true">
                {glyph}
              </span>{' '}
              <span className="rp-also-name">{name}</span> <span className="rp-why-kind">{words}</span>
            </button>
          </Fragment>
        );
      })}
    </p>
  );
}

function WhyBlock({ why, state }: { why: ReplayWhy; state: HuddleState }) {
  const kind = whyKind(why, state);
  const tool = why.lastToolCall;
  return (
    <article className="rp-why" aria-label={`${kind.words}: ${why.title}`}>
      <p className="rp-why-head">
        <span className="glyph tone-needs-you" aria-hidden="true">
          {kind.glyph}
        </span>
        <span className="rp-why-kind">{kind.words}</span>
        <span className="rp-why-title">{why.title}</span>
      </p>
      {why.detail.trim() !== '' && <p className="rp-why-detail">{why.detail}</p>}
      <dl className="rp-facts">
        {why.request !== null && (
          <>
            <dt>Request</dt>
            <dd>
              <span className="code">{why.request.summary}</span>
              <span className="rp-fact-note">{waitedWords(why.request.waitedMs)}</span>
            </dd>
          </>
        )}
        <dt>{REPLAY_WORDS.lastTool}</dt>
        <dd>
          {tool === null ? (
            <span className="muted">none</span>
          ) : (
            <>
              <span className="rp-tool">{tool.toolName}</span> <span className="code">{tool.summary}</span>
              <span className="rp-fact-note">{fateWords(tool.fate, tool.startedTs)}</span>
            </>
          )}
        </dd>
      </dl>
      {why.quietMs !== null && <p className="rp-why-line">{quietWords(why.quietMs)}</p>}
      <p className="rp-why-line rp-later">
        <span className="rp-later-label">{REPLAY_WORDS.later}</span> {laterWords(why.later, why.kind)}
      </p>
    </article>
  );
}

function EventsHere({
  agentKey,
  at,
  events,
  filter,
  onFilter,
  rowsShown,
  onShowEarlier,
  onMove,
}: {
  agentKey: AgentKey;
  at: number;
  events: { ask: EventsAsk | null; answer: EventsAnswer } | null;
  filter: TimelineFilter;
  onFilter: (f: TimelineFilter) => void;
  rowsShown: number;
  onShowEarlier: (rowsAvailable: number, more: boolean) => void;
  onMove: (index: number) => void;
}) {
  // An answer for another agent (the selection just changed) is not this agent's list.
  const answer = events !== null && (events.ask === null || events.ask.agentKey === agentKey) ? events.answer : null;
  const built = useMemo(() => {
    if (answer === null || !answer.ok) return null;
    const entries = answer.page.entries;
    const list = entries.map((e) => e.event).filter((e): e is HuddleEvent => e !== undefined);
    const indexOf = new Map<string, number>();
    for (const e of entries) if (e.event !== undefined) indexOf.set(e.event.id, e.index);
    // Entries come newest first; the timeline builds from oldest to newest.
    return { rows: replayEventRows([...list].reverse(), agentKey, indexOf), indexOf, more: answer.page.more };
  }, [answer, agentKey]);
  const shown = built === null ? [] : filterTimeline(built.rows, filter);
  const visible = shown.slice(0, rowsShown);
  // The event at the position, or the nearest row before it when that event is not a row.
  const here = built === null ? null : currentRow(shown, built.indexOf, at);
  const canShowEarlier = built !== null && (shown.length > rowsShown || built.more);

  return (
    <Section title={REPLAY_WORDS.eventsHere}>
      <div className="filters" role="toolbar" aria-label="Filter events by kind">
        {TIMELINE_FILTERS.map((f) => (
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
          {answer === null ? 'Loading…' : built === null ? '' : String(shown.length)}
        </span>
      </div>
      {answer !== null && !answer.ok ? (
        <p className="inline-error" role="alert">
          {replayFailure(answer)}
        </p>
      ) : built !== null && shown.length === 0 ? (
        <p className="empty-line">{built.rows.length === 0 ? REPLAY_WORDS.noEventsHere : REPLAY_WORDS.noKindHere}</p>
      ) : (
        <ol className="rp-events" aria-label="Events up to here, newest first">
          {visible.map((r) => {
            const i = built?.indexOf.get(r.id);
            const current = here !== null && here.id === r.id;
            const nearest = current && !here.exact;
            return (
              <li key={r.id}>
                <button
                  type="button"
                  className={`tl-row rp-event kind-${r.filter}${current ? ' is-current' : ''}${nearest ? ' is-nearest' : ''}`}
                  aria-current={current ? 'step' : undefined}
                  title={r.detail ?? undefined}
                  onClick={() => {
                    if (i !== undefined) onMove(i);
                  }}
                >
                  <span className="tl-time">{clockTimeFull(r.ts)}</span>
                  <span className="tl-label">
                    {r.filter === 'failure' && (
                      <span className="tl-fail" aria-hidden="true">
                        ✕{' '}
                      </span>
                    )}
                    {r.title}
                  </span>
                  <span className={`tl-summary${r.code ? ' code' : ''}`}>{r.line}</span>
                  <span className="tl-duration">{r.kind === 'tool' ? duration(r.durationMs) : ''}</span>
                  {nearest && <span className="visually-hidden">, {REPLAY_WORDS.nearest}</span>}
                </button>
              </li>
            );
          })}
        </ol>
      )}
      {canShowEarlier && (
        <button
          type="button"
          className="quiet-button"
          onClick={() => {
            onShowEarlier(shown.length, built.more);
          }}
        >
          {REPLAY_WORDS.showEarlier}
        </button>
      )}
    </Section>
  );
}
