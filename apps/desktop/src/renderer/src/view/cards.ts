/**
 * The widget's session cards (Widget v2): one card per session, and which request waiting on the user renders
 * inline in which card. A request from a subagent shows on its session's card. Requests whose agent has no card
 * (not in state, or its session not listed) are returned as `orphans`, so the widget can pin them at the bottom:
 * no request may become unreachable. Pure.
 */
import {
  type AgentKey,
  type AgentNode,
  type AgentStatus,
  type AttentionItem,
  type HuddleState,
  type SessionView,
  type TreeNodeView,
} from '@huddle/shared';
import { kindWords, openItems } from './inbox.js';
import { sessionStatus } from './tree.js';

export interface CardNeed {
  /** The request to render inline, or null when an agent waits but no inbox item exists (yet). */
  item: AttentionItem | null;
  /** "needs approval", "asked a question", "needs an answer". */
  words: string;
  /** Who is waiting: the session's main agent or one of its subagents. */
  agentKey: AgentKey;
}

export interface SessionCardModel {
  session: SessionView;
  /** The session's main agent, when it is in state. */
  root: AgentNode | null;
  /** The status the card shows: the most urgent among its live agents. */
  status: AgentStatus;
  stale: boolean;
  /** The oldest request waiting on the user in this session, or null. */
  need: CardNeed | null;
  /** Further requests waiting in this session (reachable from the main window's inbox). */
  moreNeeds: number;
}

export interface WidgetCards {
  cards: SessionCardModel[];
  /** Open requests that need action but belong to no card. */
  orphans: AttentionItem[];
}

function getOwn<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function firstWaiting(node: TreeNodeView): TreeNodeView | null {
  if (node.status === 'waiting_approval' || node.status === 'waiting_answer') return node;
  for (const child of node.children) {
    const found = firstWaiting(child);
    if (found) return found;
  }
  return null;
}

export function widgetCards(state: HuddleState, sessions: readonly SessionView[]): WidgetCards {
  const bySession = new Map<string, AttentionItem[]>();
  const orphans: AttentionItem[] = [];
  const listed = new Map(sessions.map((s) => [s.sessionId, s]));
  for (const item of openItems(state)) {
    if (item.severity !== 'action_required') continue;
    const agent = getOwn(state.agents, item.agentKey);
    const session = agent ? listed.get(agent.sessionId) : undefined;
    if (session === undefined) {
      orphans.push(item);
      continue;
    }
    // A request from before the Huddle restarted cannot be answered from here (as pinnedItem): it stays in the main
    // window's inbox, where its controls say why.
    if (session.stale === true) continue;
    const list = bySession.get(session.sessionId) ?? [];
    list.push(item);
    bySession.set(session.sessionId, list);
  }

  const cards = sessions.map((session): SessionCardModel => {
    const stale = session.stale === true;
    const items = bySession.get(session.sessionId) ?? [];
    const [first] = items;
    let need: CardNeed | null = null;
    if (first !== undefined) {
      need = { item: first, words: kindWords(first), agentKey: first.agentKey };
    } else if (!stale) {
      const waiting = firstWaiting(session.root);
      if (waiting) {
        need = {
          item: null,
          words: waiting.status === 'waiting_answer' ? 'needs an answer' : 'needs approval',
          agentKey: waiting.key,
        };
      }
    }
    return {
      session,
      root: getOwn(state.agents, session.rootKey) ?? null,
      status: sessionStatus(session),
      stale,
      need,
      moreNeeds: Math.max(0, items.length - 1),
    };
  });
  // The glance order: whoever needs the user first, then live work, then the rest. A stable sort, so the incoming
  // order (most recently active first) holds inside each group. Without it a waiting session could sit below the fold.
  return { cards: orderCards(cards), orphans };
}

/** Cards by `cardRank`, keeping the given order inside a rank. Pure. */
export function orderCards<T extends Pick<SessionCardModel, 'stale' | 'need' | 'status'>>(cards: readonly T[]): T[] {
  return cards
    .map((card, i) => ({ card, i, r: cardRank(card) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.card);
}

/** 0 needs the user, 1 working or starting, 2 paused, 3 everything else (idle, done, failed, stopped), 4 stale. */
export function cardRank(card: Pick<SessionCardModel, 'stale' | 'need' | 'status'>): number {
  if (card.stale) return 4;
  if (card.need !== null) return 0;
  if (card.status === 'working' || card.status === 'starting') return 1;
  if (card.status === 'paused') return 2;
  return 3;
}
