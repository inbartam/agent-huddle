/**
 * File conflict detector (F21). Raised by `stepConflict`; resolved by `stepConflict` (agents ended) or `tickConflict`
 * (the window passed).
 *
 * An edit is a Write, Edit, MultiEdit or NotebookEdit call that finished (a denied or failed edit changed nothing). Its
 * time is the tool.finished ts; a call without a toolUseId counts at its start. Reads never count.
 * Raise: two different agents edited the same file under the same session cwd within `conflictWindowMinutes`. The
 *   other agent counts only while it has not ended and is not waiting on a foreground subagent: a main agent that
 *   edits a file and then hands it to a subagent, or fixes up a finished subagent's work, is a handoff, not a
 *   conflict. Sessions whose cwd is unknown (no session.started seen) are not checked.
 * Item: `conflict:<cwd>:<path>` with both forms normalized (forward slashes, no trailing slash, lower case for
 *   Windows drive and UNC paths). One per file at a time; later edits extend it without a new item.
 * Resolve: `conflictWindowMinutes` after the last edit of the file while in conflict, or as soon as fewer than two of
 *   the agents involved are still running.
 */
import type { AgentKey, AttentionItem, DetectorSettings, HuddleEvent } from '@huddle/shared';
import { atLeast, MINUTE_MS, minutesText, raisedEvent, resolvedEvent, without, type DetectorEmit } from './common.js';
import { plain } from '../text.js';
import { hasOpenSpawn, type LifeState } from './lifecycle.js';

/** Tools that write a file. Read, Glob and Grep also carry paths but never conflict. */
export const EDIT_TOOLS: ReadonlySet<string> = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

interface Edit {
  agentKey: AgentKey;
  sessionId: string;
  ts: number;
  eventId: string;
}

interface FileEdits {
  /** Display path (as the agent wrote it, already clipped by the normalizer). */
  path: string;
  /** Latest edit per agent, oldest first. */
  edits: Edit[];
}

interface OpenConflict {
  /** Agents involved, first editor first. */
  agents: AgentKey[];
  sessionId: string;
  agentKey: AgentKey;
  lastEditTs: number;
  lastEditEventId: string;
}

interface PendingEdit {
  itemId: string;
  path: string;
}

export interface ConflictState {
  /** Edit calls started but not yet finished, by agent and toolUseId. */
  pending: Record<AgentKey, Record<string, PendingEdit>>;
  /** Recent edits by item id (one entry per cwd + file). */
  files: Record<string, FileEdits>;
  /** Open conflict items by item id. */
  open: Record<string, OpenConflict>;
}

export function emptyConflict(): ConflictState {
  return { pending: {}, files: {}, open: {} };
}

/** Forward slashes, no trailing slash; lower case for Windows paths (C:\..., \\server\...), which ignore case. */
export function normalizePath(path: string): string {
  let p = path.replace(/\\/g, '/');
  if (p.length > 1) p = p.replace(/\/+$/, '');
  if (/^[A-Za-z]:/.test(p) || p.startsWith('//')) p = p.toLowerCase();
  return p;
}

export function conflictItemId(cwd: string, path: string): string {
  return `conflict:${normalizePath(cwd)}:${normalizePath(path)}`;
}

function windowMs(thresholds: DetectorSettings): number {
  return atLeast(thresholds.conflictWindowMinutes, 0) * MINUTE_MS;
}

/** May an edit by this agent still conflict with another agent's? */
function counts(life: LifeState, agentKey: AgentKey): boolean {
  const agent = life.agents[agentKey];
  return agent !== undefined && agent.phase !== 'ended' && !hasOpenSpawn(agent);
}

function baseName(path: string): string {
  const parts = normalizePath(path).split('/');
  return parts[parts.length - 1] ?? path;
}

function recordEdit(
  state: ConflictState,
  life: LifeState,
  itemId: string,
  path: string,
  edit: Edit,
  thresholds: DetectorSettings,
  emit: DetectorEmit[],
): ConflictState {
  const limit = windowMs(thresholds);
  const previous = state.files[itemId]?.edits ?? [];
  const recent = previous.filter((e) => e.agentKey !== edit.agentKey && edit.ts - e.ts <= limit);
  const files = { ...state.files, [itemId]: { path, edits: [...recent, edit] } };
  const others = recent.filter((e) => counts(life, e.agentKey));

  const open = state.open[itemId];
  if (open !== undefined) {
    if (others.length === 0) return { ...state, files };
    const agents = open.agents.includes(edit.agentKey) ? open.agents : [...open.agents, edit.agentKey];
    return {
      ...state,
      files,
      open: { ...state.open, [itemId]: { ...open, agents, lastEditTs: edit.ts, lastEditEventId: edit.eventId } },
    };
  }
  if (others.length === 0) return { ...state, files };

  const agents = [...others.map((e) => e.agentKey), edit.agentKey];
  const item: AttentionItem = {
    id: itemId,
    kind: 'file_conflict',
    severity: 'warning',
    agentKey: edit.agentKey,
    title: plain(`${String(agents.length)} agents edited ${baseName(path)}`),
    detail: plain(`${path} was edited by ${String(agents.length)} agents within ${minutesText(limit)}.`),
    createdAt: edit.ts,
    resolvedAt: null,
    relatedAgentKeys: agents,
  };
  emit.push(raisedEvent({ sessionId: edit.sessionId, agentKey: edit.agentKey, ts: edit.ts }, item, edit.eventId));
  return {
    ...state,
    files,
    open: {
      ...state.open,
      [itemId]: {
        agents,
        sessionId: edit.sessionId,
        agentKey: edit.agentKey,
        lastEditTs: edit.ts,
        lastEditEventId: edit.eventId,
      },
    },
  };
}

function dropPending(state: ConflictState, agentKey: AgentKey, toolUseId: string | null): ConflictState {
  const mine = state.pending[agentKey];
  if (mine === undefined) return state;
  if (toolUseId === null) return { ...state, pending: without(state.pending, agentKey) };
  if (!(toolUseId in mine)) return state;
  const rest = without(mine, toolUseId);
  return {
    ...state,
    pending: Object.keys(rest).length === 0 ? without(state.pending, agentKey) : { ...state.pending, [agentKey]: rest },
  };
}

export function stepConflict(
  state: ConflictState,
  life: LifeState,
  event: HuddleEvent,
  thresholds: DetectorSettings,
  ended: readonly AgentKey[],
): { state: ConflictState; emit: DetectorEmit[] } {
  const emit: DetectorEmit[] = [];
  let next = state;

  if (ended.length > 0) {
    for (const key of ended) next = dropPending(next, key, null);
    let files = next.files;
    for (const [id, file] of Object.entries(files)) {
      const edits = file.edits.filter((e) => !ended.includes(e.agentKey));
      if (edits.length === file.edits.length) continue;
      files = edits.length === 0 ? without(files, id) : { ...files, [id]: { ...file, edits } };
    }
    let open = next.open;
    for (const id of Object.keys(open).sort()) {
      const conflict = open[id];
      if (conflict === undefined || !conflict.agents.some((k) => ended.includes(k))) continue;
      const running = conflict.agents.filter((k) => life.agents[k] !== undefined && life.agents[k].phase !== 'ended');
      if (running.length >= 2) continue;
      emit.push(
        resolvedEvent({ sessionId: conflict.sessionId, agentKey: conflict.agentKey, ts: event.ts }, id, event.id),
      );
      open = without(open, id);
    }
    next = { ...next, files, open };
  }

  const agent = life.agents[event.agentKey];
  switch (event.type) {
    case 'tool.started': {
      if (!EDIT_TOOLS.has(event.toolName) || event.filePath === null) break;
      if (agent === undefined || agent.phase === 'ended') break;
      const cwd = life.sessionCwd[event.sessionId] ?? null;
      if (cwd === null) break;
      const itemId = conflictItemId(cwd, event.filePath);
      if (event.toolUseId === null) {
        const edit: Edit = { agentKey: event.agentKey, sessionId: event.sessionId, ts: event.ts, eventId: event.id };
        next = recordEdit(next, life, itemId, event.filePath, edit, thresholds, emit);
        break;
      }
      next = {
        ...next,
        pending: {
          ...next.pending,
          [event.agentKey]: { ...next.pending[event.agentKey], [event.toolUseId]: { itemId, path: event.filePath } },
        },
      };
      break;
    }
    case 'tool.finished': {
      if (event.toolUseId === null) break;
      const pending = next.pending[event.agentKey]?.[event.toolUseId];
      if (pending === undefined) break;
      next = dropPending(next, event.agentKey, event.toolUseId);
      const edit: Edit = { agentKey: event.agentKey, sessionId: event.sessionId, ts: event.ts, eventId: event.id };
      next = recordEdit(next, life, pending.itemId, pending.path, edit, thresholds, emit);
      break;
    }
    case 'tool.failed':
      next = dropPending(next, event.agentKey, event.toolUseId);
      break;
    case 'turn.ended':
    case 'turn.failed':
      // No finish will follow for calls still open at a turn end.
      next = dropPending(next, event.agentKey, null);
      break;
    default:
      break;
  }
  return { state: next, emit };
}

/** Resolve conflicts whose window passed at `now`, and forget edits older than the window. */
export function tickConflict(
  state: ConflictState,
  now: number,
  thresholds: DetectorSettings,
): { state: ConflictState; emit: DetectorEmit[] } {
  const limit = windowMs(thresholds);
  const emit: DetectorEmit[] = [];
  let open = state.open;
  for (const id of Object.keys(state.open).sort()) {
    const conflict = state.open[id];
    if (conflict === undefined || now - conflict.lastEditTs < limit) continue;
    emit.push(
      resolvedEvent(
        { sessionId: conflict.sessionId, agentKey: conflict.agentKey, ts: now },
        id,
        conflict.lastEditEventId,
      ),
    );
    open = without(open, id);
  }
  let files = state.files;
  for (const [id, file] of Object.entries(state.files)) {
    const edits = file.edits.filter((e) => now - e.ts < limit);
    if (edits.length === file.edits.length) continue;
    files = edits.length === 0 ? without(files, id) : { ...files, [id]: { ...file, edits } };
  }
  if (open === state.open && files === state.files) return { state, emit };
  return { state: { ...state, open, files }, emit };
}
