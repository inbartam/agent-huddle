/**
 * Widget (WP11; Widget v2, owner's choice 2026-11-14): 340 px, always on top. A header with the session count and
 * how many need the user, then one card per session (most recently active first, view/cards.ts). A request waiting
 * on the user renders inline in its session's card; one whose agent has no card is pinned at the bottom, so none
 * becomes unreachable. The × on a card hides it until that session does something new (view/hidden.ts), in memory
 * only.
 *
 * The window's height follows this content: main enables preferred-size mode on the widget and resizes
 * the window to the reported height (max 480 px, see main/widget-bounds.ts). No IPC is involved.
 */
import { useCallback, useMemo, useState } from 'react';
import {
  isTerminal,
  selectAgent,
  selectContextWarning,
  selectProgress,
  selectTree,
  selectUsageRollup,
  type AgentKey,
  type HuddleCommand,
  type HuddleState,
  type SessionView,
} from '@huddle/shared';
import { EmptyState, ErrorLine } from '../components/Chrome.js';
import { WidgetConnectionRow } from '../components/Connection.js';
import { InboxCard, type SendCommand } from '../components/Inbox.js';
import { OpenIcon, SessionCard } from '../components/SessionCard.js';
import { PhoneMark } from '../components/Shell.js';
import type { RowMeters } from '../components/TeamTree.js';
import { useSnapshot, type HuddleStore } from '../store.js';
import { useNow } from '../useNow.js';
import { widgetCards } from '../view/cards.js';
import { hideWidgetUrl, openMainUrl } from '../view/deep-link.js';
import { approxUsd, clockTime, count, percent, plural } from '../view/format.js';
import { hide, isHidden, pruneMarks, type HiddenMarks } from '../view/hidden.js';
import {
  COLLAPSE_HINT,
  collapseCommand,
  connectionWord,
  EXPAND_HINT,
  savedCollapsed,
  shownCollapsed,
} from '../view/collapse.js';
import { knownCostUsd, knownUsage, progressWords, rateLimitRows } from '../view/meters.js';
import { counts, treeOptions } from '../view/summary.js';
import type { TreeRow } from '../view/tree.js';

/**
 * Compact meters for one agent (F4–F6). A session shows the session's total usage (the whole tree plus helper
 * requests); an agent shows its own. No bar without a measure; `—` for usage not yet recorded.
 */
export function agentMeters(state: HuddleState, key: AgentKey, isSession: boolean, now: number): RowMeters | null {
  const agent = selectAgent(state, key);
  if (agent === null) return null;
  const usage = isSession ? knownUsage(selectUsageRollup(state, agent.key)?.usage) : knownUsage(agent.usage);
  // Only a running agent gets a bar at a glance: an idle one has finished its turn and a finished one needs no
  // progress. The detail pane shows the numbers either way.
  const running = agent.status !== 'idle' && !isTerminal(agent.status);
  const fraction = running
    ? progressWords(selectProgress(state, agent.key, now, { priors: state.priors ?? null }), agent).fraction
    : null;
  const scope = isSession ? 'session' : 'agent';
  return {
    fraction,
    usage: approxUsd(knownCostUsd(usage)),
    usageTitle:
      usage === null
        ? `${scope} usage unknown: no requests recorded yet`
        : `${scope} cost ${knownCostUsd(usage) === null ? 'unknown (no request carried a cost)' : `${approxUsd(knownCostUsd(usage))} est. (Claude Code's figure)`}, ${count(usage.inputTokens + usage.outputTokens)} input and output tokens`,
    contextHighPct: selectContextWarning(agent) === 'high' ? agent.context.usedPct : null,
  };
}

/** Meters for one row of a tree: a session's main agent row sums its session. */
export function rowMeters(state: HuddleState, row: TreeRow, now: number): RowMeters | null {
  const agent = selectAgent(state, row.key);
  if (agent === null) return null;
  return agentMeters(state, row.key, row.depth === 0 && agent.kind === 'main', now);
}

/** Subscription limits (5 h and 7 d windows), account-wide, so one line under the header rather than per session. */
export function RateLimitLine({ state }: { state: HuddleState }) {
  const rows = rateLimitRows(state.rateLimits);
  if (rows.length === 0) return null;
  return (
    <div className="rate-limits" aria-label="Plan usage limits">
      <span className="rate-limits-label">Limits</span>
      {rows.map((r) => (
        <span
          key={r.label}
          className="rate-limit"
          title={
            r.pct === null
              ? `${r.label} window: unknown`
              : `${r.label} window ${percent(r.pct)} used${r.resetsAt === null ? '' : `, resets at ${clockTime(r.resetsAt)}`}`
          }
        >
          <span className="rate-limit-name">{r.label}</span>
          {r.pct !== null && (
            <span className="tree-bar rate-limit-bar" aria-hidden="true">
              <span className="tree-bar-fill" style={{ width: `${String(Math.min(100, Math.max(0, r.pct)))}%` }} />
            </span>
          )}
          <span className="rate-limit-pct">{percent(r.pct)}</span>
        </span>
      ))}
    </div>
  );
}

/**
 * Ask main to show the main window, optionally with one agent selected. Main's window-open handler recognises
 * exactly this URL shape (`?view=main`, plus `&agent=<key>`), shows the main window and denies the new window,
 * so nothing is ever opened here. See view/deep-link.ts.
 */
export function openMainWindow(agentKey?: AgentKey): void {
  window.open(openMainUrl(window.location.href, agentKey));
}

/** The widget's hide control (M6 P6, owner decision: a start at sign-in opens the widget, and the user can close it). */
export const HIDE_WIDGET_HINT = 'Hide the widget. The tray icon or the shortcut shows it again.';

/**
 * Hide the widget to the tray, the same way the widget asks for the main window: window.open of a URL main recognises
 * (`?view=widget&hide=1`, view/deep-link.ts), so no IPC channel is involved; main hides the window and denies the new
 * one. Not `window.close()`: that closes a BrowserWindow without a preventable `close` event (checked in the dev app),
 * destroying the widget instead of hiding it. Nothing in main shows it again by itself: only the tray icon, the tray
 * menu, the global shortcut, or the next start.
 */
export function hideWidget(): void {
  window.open(hideWidgetUrl(window.location.href));
}

function HideIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <path className="icon-line" d="M2.5 6 H9.5" />
    </svg>
  );
}

export interface WidgetBodyProps {
  state: HuddleState | null;
  error: string | null;
  renames: ReadonlyMap<AgentKey, string>;
  opened: ReadonlySet<AgentKey>;
  onToggle: (key: AgentKey) => void;
  /** Show the main window; with a key, with that agent selected. */
  onOpenMain: (agentKey?: AgentKey) => void;
  /** Clock for progress; defaults to a ticking clock (tests pass a fixed time). */
  now?: number;
  /** M3: send a command from an inline request. Without it the cards render but send nothing. */
  onCommand?: SendCommand;
  /** Cards the user hid (×), with the session's activity mark when hidden. */
  hidden?: HiddenMarks;
  /** Hide this session's card until it does something new. Without it no × is shown. */
  onHide?: (session: SessionView) => void;
  /** Show every hidden card again. */
  onShowHidden?: () => void;
  /** Collapsed to one line: the header with the counts, nothing else. */
  collapsed?: boolean;
  /** Collapse (true) or expand (false). Without it no chevron is shown. */
  onCollapse?: (collapsed: boolean) => void;
  /** Hide the widget to the tray. Without it no hide control is shown. */
  onHideWidget?: () => void;
}

const NO_SEND: SendCommand = () => Promise.resolve({ ok: true });
const NO_MARKS: HiddenMarks = new Map();
const WIDGET_CONTENT_ID = 'widget-content';

function ChevronIcon({ up }: { up: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <path className="icon-line" d={up ? 'M3 7.5 L6 4.5 L9 7.5' : 'M3 4.5 L6 7.5 L9 4.5'} />
    </svg>
  );
}

function NeedsCount({ n }: { n: number }) {
  return (
    <span className="widget-needs tone-needs-you">
      <span className="glyph tone-needs-you" aria-hidden="true">
        ▲
      </span>{' '}
      {n} need{n === 1 ? 's' : ''} you
    </span>
  );
}

export function WidgetBody({
  state,
  error,
  renames,
  opened,
  onToggle,
  onOpenMain,
  now: fixedNow,
  onCommand = NO_SEND,
  hidden = NO_MARKS,
  onHide,
  onShowHidden,
  collapsed = false,
  onCollapse,
  onHideWidget,
}: WidgetBodyProps) {
  const ticking = useNow();
  const now = fixedNow ?? ticking;
  const sessions = useMemo(() => (state ? selectTree(state, treeOptions(state)) : []), [state]);
  const model = useMemo(() => (state ? widgetCards(state, sessions) : { cards: [], orphans: [] }), [state, sessions]);
  const visible = model.cards.filter((c) => !isHidden(c.session, hidden, c.need !== null));
  const hiddenCount = model.cards.length - visible.length;
  const [orphan] = model.orphans;
  const c = state ? counts(state, sessions) : null;
  const meters = useCallback((row: TreeRow) => (state ? rowMeters(state, row, now) : null), [state, now]);

  const conn = connectionWord(state?.connection);

  return (
    <div className={`widget${collapsed ? ' is-collapsed' : ''}`}>
      <header className="widget-head">
        <button
          type="button"
          className="widget-title"
          onClick={() => {
            onOpenMain();
          }}
          title="Open the main window"
        >
          <span className={`widget-dot${c && c.working > 0 ? ' is-live' : ''}`} aria-hidden="true" />
          Huddle
        </button>
        {collapsed ? (
          // One line: the counts (and the connection, when it is not attached). A click expands; no auto-expand.
          <button
            type="button"
            className="widget-counts"
            title={EXPAND_HINT}
            aria-live="polite"
            onClick={() => {
              onCollapse?.(false);
            }}
          >
            {conn && (
              <span className={`widget-conn-word tone-${conn.tone}`}>
                <span className={`glyph tone-${conn.tone}`} aria-hidden="true">
                  {conn.tone === 'failed' ? '✕' : '▲'}
                </span>{' '}
                {conn.word}
              </span>
            )}
            <span className="widget-working">{c ? `${String(c.working)} working` : '—'}</span>
            {c && c.needsYou > 0 && <NeedsCount n={c.needsYou} />}
          </button>
        ) : (
          <span className="widget-sub" aria-live="polite">
            {/* The cards say who is working; the one-line view counts them instead. */}
            {state ? plural(sessions.length, 'session') : '—'}
          </span>
        )}
        <span className="widget-head-end">
          {!collapsed && <PhoneMark state={state} compact />}
          {!collapsed && c && c.needsYou > 0 && (
            <span aria-live="polite">
              <NeedsCount n={c.needsYou} />
            </span>
          )}
          {onCollapse && (
            <button
              type="button"
              className="icon-button"
              title={collapsed ? EXPAND_HINT : COLLAPSE_HINT}
              aria-label={collapsed ? EXPAND_HINT : COLLAPSE_HINT}
              aria-expanded={!collapsed}
              aria-controls={collapsed ? undefined : WIDGET_CONTENT_ID}
              onClick={() => {
                onCollapse(!collapsed);
              }}
            >
              <ChevronIcon up={!collapsed} />
            </button>
          )}
          <button
            type="button"
            className="icon-button"
            title="Open the main window"
            aria-label="Open the main window"
            onClick={() => {
              onOpenMain();
            }}
          >
            <OpenIcon />
          </button>
          {onHideWidget && (
            <button
              type="button"
              className="icon-button"
              title={HIDE_WIDGET_HINT}
              aria-label={HIDE_WIDGET_HINT}
              onClick={() => {
                onHideWidget();
              }}
            >
              <HideIcon />
            </button>
          )}
        </span>
      </header>
      {!collapsed && (
        <div id={WIDGET_CONTENT_ID} className="widget-content">
          {state?.connection && (
            <WidgetConnectionRow
              connection={state.connection}
              onOpenMain={() => {
                onOpenMain();
              }}
            />
          )}
          {state && <RateLimitLine state={state} />}
          <div className="widget-body">
            {error && <ErrorLine message={error} />}
            {state === null && !error && <p className="empty">Connecting to the core…</p>}
            {state && sessions.length === 0 && <EmptyState />}
            {state && visible.length > 0 && (
              <div className="scards" aria-label="Sessions">
                {visible.map((card, slot) => (
                  <SessionCard
                    key={card.session.rootKey}
                    slot={slot}
                    state={state}
                    card={card}
                    renames={renames}
                    opened={opened}
                    onToggle={onToggle}
                    onOpenMain={onOpenMain}
                    onHide={
                      onHide && card.need === null
                        ? () => {
                            onHide(card.session);
                          }
                        : null
                    }
                    onCommand={onCommand}
                    meters={meters}
                    sessionMeters={agentMeters(state, card.session.rootKey, true, now)}
                    now={now}
                    fixedNow={fixedNow}
                  />
                ))}
              </div>
            )}
            {hiddenCount > 0 && (
              <p className="widget-hidden">
                <span>{plural(hiddenCount, 'session')} hidden until they do something new</span>
                {onShowHidden && (
                  <button type="button" className="link-button" onClick={onShowHidden}>
                    Show
                  </button>
                )}
              </p>
            )}
          </div>
          {state && orphan && (
            <section className="pinned" aria-label="Waiting on you">
              <InboxCard
                key={orphan.id}
                state={state}
                item={orphan}
                renames={renames}
                onCommand={onCommand}
                onAgent={onOpenMain}
                compact
                now={fixedNow}
              />
            </section>
          )}
        </div>
      )}
    </div>
  );
}

export function WidgetView({ store }: { store: HuddleStore }) {
  const { state, error, renames } = useSnapshot(store);
  const [opened, setOpened] = useState<ReadonlySet<AgentKey>>(new Set());
  const [marks, setMarks] = useState<HiddenMarks>(new Map());
  const toggle = (key: AgentKey) => {
    setOpened((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  // Marks that no longer hide anything (the session moved on, or left) are dropped as state arrives.
  const sessions = useMemo(() => (state ? selectTree(state, treeOptions(state)) : []), [state]);
  const needy = useMemo(() => {
    const set = new Set<AgentKey>();
    if (state) for (const c of widgetCards(state, sessions).cards) if (c.need !== null) set.add(c.session.rootKey);
    return set;
  }, [state, sessions]);
  const live = state ? pruneMarks(marks, sessions, (s) => needy.has(s.rootKey)) : marks;
  if (live !== marks) setMarks(live);
  // Collapsed to one line: saved by the core (settings.update), shown at once on a click, then the saved value again.
  const saved = savedCollapsed(state);
  const [pending, setPending] = useState<boolean | null>(null);
  if (pending !== null && pending === saved) setPending(null);
  const collapse = (next: boolean) => {
    setPending(next);
    void store.command(collapseCommand(next)).then((r) => {
      // Not saved (not connected to the core, say): fall back to what is saved.
      if (!r.ok) setPending(null);
    });
  };
  return (
    <WidgetBody
      state={state}
      error={error}
      renames={renames}
      opened={opened}
      onToggle={toggle}
      onOpenMain={openMainWindow}
      onCommand={(cmd: HuddleCommand) => store.command(cmd)}
      hidden={live}
      onHide={(session) => {
        setMarks((prev) => hide(prev, session));
      }}
      onShowHidden={() => {
        setMarks(new Map());
      }}
      collapsed={shownCollapsed(saved, pending)}
      onCollapse={collapse}
      onHideWidget={hideWidget}
    />
  );
}
