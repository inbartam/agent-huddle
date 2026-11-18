/**
 * Needs you (main window redesign, WP2): the inbox, moved to the top of the sidebar. The same items, kinds and actions
 * as the M3 inbox, grouped "Waiting on you" (approvals, questions, anything that needs action) then "Warnings" (stuck,
 * loop, file conflict, budget nearly). Items of sessions that ended or are stale sit behind one quiet "N older"
 * toggle, so they do not pile up. Each item is a compact card (what is asked; project · session · how long it waited;
 * Allow / Deny / Open); Open shows the full InboxCard in place and the agent in the main area. "Recently handled" sits
 * behind a link, and stays as one quiet line when nothing waits. A toast's `#item=` deep link opens its card once (or
 * the handled list), highlights and focuses it; after that Show less and Hide work as for any card.
 *
 * Every string from an agent is a text node. Inside a focused compact card: A allows, D denies (no note; the full
 * card has the note), O opens. One 1 s clock here feeds every card.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { agentKey, type AgentKey, type AttentionItem, type HuddleState, type SessionIdentity } from '@huddle/shared';
import type { HuddleStore } from '../store.js';
import { useNow } from '../useNow.js';
import { armControl } from '../view/arming.js';
import { clockTime, clockTimeFull, UNKNOWN } from '../view/format.js';
import {
  allowCommand,
  approvalLimit,
  denyCommand,
  itemControls,
  kindWords,
  questionLimit,
  recentItems,
} from '../view/inbox.js';
import { compactKeyAction, itemPlace, linkedOpening, needsYouGroups, olderWords, waitedWords } from '../view/shell.js';
import { treeOptions } from '../view/summary.js';
import { useArming } from './Arming.js';
import { ControlButton } from './ControlButton.js';
import {
  AgentName,
  glyphFor,
  HandledCard,
  HiddenCommandLine,
  InboxCard,
  SendLine,
  useSender,
  type SendCommand,
} from './Inbox.js';

export interface NeedsYouProps {
  store: HuddleStore;
  state: HuddleState;
  renames: ReadonlyMap<AgentKey, string>;
  /** Show this agent in the main area (Open, or a click on the agent's name). */
  onAgent: (key: AgentKey) => void;
  /** The deep-linked item (`#item=`): opened once, highlighted, scrolled into view and focused once. */
  selectedId: string | null;
  /** Who a session is, for the place line (sidebar titles). */
  identity: (rootKey: AgentKey) => SessionIdentity | null;
  /** Fixed clock for tests; otherwise one 1 s tick here for every card. */
  now?: number;
}

function rootOf(state: HuddleState, item: AttentionItem): AgentKey | null {
  const agent = Object.hasOwn(state.agents, item.agentKey) ? state.agents[item.agentKey] : undefined;
  return agent === undefined ? null : agentKey(agent.sessionId);
}

/** Time left for an approval or a question; the item's time when there is no limit. */
function Corner({ state, item, now }: { state: HuddleState; item: AttentionItem; now: number }) {
  const words =
    item.kind === 'approval' && item.approval
      ? approvalLimit(item.approval.expiresAt ?? null, now)
      : item.kind === 'question'
        ? questionLimit(state, item, now)
        : null;
  if (words === null)
    return (
      <span className="card-limit" title={clockTimeFull(item.createdAt)}>
        {clockTime(item.createdAt)}
      </span>
    );
  return (
    <span className="card-limit" title={words.title || undefined}>
      {words.text}
    </span>
  );
}

/** What is asked, on one line: the tool and its command, the first question, or the notice's detail. */
function Asked({ item }: { item: AttentionItem }) {
  if (item.approval)
    return (
      <>
        <p className="card-request need-asked">
          <span className="card-tool">{item.approval.toolName}</span>
          <span className="card-summary code" title={item.approval.summary}>
            {item.approval.summary || UNKNOWN}
          </span>
        </p>
        <HiddenCommandLine req={item.approval} />
      </>
    );
  const q = item.question?.questions[0]?.question;
  const text = q ?? (item.detail || item.title);
  return (
    <p className="need-asked need-line" title={text}>
      {text || UNKNOWN}
    </p>
  );
}

interface CompactProps {
  state: HuddleState;
  item: AttentionItem;
  renames: ReadonlyMap<AgentKey, string>;
  onCommand: SendCommand;
  onOpen: () => void;
  onAgent: (key: AgentKey) => void;
  who: SessionIdentity | null;
  now: number;
  /**
   * A warning (stuck, loop, conflict, budget) in the sidebar: one row (glyph, agent, kind, Open), no frame. Nothing
   * on it can be answered, so it does not need a card's height; the place and detail are in its tooltip.
   */
  line?: boolean;
}

/** One item as a compact card. Allow and Deny only for an approval; every item can be opened. */
export function CompactCard({
  state,
  item,
  renames,
  onCommand,
  onOpen,
  onAgent,
  who,
  now,
  line = false,
}: CompactProps) {
  const look = glyphFor(item);
  const arming = useArming(item.id);
  const raw = itemControls(state, item);
  const approve = armControl(raw.approve, arming.armed);
  const deny = armControl(raw.deny, arming.armed);
  const sender = useSender(onCommand);
  const req = item.kind === 'approval' ? item.approval : undefined;

  const allow = () => {
    if (!req) return;
    arming.guard(() => {
      sender.send(allowCommand(req.requestId), 'Allow');
    });
  };
  const denyNow = () => {
    if (!req) return;
    arming.guard(() => {
      sender.send(denyCommand(req.requestId, ''), 'Deny');
    });
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const action = compactKeyAction(e.key, req ? { approve, deny } : null);
    if (action === null) return;
    if (action === 'open') onOpen();
    else if (sender.busy !== null) return;
    else if (action === 'allow') allow();
    else denyNow();
    e.preventDefault();
  };

  if (line && !req)
    return (
      <article
        className={`need-card need-row kind-${item.kind}`}
        aria-label={`${kindWords(item)}: ${item.title}`}
        title={[itemPlace(who, waitedWords(item, now)), item.detail || item.title].filter(Boolean).join('\n')}
        data-item={item.id}
        onKeyDown={onKey}
      >
        <span className={`glyph tone-${look.tone}`} aria-hidden="true">
          {look.glyph}
        </span>
        <AgentName state={state} agentKey={item.agentKey} renames={renames} onAgent={onAgent} />
        <span className="card-kind tone-needs-you">{kindWords(item)}</span>
        <ControlButton
          control={{ enabled: true, reason: null }}
          onPress={onOpen}
          variant="quiet"
          shortcut="O"
          hint="Show the whole item and its agent"
        >
          Open
        </ControlButton>
      </article>
    );

  return (
    <article
      className={`card need-card kind-${item.kind}`}
      aria-label={`${kindWords(item)}: ${item.title}`}
      data-item={item.id}
      onKeyDown={onKey}
    >
      <header className="card-head">
        <span className={`glyph tone-${look.tone}`} aria-hidden="true">
          {look.glyph}
        </span>
        <AgentName state={state} agentKey={item.agentKey} renames={renames} onAgent={onAgent} />
        <span className="card-kind tone-needs-you">{kindWords(item)}</span>
        <Corner state={state} item={item} now={now} />
      </header>
      <div className="card-body">
        <p className="need-place need-line" title={who?.projectPath ?? undefined}>
          {itemPlace(who, waitedWords(item, now))}
        </p>
        <Asked item={item} />
        <div className="card-actions">
          {req && (
            <>
              <ControlButton
                control={approve}
                onPress={allow}
                variant="primary"
                shortcut="A"
                hint="Allow this call"
                busy={sender.busy !== null}
              >
                Allow
              </ControlButton>
              <ControlButton
                control={deny}
                onPress={denyNow}
                shortcut="D"
                hint="Deny this call (Open to add a note for the agent)"
                busy={sender.busy !== null}
              >
                Deny
              </ControlButton>
            </>
          )}
          <ControlButton
            control={{ enabled: true, reason: null }}
            onPress={onOpen}
            variant="quiet"
            shortcut="O"
            hint="Show the whole request and its agent"
          >
            Open
          </ControlButton>
        </div>
        {req && raw.approve.reason !== null && raw.approve.reason === raw.deny.reason && (
          <p className="card-reason">{raw.approve.reason}</p>
        )}
        <SendLine s={sender} />
      </div>
    </article>
  );
}

export function NeedsYou({ store, state, renames, onAgent, selectedId, identity, now: fixedNow }: NeedsYouProps) {
  const ticking = useNow(fixedNow === undefined ? 1000 : null);
  const now = fixedNow ?? ticking;
  const groups = needsYouGroups(state, treeOptions(state));
  const openCount = groups.waiting.length + groups.warnings.length;
  const recent = recentItems(state, selectedId);
  // What the link asks for is applied once, when it arrives (React's "adjust state on a prop change"); after that the
  // card and the list open and close like any other.
  const [opened, setOpened] = useState<ReadonlySet<string>>(() =>
    selectedId !== null && linkedOpening(state, selectedId) === 'open' ? new Set([selectedId]) : new Set(),
  );
  const [showRecent, setShowRecent] = useState(
    () => selectedId !== null && linkedOpening(state, selectedId) === 'recent',
  );
  const [showOlder, setShowOlder] = useState(() => groups.older.some((i) => i.id === selectedId));
  const [seenLink, setSeenLink] = useState<string | null>(selectedId);
  if (selectedId !== seenLink) {
    setSeenLink(selectedId);
    if (selectedId !== null) {
      const opening = linkedOpening(state, selectedId);
      if (opening === 'open') {
        setOpened((prev) => new Set(prev).add(selectedId));
        if (groups.older.some((i) => i.id === selectedId)) setShowOlder(true);
      } else if (opening === 'recent') setShowRecent(true);
    }
  }
  const selectedRef = useRef<HTMLDivElement | null>(null);
  const focusedFor = useRef<string | null>(null);
  const onCommand: SendCommand = (cmd) => store.command(cmd);

  // Scroll to and focus the linked card once, when it is drawn (it may take a render to open).
  useEffect(() => {
    if (selectedId === null) {
      focusedFor.current = null;
      return;
    }
    if (focusedFor.current === selectedId) return;
    const el = selectedRef.current;
    const target = el?.querySelector<HTMLElement>('[data-item][tabindex]');
    if (!el || !target) return;
    focusedFor.current = selectedId;
    if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
    target.focus({ preventScroll: true });
  });

  const flip = (id: string, to: boolean) => {
    setOpened((prev) => {
      const next = new Set(prev);
      if (to) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const renderItem = (item: AttentionItem, line = false) => {
    const selected = item.id === selectedId;
    const root = rootOf(state, item);
    return (
      <div key={item.id} className="need-slot" ref={selected ? selectedRef : undefined}>
        {opened.has(item.id) ? (
          <>
            <InboxCard
              state={state}
              item={item}
              renames={renames}
              onCommand={onCommand}
              onAgent={onAgent}
              selected={selected}
              now={now}
            />
            <button
              type="button"
              className="quiet-button need-less"
              onClick={() => {
                flip(item.id, false);
              }}
            >
              Show less
            </button>
          </>
        ) : (
          <CompactCard
            state={state}
            item={item}
            renames={renames}
            onCommand={onCommand}
            onAgent={onAgent}
            onOpen={() => {
              flip(item.id, true);
              if (Object.hasOwn(state.agents, item.agentKey)) onAgent(item.agentKey);
            }}
            who={root === null ? null : identity(root)}
            now={now}
            line={line}
          />
        )}
      </div>
    );
  };

  const recentLink =
    recent.length > 0 ? (
      <button
        type="button"
        className="link-button need-recent-link"
        aria-expanded={showRecent}
        onClick={() => {
          setShowRecent(!showRecent);
        }}
      >
        {showRecent ? 'Hide recently handled' : `Recently handled (${String(recent.length)})`}
      </button>
    ) : null;
  const recentList =
    showRecent && recent.length > 0 ? (
      <div className="need-group" role="group" aria-label="Recently handled">
        {recent.map((item) => (
          <div key={item.id} className="need-slot" ref={item.id === selectedId ? selectedRef : undefined}>
            <HandledCard
              store={store}
              state={state}
              item={item}
              renames={renames}
              onCommand={onCommand}
              onAgent={onAgent}
              selected={item.id === selectedId}
              now={now}
            />
          </div>
        ))}
      </div>
    ) : null;
  const olderToggle =
    groups.older.length > 0 ? (
      <button
        type="button"
        className="quiet-button need-older-link"
        aria-expanded={showOlder}
        title="Open items of sessions that ended or that the Huddle has not heard from since it started"
        onClick={() => {
          setShowOlder(!showOlder);
        }}
      >
        {olderWords(groups.older.length, showOlder)}
      </button>
    ) : null;

  // Nothing waiting: at most one quiet line for what was handled (and what is older), no header, no empty groups.
  if (openCount === 0) {
    if (recentLink === null && olderToggle === null) return null;
    return (
      <section className="needs-you is-quiet" aria-label="Recently handled and older items">
        {recentLink}
        {recentList}
        {olderToggle}
        {showOlder && groups.older.length > 0 && (
          <div className="need-group" role="group" aria-label="Older items">
            {groups.older.map((i) => renderItem(i, true))}
          </div>
        )}
      </section>
    );
  }

  return (
    <section className="needs-you" aria-label="Needs you">
      {/* The badge counts what waits on you, the same number as the title bar and Home's "Need you" card;
          warnings carry their own count, so the two never read as one total (walkthrough 2026-11-16). */}
      <h2 className="side-title">
        Needs you
        {groups.waiting.length > 0 && (
          <>
            {' '}
            <span className="side-badge" aria-label={`${String(groups.waiting.length)} waiting on you`}>
              {String(groups.waiting.length)}
            </span>
          </>
        )}
      </h2>
      {groups.waiting.length > 0 && (
        <div className="need-group" role="group" aria-label="Waiting on you">
          {/* "Needs you" already says it; the subheading only earns its line when Warnings follow. */}
          {(groups.warnings.length > 0 || olderToggle !== null) && <h3 className="need-sub">Waiting on you</h3>}
          {groups.waiting.map((i) => renderItem(i))}
        </div>
      )}
      {(groups.warnings.length > 0 || olderToggle !== null) && (
        <div className="need-group" role="group" aria-label="Warnings">
          {groups.warnings.length > 0 && (
            <h3 className="need-sub">
              Warnings <span className="need-sub-count">{String(groups.warnings.length)}</span>
            </h3>
          )}
          {groups.warnings.map((i) => renderItem(i, true))}
          {olderToggle}
          {showOlder && groups.older.map((i) => renderItem(i, true))}
        </div>
      )}
      {recentLink}
      {recentList}
    </section>
  );
}
