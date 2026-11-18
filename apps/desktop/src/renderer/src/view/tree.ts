/**
 * Layout of the team tree: turns the shared `selectTree` output (SessionView / TreeNodeView, ADR-016)
 * into the flat list of rows the tree draws. Ordering, nesting, links and dimming come from the
 * selectors; this file only decides rails, expansion and the "Finished" group. Pure, so render tests
 * and the widget share it.
 *
 * Rails (DESIGN.md, "the one bold thing"):
 *  - each child row draws an elbow from its parent's trunk; solid when the link is exact, dashed
 *    while it is a best guess (heuristic or unknown);
 *  - a rail's colour is the most urgent status in the subtree it leads to, so a waiting subagent
 *    lights the whole path up to its root;
 *  - finished subagents (done, failed, stopped) with no live descendants move to a dimmed
 *    "Finished" group under their session until the session itself ends.
 */
import { isTerminal, type AgentKey, type AgentStatus, type SessionView, type TreeNodeView } from '@huddle/shared';
import { mostUrgent } from './status.js';

export type RailLink = 'exact' | 'heuristic';

/** One vertical rail passing through a row at an ancestor's depth. null: nothing at that depth. */
export type PassRail = AgentStatus | null;

export interface TreeRow {
  kind: 'agent';
  key: AgentKey;
  node: TreeNodeView;
  session: SessionView;
  /** 0 for a session's main agent and for rows in the Finished group. */
  depth: number;
  /** Rails from ancestors that continue past this row (index = column, 0..depth-2). */
  pass: PassRail[];
  /** For depth > 0: the elbow from the parent trunk into this row. */
  elbow: { status: AgentStatus; link: RailLink; continues: AgentStatus | null } | null;
  /** For rows with visible children: the stub from this row's glyph down to its first child. */
  stub: AgentStatus | null;
  hasChildren: boolean;
  expanded: boolean;
  /** Shown in the dimmed Finished group. */
  finished: boolean;
}

export interface GroupRow {
  kind: 'finished-label';
  key: string;
  count: number;
  rootKey: AgentKey;
}

export type Row = TreeRow | GroupRow;

export function railLink(node: TreeNodeView): RailLink {
  return node.link === 'exact' ? 'exact' : 'heuristic';
}

/**
 * Most urgent status in a node's subtree (the node included). A stale node's last status is history, so it
 * colours its rails as idle: a request from before the restart must not light a path up to the root.
 */
export function subtreeStatus(node: TreeNodeView): AgentStatus {
  if (node.stale === true) return 'idle';
  return mostUrgent([node.status, ...node.children.map(subtreeStatus)]) ?? node.status;
}

/**
 * The status a collapsed session row shows: the most urgent status among its live agents (from the
 * selector's counts), else the main agent's own. Finished subagents do not colour the session, so an
 * idle session with a failed helper reads "idle", not "failed"; the failure stays in its tree.
 */
export function sessionStatus(session: SessionView): AgentStatus {
  const live = (Object.keys(session.statusCounts) as AgentStatus[]).filter(
    (s) => session.statusCounts[s] > 0 && !isTerminal(s),
  );
  return mostUrgent(live) ?? session.root.status;
}

function hasLiveDescendant(node: TreeNodeView): boolean {
  return node.children.some((c) => !isTerminal(c.status) || hasLiveDescendant(c));
}

/** Subagents that sit in the Finished group rather than in the live tree. */
function isParked(node: TreeNodeView): boolean {
  return node.kind !== 'main' && isTerminal(node.status) && !hasLiveDescendant(node);
}

function flatten(node: TreeNodeView): TreeNodeView[] {
  return [node, ...node.children.flatMap(flatten)];
}

export interface BuildOptions {
  /** Rows the user flipped away from their default expansion. */
  toggled: ReadonlySet<AgentKey>;
  /** Sessions start collapsed (the widget: one row per session until the user opens it). */
  rootsCollapsed?: boolean;
}

/**
 * Defaults: subagents open; a live session open (unless rootsCollapsed); an ended session closed.
 * `toggled` holds the rows the user flipped away from that default.
 */
export function isExpanded(
  node: TreeNodeView,
  session: SessionView,
  toggled: ReadonlySet<AgentKey>,
  rootsCollapsed = false,
): boolean {
  const defaultOpen = node.kind !== 'main' || (!rootsCollapsed && !session.ended);
  return toggled.has(node.key) ? !defaultOpen : defaultOpen;
}

export function buildRows(sessions: readonly SessionView[], options: BuildOptions): Row[] {
  const rows: Row[] = [];

  for (const session of sessions) {
    const parked: TreeNodeView[] = [];

    const walk = (node: TreeNodeView, depth: number, pass: PassRail[], elbow: TreeRow['elbow']) => {
      const visibleKids: TreeNodeView[] = [];
      for (const c of node.children) {
        if (isParked(c)) parked.push(...flatten(c));
        else visibleKids.push(c);
      }
      const expanded = isExpanded(node, session, options.toggled, options.rootsCollapsed);
      const showKids = expanded && visibleKids.length > 0;
      rows.push({
        kind: 'agent',
        key: node.key,
        node,
        session,
        depth,
        pass,
        elbow,
        stub: showKids ? mostUrgent(visibleKids.map(subtreeStatus)) : null,
        hasChildren: visibleKids.length > 0,
        expanded,
        finished: false,
      });
      if (!showKids) return;
      visibleKids.forEach((child, i) => {
        // A child at depth d+1 carries rails for columns 0..d-1: the parent's own pass-through rails
        // plus the parent's trunk, which continues to the parent's later siblings.
        const childPass = depth >= 1 ? [...pass, elbow?.continues ?? null] : [];
        walk(child, depth + 1, childPass, {
          status: subtreeStatus(child),
          link: railLink(child),
          // The trunk below child i serves children i+1..n, so it takes their most urgent status.
          continues: mostUrgent(visibleKids.slice(i + 1).map(subtreeStatus)),
        });
      });
    };

    walk(session.root, 0, [], null);
    if (!isExpanded(session.root, session, options.toggled, options.rootsCollapsed) || parked.length === 0) continue;

    parked.sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt));
    rows.push({
      kind: 'finished-label',
      key: `${session.rootKey}#finished`,
      count: parked.length,
      rootKey: session.rootKey,
    });
    for (const node of parked) {
      rows.push({
        kind: 'agent',
        key: node.key,
        node,
        session,
        depth: 0,
        pass: [],
        elbow: null,
        stub: null,
        hasChildren: false,
        expanded: false,
        finished: true,
      });
    }
  }
  return rows;
}

/**
 * The rows to flip in `toggled` so that `key` is visible: every collapsed ancestor (the session root included)
 * opens. Returns the same set when nothing needs to change, or when `key` is not in any session.
 */
export function revealToggles(
  sessions: readonly SessionView[],
  key: AgentKey,
  toggled: ReadonlySet<AgentKey>,
  rootsCollapsed = false,
): ReadonlySet<AgentKey> {
  for (const session of sessions) {
    const path = pathTo(session.root, key);
    if (path === null) continue;
    let next: Set<AgentKey> | null = null;
    // Every node above the target must be expanded; the target itself keeps its own state.
    for (const node of path.slice(0, -1)) {
      if (isExpanded(node, session, next ?? toggled, rootsCollapsed)) continue;
      next ??= new Set(toggled);
      if (next.has(node.key)) next.delete(node.key);
      else next.add(node.key);
    }
    return next ?? toggled;
  }
  return toggled;
}

function pathTo(node: TreeNodeView, key: AgentKey): TreeNodeView[] | null {
  if (node.key === key) return [node];
  for (const child of node.children) {
    const rest = pathTo(child, key);
    if (rest !== null) return [node, ...rest];
  }
  return null;
}

/** Only the agent rows (no group labels), e.g. for keyboard navigation. */
export function agentRows(rows: readonly Row[]): TreeRow[] {
  return rows.filter((r): r is TreeRow => r.kind === 'agent');
}
