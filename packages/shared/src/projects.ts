/**
 * The main window's sidebar (main window redesign): sessions grouped by project, live work first, ended and stale
 * sessions under "Earlier", harness and empty runs hidden unless the user asks for all; and Home's three counts.
 * Pure: state and options in, views out. No clock is read (stale needs `huddleStartedAt`, passed in).
 *
 * Rules (one place, so the sidebar, Home and the title bar agree):
 *  - Project of a session: `selectProjectPath` (a Huddle worktree run → its repository; else the folder the session
 *    started in; else its cwd). Paths are compared normalised (`projectKey`: `/` separators, no trailing separator,
 *    lower case for Windows drive and UNC paths). A path inside another session's project folder is folded into the
 *    outermost such folder ("C:\work\api\src" goes under "C:\work\api" when a session ran in "C:\work\api"). Only
 *    sessions that are not harness runs can take others in, so the ids do not change with "Show all", and never a
 *    folder too broad to be one project (`isTooBroadFolder`). Unknown → "No folder".
 *  - Earlier: the session ended, or it is stale (not heard from since the Huddle started). Everything else is live.
 *  - Harness (`isHarnessSession`): an empty session (see there) or one in a scratch folder the developer exit-check scripts
 *    create (`huddle-m3-work-…`, `huddle-m4-repo-…`, `huddle-s16-repo-…`, `huddle-s16-wt-…`, `huddle-s17-repo-…`,
 *    `huddle-s18-work-…`). Hidden only without `showAll`, only once it is no longer live, and never while one of its
 *    agents waits on the user.
 *  - Counts: working = agents `starting` or `working` in live sessions; needs you = `selectNeedsYouCount` (agents
 *    waiting for an approval or an answer, stale sessions left out; the projects' `needsYouCount`s add up to it);
 *    stuck = open, not dismissed inbox items of kind `stuck` or `loop` of sessions that are neither ended nor stale.
 *
 * Every string here may come from an agent, a hook or a path on disk: render it as text.
 */
import { pathBasename, selectProjectPath } from './identity.js';
import type { AgentKey, AgentNode, AgentStatus, HuddleState } from './model.js';
import { selectNeedsYouCount, selectTree, type SessionView, type TreeOptions } from './selectors.js';

/** The name of the group for sessions whose folder is unknown. */
export const NO_FOLDER = 'No folder';
/** `ProjectView.id` of that group (never a normalised path: those are never empty). */
export const NO_FOLDER_ID = '';
/** An empty session lived at most this long (start to end, or to its last event): longer, and it was a real one. */
export const EMPTY_SESSION_MAX_MS = 60_000;

export interface ProjectView {
  /**
   * `projectKey` of the project folder; NO_FOLDER_ID for "No folder". Use it as a React key: it does not change with
   * `showAll` (harness sessions never take other sessions in).
   */
  id: string;
  /** Folder name of the project, or NO_FOLDER. */
  name: string;
  /** The project folder as a shown session reported it (for a tooltip); null for "No folder". */
  path: string | null;
  /** Live sessions: those with an agent at work or waiting first, then the most recently active. */
  sessions: SessionView[];
  /** Ended and stale sessions, most recently active first. */
  earlier: SessionView[];
  /** Agents starting or working in this project's live sessions. */
  workingCount: number;
  /** Agents waiting for an approval or an answer in this project (stale sessions left out). */
  needsYouCount: number;
  /** Latest activity of its shown sessions. */
  lastActivityAt: number;
  /** Sessions left out as harness or empty runs (0 with `showAll`). */
  hiddenCount: number;
}

export interface ProjectOptions extends TreeOptions {
  /** Show harness and empty sessions too (the sidebar's "Show all" toggle). Default false. */
  showAll?: boolean;
}

export interface HomeCounts {
  /** Agents starting or working in live sessions. */
  working: number;
  /** `selectNeedsYouCount(state, opts)`. */
  needsYou: number;
  /** Open, not dismissed inbox items of kind stuck or loop, of sessions neither ended nor stale. */
  stuck: number;
}

const WORKING: ReadonlySet<AgentStatus> = new Set<AgentStatus>(['starting', 'working']);
const WAITING: ReadonlySet<AgentStatus> = new Set<AgentStatus>(['waiting_approval', 'waiting_answer']);
const BUSY: ReadonlySet<AgentStatus> = new Set<AgentStatus>([
  'starting',
  'working',
  'waiting_approval',
  'waiting_answer',
  'paused',
]);

function getOwn<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/**
 * A path in the form projects are compared by: trimmed, `\` → `/`, repeated separators collapsed (a UNC `//` prefix
 * kept), no trailing separator, and lower case for a Windows drive or UNC path (those file systems ignore case).
 * Null for null or blank.
 */
export function projectKey(path: string | null | undefined): string | null {
  if (path === null || path === undefined) return null;
  const trimmed = path.trim();
  if (trimmed === '') return null;
  const slashed = trimmed.replace(/\\/g, '/');
  const unc = slashed.startsWith('//');
  let out = (unc ? '/' : '') + slashed.replace(/\/{2,}/g, '/');
  if (out.length > 1) out = out.replace(/\/+$/, '');
  if (out === '') out = '/';
  const windows = unc || /^[A-Za-z]:(\/|$)/.test(out);
  return windows ? out.toLowerCase() : out;
}

/** True when `inner` is `outer` or a folder below it (both `projectKey`s). */
function isWithin(inner: string, outer: string): boolean {
  if (inner === outer) return true;
  const prefix = outer.endsWith('/') ? outer : `${outer}/`;
  return inner.startsWith(prefix);
}

/** Folders right under a home folder that hold many projects. */
const HOME_COLLECTIONS: ReadonlySet<string> = new Set(['documents', 'desktop', 'downloads', 'source', 'repos']);

/**
 * A folder too broad to be one project, so it never takes in the sessions below it (a `projectKey`):
 *  - a drive or file-system root, a top-level folder (`C:\projects`, `/srv`), a UNC share root (`\\server\share`);
 *  - a home folder (`C:\Users\me`, `/home/me`, `/Users/me`), and under it Documents, Desktop, Downloads, source,
 *    source\repos, repos, a OneDrive root (`OneDrive`, `OneDrive - Contoso`) and its Documents or Desktop;
 *  - the same below a WSL drive mount (`/mnt/c`, `/mnt/c/Users/me/Documents`).
 */
export function isTooBroadFolder(key: string): boolean {
  let parts = key.split('/').filter((p) => p !== '');
  if (key.startsWith('//')) return parts.length <= 2;
  if (/^[a-z]:$/i.test(parts[0] ?? '')) parts = parts.slice(1);
  else if (parts[0]?.toLowerCase() === 'mnt' && /^[a-z]$/i.test(parts[1] ?? '')) parts = parts.slice(2);
  if (parts.length <= 1) return true;
  const top = (parts[0] ?? '').toLowerCase();
  if (top !== 'users' && top !== 'home') return false;
  const under = parts.slice(2).map((p) => p.toLowerCase());
  if (under.length === 0) return true;
  const [first, second] = under;
  if (first === undefined) return true;
  const oneDrive = first === 'onedrive' || first.startsWith('onedrive - ');
  if (under.length === 1) return HOME_COLLECTIONS.has(first) || oneDrive;
  if (under.length === 2) {
    if (first === 'source' && second === 'repos') return true;
    if (oneDrive && (second === 'documents' || second === 'desktop')) return true;
  }
  return false;
}

/** The scratch folders the developer exit-check scripts run `claude` in (`fs.mkdtemp` adds six characters; S16 worktrees eight hex). */
const SCRATCH_FOLDER = /^huddle-(?:(?:m3-work|m4-repo|s16-repo|s17-repo|s18-work)-[A-Za-z0-9]{6}|s16-wt-[0-9a-f]{8})$/i;

function inScratchFolder(path: string | null | undefined): boolean {
  const key = projectKey(path);
  return key !== null && key.split('/').some((segment) => SCRATCH_FOLDER.test(segment));
}

/**
 * A session the sidebar can hide (see `selectProjects` for when it does):
 *  - empty: one agent, no tool call, no typed prompt, its start was seen (`sessionCwd` known, so not a session the
 *    Huddle only heard the end of), and it lived at most EMPTY_SESSION_MAX_MS (opened and closed again). A session
 *    attached late, or one left open a while, is a real one.
 *  - or it ran in a scratch folder of the developer exit-check scripts.
 */
export function isHarnessSession(state: HuddleState, view: SessionView): boolean {
  const root = getOwn(state.agents, view.rootKey);
  if (root === undefined) return false;
  if (inScratchFolder(root.sessionCwd ?? root.cwd) || inScratchFolder(selectProjectPath(state, root.key))) return true;
  const noPrompt = (root.firstPrompt ?? null) === null && (root.lastPrompt ?? null) === null;
  const startSeen = (root.sessionCwd ?? null) !== null;
  const lived = (root.endedAt ?? view.lastActivityAt) - root.startedAt;
  return view.agentCount <= 1 && root.toolCalls === 0 && noPrompt && startSeen && lived <= EMPTY_SESSION_MAX_MS;
}

function isLive(view: SessionView): boolean {
  return !view.ended && view.stale !== true;
}

function sessionAgents(state: HuddleState, rootKey: AgentKey): AgentNode[] {
  const out: AgentNode[] = [];
  const seen = new Set<AgentKey>();
  const walk = (key: AgentKey): void => {
    if (seen.has(key)) return;
    seen.add(key);
    const node = getOwn(state.agents, key);
    if (node === undefined) return;
    out.push(node);
    for (const child of node.childKeys) walk(child);
  };
  walk(rootKey);
  return out;
}

function countIn(state: HuddleState, view: SessionView, statuses: ReadonlySet<AgentStatus>): number {
  return sessionAgents(state, view.rootKey).filter((n) => statuses.has(n.status)).length;
}

/** Hidden: without `showAll`, a harness session that is no longer live and has no agent waiting on the user. */
function isHidden(state: HuddleState, view: SessionView, showAll: boolean): boolean {
  if (showAll || isLive(view)) return false;
  if (countIn(state, view, WAITING) > 0) return false;
  return isHarnessSession(state, view);
}

function isBusy(view: SessionView): boolean {
  for (const [status, n] of Object.entries(view.statusCounts))
    if (n > 0 && BUSY.has(status as AgentStatus)) return true;
  return false;
}

const byRecent = (a: SessionView, b: SessionView): number =>
  b.lastActivityAt - a.lastActivityAt || (a.rootKey < b.rootKey ? -1 : a.rootKey > b.rootKey ? 1 : 0);

interface Group {
  id: string;
  path: string | null;
  /** Rank of the session `path` came from: a real one beats a harness one, then the most recent. */
  pathRank: [number, number];
  sessions: SessionView[];
  earlier: SessionView[];
  workingCount: number;
  needsYouCount: number;
  lastActivityAt: number;
  hiddenCount: number;
}

/**
 * The sidebar's projects, each with its live sessions and its Earlier ones. Order: projects with something waiting on
 * the user, then projects with an agent working, then the most recently active; ties by id. A project whose every
 * session is hidden is left out (its sessions count in `selectHiddenSessionCount`).
 */
export function selectProjects(state: HuddleState, opts?: ProjectOptions): ProjectView[] {
  const tree = selectTree(state, opts);
  const showAll = opts?.showAll === true;

  const own = new Map<AgentKey, { key: string | null; path: string | null; harness: boolean }>();
  for (const view of tree) {
    const path = selectProjectPath(state, view.rootKey);
    own.set(view.rootKey, { key: projectKey(path), path, harness: isHarnessSession(state, view) });
  }
  // Fold targets: the folders of sessions that are not harness runs, outermost first, never a too-broad one.
  const roots = [...new Set([...own.values()].filter((o) => !o.harness && o.key !== null).map((o) => o.key ?? ''))]
    .filter((k) => !isTooBroadFolder(k))
    .sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
  const fold = (key: string): string => roots.find((r) => isWithin(key, r)) ?? key;

  const groups = new Map<string, Group>();
  for (const view of tree) {
    const mine = own.get(view.rootKey) ?? { key: null, path: null, harness: false };
    const id = mine.key === null ? NO_FOLDER_ID : fold(mine.key);
    let group = groups.get(id);
    if (group === undefined) {
      group = {
        id,
        path: null,
        pathRank: [-1, -Infinity],
        sessions: [],
        earlier: [],
        workingCount: 0,
        needsYouCount: 0,
        lastActivityAt: -Infinity,
        hiddenCount: 0,
      };
      groups.set(id, group);
    }
    if (isHidden(state, view, showAll)) {
      group.hiddenCount += 1;
      continue;
    }
    const live = isLive(view);
    if (view.stale !== true) group.needsYouCount += countIn(state, view, WAITING);
    if (live) group.workingCount += countIn(state, view, WORKING);
    group.lastActivityAt = Math.max(group.lastActivityAt, view.lastActivityAt);
    // The display path: from a shown session that ran in the project folder itself, a real one first, then recent.
    const rank: [number, number] = [mine.harness ? 0 : 1, view.lastActivityAt];
    const [r0, r1] = group.pathRank;
    if (mine.key === id && mine.path !== null && (rank[0] > r0 || (rank[0] === r0 && rank[1] > r1))) {
      group.path = mine.path;
      group.pathRank = rank;
    }
    (live ? group.sessions : group.earlier).push(view);
  }

  const out: ProjectView[] = [];
  for (const g of groups.values()) {
    if (g.sessions.length === 0 && g.earlier.length === 0) continue;
    g.sessions.sort((a, b) => Number(isBusy(b)) - Number(isBusy(a)) || byRecent(a, b));
    g.earlier.sort(byRecent);
    // A shown session inside the project folder but none in it (its own session hidden): the name is the folder's.
    const name = g.id === NO_FOLDER_ID ? NO_FOLDER : (pathBasename(g.path) ?? pathBasename(g.id) ?? NO_FOLDER);
    out.push({
      id: g.id,
      name,
      path: g.id === NO_FOLDER_ID ? null : (g.path ?? g.id),
      sessions: g.sessions,
      earlier: g.earlier,
      workingCount: g.workingCount,
      needsYouCount: g.needsYouCount,
      lastActivityAt: g.lastActivityAt,
      hiddenCount: g.hiddenCount,
    });
  }
  return out.sort(
    (a, b) =>
      Number(b.needsYouCount > 0) - Number(a.needsYouCount > 0) ||
      Number(b.workingCount > 0) - Number(a.workingCount > 0) ||
      b.lastActivityAt - a.lastActivityAt ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/** Sessions `selectProjects(state, opts)` hides (0 with `showAll`): what the "Show all" toggle would add. */
export function selectHiddenSessionCount(state: HuddleState, opts?: ProjectOptions): number {
  const showAll = opts?.showAll === true;
  let n = 0;
  for (const view of selectTree(state, opts)) if (isHidden(state, view, showAll)) n += 1;
  return n;
}

/** Home's three counts and the title bar's live counts. */
export function selectHomeCounts(state: HuddleState, opts?: TreeOptions): HomeCounts {
  const tree = selectTree(state, opts);
  let working = 0;
  for (const view of tree) if (isLive(view)) working += countIn(state, view, WORKING);
  // Detectors resolve stuck and loop items when the agent ends; an ended or stale session's items are left out anyway.
  const notLive = new Set(tree.filter((v) => !isLive(v)).map((v) => v.sessionId));
  let stuck = 0;
  for (const item of state.inbox) {
    if (item.resolvedAt !== null || item.dismissed === true) continue;
    if (item.kind !== 'stuck' && item.kind !== 'loop') continue;
    const sessionId = getOwn(state.agents, item.agentKey)?.sessionId;
    if (sessionId !== undefined && notLive.has(sessionId)) continue;
    stuck += 1;
  }
  return { working, needsYou: selectNeedsYouCount(state, opts), stuck };
}
