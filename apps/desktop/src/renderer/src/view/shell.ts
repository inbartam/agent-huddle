/**
 * The main window's shell (main window redesign, WP2): which place the main area shows, the icon rail's items, the
 * sidebar width, and how the sidebar words its sessions, projects and Needs you groups. Pure: state, identities and
 * `now` come in, words and lists go out, so render tests and the window share them.
 */
import {
  selectTree,
  startedAgo,
  type AttentionItem,
  type ControlState,
  type HomeCounts,
  type HuddleState,
  type ProjectView,
  type SessionIdentity,
  type TreeOptions,
} from '@huddle/shared';
import { plural, UNKNOWN } from './format.js';
import { openItems } from './inbox.js';

/**
 * What the main area shows: the rail's places (Home, History, Library, Settings), a session picked in the sidebar,
 * Home's Today list or a toast (`session`), and "+ New run" or "Start a run" (`launch`). Ask lives on Home; the guide
 * is a dialog over whatever is showing, so neither is a place.
 */
export type Place = 'home' | 'history' | 'library' | 'settings' | 'session' | 'launch';

/** The places the icon rail lists. */
export type RailPlace = 'home' | 'history' | 'library' | 'settings' | 'guide';

export interface RailItem {
  place: RailPlace;
  /** The word under the icon. */
  label: string;
  /** The button's accessible name and tooltip, when the word alone says too little. */
  title: string;
  /** Sits at the bottom of the rail. */
  bottom?: boolean;
}

/** In DESIGN order: Home, History, Library (templates and rules), Settings; Guide at the bottom. */
export const RAIL_ITEMS: readonly RailItem[] = [
  { place: 'home', label: 'Home', title: 'Home' },
  { place: 'history', label: 'History', title: 'History: past runs and scorecards' },
  { place: 'library', label: 'Library', title: 'Library: templates and rules' },
  { place: 'settings', label: 'Settings', title: 'Settings' },
  { place: 'guide', label: 'Guide', title: 'Guide: what the Huddle shows', bottom: true },
];

/** The rail item marked current for a place; none for a session or a launch. Guide is a dialog, never current. */
export function railCurrent(place: Place): RailPlace | null {
  switch (place) {
    case 'home':
    case 'history':
    case 'library':
    case 'settings':
      return place;
    case 'session':
    case 'launch':
      return null;
  }
}

/** Library's tabs: Templates, Rules, the orchestrator's Skills (F28) and Tasks (F29), and agent types by Role. */
export type LibraryTab = 'templates' | 'rules' | 'skills' | 'tasks' | 'roles';
export const LIBRARY_TABS: readonly { id: LibraryTab; label: string }[] = [
  { id: 'templates', label: 'Templates' },
  { id: 'rules', label: 'Rules' },
  { id: 'skills', label: 'Skills' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'roles', label: 'Roles' },
];

// --- sidebar width ----------------------------------------------------------------------------------------------

export const RAIL_WIDTH = 56;
export const SIDEBAR_MIN = 280;
export const SIDEBAR_MAX = 420;
export const SIDEBAR_DEFAULT = 312;
/** What the main area keeps at the smallest window: 960 − 56 − 280 = 624 px, so the sidebar is 280 at 960. */
export const MAIN_MIN = 624;

export function clampSidebarWidth(px: number): number {
  if (!Number.isFinite(px)) return SIDEBAR_DEFAULT;
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(px)));
}

/**
 * The grid columns: rail, sidebar, splitter, main. The sidebar takes the user's width but gives way to the main area
 * on a narrow window, never below SIDEBAR_MIN (at the 960 px minimum it is 280).
 */
export function shellColumns(sidebarPx: number): string {
  const w = clampSidebarWidth(sidebarPx);
  return `${String(RAIL_WIDTH)}px max(${String(SIDEBAR_MIN)}px, min(${String(w)}px, calc(100vw - ${String(RAIL_WIDTH + MAIN_MIN)}px))) 0 minmax(0, 1fr)`;
}

/**
 * The splitter's keyboard: Left/Right by 16 px (40 with Shift), Home and End to the limits, starting from the width
 * as drawn (on a narrow window that is less than the stored one). Null for any other key.
 */
export function splitterKey(key: string, shift: boolean, drawn: number): number | null {
  const step = shift ? 40 : 16;
  if (key === 'ArrowLeft') return clampSidebarWidth(drawn - step);
  if (key === 'ArrowRight') return clampSidebarWidth(drawn + step);
  if (key === 'Home') return SIDEBAR_MIN;
  if (key === 'End') return SIDEBAR_MAX;
  return null;
}

// --- title bar counts -------------------------------------------------------------------------------------------

export interface CountWord {
  key: 'working' | 'needsYou' | 'stuck';
  glyph: string;
  /** Tone class suffix: loud only when the count asks for the user. */
  tone: 'working' | 'needs-you' | 'idle';
  loud: boolean;
  text: string;
}

/** The title bar's live counts: "● 3 working", "▲ 1 needs you", "! 0 stuck"; `—` before the first state. */
export function countWords(c: HomeCounts | null): CountWord[] {
  const n = (v: number | undefined) => (v === undefined ? UNKNOWN : String(v));
  const needs = c?.needsYou;
  const stuck = c?.stuck;
  return [
    {
      key: 'working',
      glyph: '●',
      tone: c && c.working > 0 ? 'working' : 'idle',
      loud: false,
      text: `${n(c?.working)} working`,
    },
    {
      key: 'needsYou',
      glyph: '▲',
      tone: needs !== undefined && needs > 0 ? 'needs-you' : 'idle',
      loud: needs !== undefined && needs > 0,
      text: `${n(needs)} ${needs === 1 ? 'needs' : 'need'} you`,
    },
    {
      key: 'stuck',
      glyph: '!',
      tone: stuck !== undefined && stuck > 0 ? 'needs-you' : 'idle',
      loud: false,
      text: `${n(stuck)} stuck`,
    },
  ];
}

// --- Needs you --------------------------------------------------------------------------------------------------

export interface NeedsYouGroups {
  /** Approvals, questions and anything else that needs action, the longest wait first. */
  waiting: AttentionItem[];
  /** Stuck, loop, file conflict, budget nearly and the other notices. */
  warnings: AttentionItem[];
  /**
   * Open items of sessions that ended or are stale (not heard from since the Huddle started): history, not something
   * to act on now. Kept out of the two groups and the badge, behind one quiet toggle (spec goal 2).
   */
  older: AttentionItem[];
}

/** True for an item that waits on the user (it goes under "Waiting on you"). */
export function isWaitingOnYou(item: AttentionItem): boolean {
  return item.kind === 'approval' || item.kind === 'question' || item.severity === 'action_required';
}

/**
 * The inbox's open items (same set and order as `openItems`), split into the two Needs you groups and the older ones.
 * An item whose agent the state does not know stays in the groups (nothing says it is old).
 */
export function needsYouGroups(state: HuddleState, opts?: TreeOptions): NeedsYouGroups {
  const notLive = new Set<string>();
  for (const view of selectTree(state, opts)) if (view.ended || view.stale === true) notLive.add(view.sessionId);
  const waiting: AttentionItem[] = [];
  const warnings: AttentionItem[] = [];
  const older: AttentionItem[] = [];
  for (const item of openItems(state)) {
    const agent = Object.hasOwn(state.agents, item.agentKey) ? state.agents[item.agentKey] : undefined;
    if (agent !== undefined && notLive.has(agent.sessionId)) older.push(item);
    else (isWaitingOnYou(item) ? waiting : warnings).push(item);
  }
  return { waiting, warnings, older };
}

/** The older toggle's words: "2 older (ended or from before the restart)". */
export function olderWords(n: number, shown: boolean): string {
  return shown ? `Hide ${plural(n, 'older item')}` : `${String(n)} older (ended or from before the restart)`;
}

/** How long an item has waited, in the sidebar's age words: "waiting 3m", "waiting yesterday"; "just now". */
export function waitedWords(item: AttentionItem, now: number): string {
  const ago = startedAgo(item.createdAt, now);
  return ago === 'just now' ? 'just now' : `waiting ${ago}`;
}

/** A compact card's place line: how long it waited · project · session title (the wait first, so a narrow sidebar keeps it). */
export function itemPlace(who: SessionIdentity | null, waited: string | null = null): string {
  const parts = [waited, who?.project ?? null, who?.label ?? null].filter((p): p is string => p !== null && p !== '');
  return parts.length > 0 ? parts.join(' · ') : UNKNOWN;
}

/** What a key does inside a focused compact card: A allows, D denies (approvals, when on), O opens. */
export function compactKeyAction(
  key: string,
  controls: { approve: ControlState; deny: ControlState } | null,
): 'allow' | 'deny' | 'open' | null {
  const k = key.toLowerCase();
  if (k === 'o') return 'open';
  if (controls === null) return null;
  if (k === 'a' && controls.approve.enabled) return 'allow';
  if (k === 'd' && controls.deny.enabled) return 'deny';
  return null;
}

/** What a toast's `#item=` link opens: the item's full card, the Recently handled list, or nothing it knows. */
export function linkedOpening(state: HuddleState, id: string): 'open' | 'recent' | null {
  const item = state.inbox.find((i) => i.id === id);
  if (item === undefined) return null;
  return item.resolvedAt === null ? 'open' : 'recent';
}

// --- projects and sessions --------------------------------------------------------------------------------------

/** A session row's second words in the sidebar: model · how long ago it started ("Opus 5.5 · 42m"). */
export function sessionMeta(who: SessionIdentity): string {
  const parts: string[] = [who.model ?? UNKNOWN, who.startedAgo];
  if (who.worktree) parts.push('worktree');
  return parts.join(' · ');
}

/** The Simple view's session row words: how long ago it started (and the worktree tag), so the name gets the room. */
export function sessionMetaSimple(who: SessionIdentity): string {
  return who.worktree ? `${who.startedAgo} · worktree` : who.startedAgo;
}

/** A project header's counts in words, for its accessible name. */
export function projectCountWords(p: ProjectView): string {
  const parts: string[] = [];
  if (p.workingCount > 0) parts.push(`${String(p.workingCount)} working`);
  if (p.needsYouCount > 0) parts.push(`${String(p.needsYouCount)} ${p.needsYouCount === 1 ? 'needs' : 'need'} you`);
  if (p.sessions.length === 0) parts.push('no live sessions');
  else parts.push(plural(p.sessions.length, 'live session'));
  return parts.join(', ');
}

/** Ended and stale sessions over every project: what "Earlier · N ended sessions" counts. */
export function earlierCount(projects: readonly ProjectView[]): number {
  let n = 0;
  for (const p of projects) n += p.earlier.length;
  return n;
}

/** "Earlier · 14 ended sessions". */
export function earlierWords(n: number): string {
  return `Earlier · ${plural(n, 'ended session')}`;
}

/** The "Show all" toggle's words: what it would add, or that it is on. */
export function showAllWords(showAll: boolean, hidden: number): string {
  return showAll ? 'Hide test and empty runs' : `Show all (${plural(hidden, 'hidden run')})`;
}

/**
 * Whether a project is open: what the user last chose for that project id, else open while it has a live session.
 * A choice is kept as it was made (not as a flip of the default), so a project the user opened stays open when its
 * last session ends.
 */
export function isProjectOpen(choices: ReadonlyMap<string, boolean>, p: ProjectView): boolean {
  return choices.get(p.id) ?? p.sessions.length > 0;
}
