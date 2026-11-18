/**
 * Desktop toasts (F14). Pure part: `toastFor` turns one inbox item or one event into at most one toast, and
 * `planToasts` picks which toasts a batch raises (one per item id, ever; at most a few per batch). Thin part:
 * `createToastNotifier` watches the core's batches and shows them with Electron's built-in `Notification`
 * (no native module, ADR-003).
 *
 * Every string in a toast came from an agent or a hook, so it is untrusted: control characters are removed,
 * whitespace collapsed and the text clipped. A toast is plain text; Electron builds the Windows toast XML and
 * escapes it. Bodies carry what the inbox already shows in one line (the command, the question), never file contents.
 *
 * A click shows the main window on the item (`#item=<id>`) or, for a finished turn, on the agent (`#agent=<key>`).
 */
import {
  DEFAULT_USER_SETTINGS,
  isAgentKeyFormat,
  selectAgentLabel,
  agentRoleKind,
  ROLE_PROFILES,
  type RoleKindOverrides,
  type AgentKey,
  type AgentNode,
  type AttentionItem,
  type HuddleEvent,
  type HuddleState,
  type ToastSettings,
  type UserSettings,
} from '@huddle/shared';

export interface Toast {
  title: string;
  body: string;
  /** The inbox item a click opens, or null. */
  itemId: string | null;
  /** The agent a click selects when there is no item (a finished turn), or null. */
  agentKey: AgentKey | null;
  /** Dedupe key: a toast with the same key is shown once per Huddle run. */
  key: string;
}

export const TOAST_TITLE_MAX = 80;
export const TOAST_BODY_MAX = 240;
/** At most this many toasts per batch; the rest are folded into one "N more" toast. */
export const TOASTS_PER_BATCH = 3;
/** The seen-key memory is bounded; the oldest keys are forgotten first. */
export const TOAST_MEMORY = 2000;
/**
 * Item ids that may go into `#item=`: the detectors' ids carry a cwd and a file path (`conflict:<cwd>:<path>`), so
 * the bound is two paths plus a prefix. Must match `ITEM_ID_MAX` in renderer/src/view/deep-link.ts.
 */
export const ITEM_ID_MAX = 2100;

// eslint-disable-next-line no-control-regex -- the point is to strip control characters
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]+/g;
// eslint-disable-next-line no-control-regex -- same set without /g (test() on a /g regex keeps state)
const HAS_CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/;

/** Plain, one-line, clipped text. Never throws. */
export function toastText(text: string, max: number): string {
  const flat = text.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** Same rule as the renderer's `isItemIdFormat`: 1..ITEM_ID_MAX characters, no control characters. */
export function isItemIdFormat(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > ITEM_ID_MAX) return false;
  return !HAS_CONTROL.test(value);
}

function nameOf(agents: Readonly<Record<AgentKey, AgentNode>> | undefined, key: AgentKey): string {
  const node = agents && Object.hasOwn(agents, key) ? agents[key] : undefined;
  // A main agent is named like its session on the card (F2): its nickname or session title, else its project folder.
  const label =
    node && agents
      ? (selectAgentLabel({ agents, rootKeys: Object.keys(agents), inbox: [], rateLimits: null }, key) ?? node.name)
      : '';
  const name = toastText(label, 48);
  return name === '' ? 'An agent' : name;
}

function make(title: string, body: string, key: string, itemId: string | null, agentKey: AgentKey | null): Toast {
  return {
    title: toastText(title, TOAST_TITLE_MAX),
    body: toastText(body, TOAST_BODY_MAX),
    itemId: itemId !== null && isItemIdFormat(itemId) ? itemId : null,
    agentKey: agentKey !== null && isAgentKeyFormat(agentKey) ? agentKey : null,
    key,
  };
}

/** "Review ready" for a reviewer, "Plan ready" for a planner; null for a general agent (2026-11-18). */
function finishedWords(
  agents: Readonly<Record<AgentKey, AgentNode>> | undefined,
  key: AgentKey,
  roleKinds: RoleKindOverrides | undefined,
): string | null {
  const node = agents && Object.hasOwn(agents, key) ? agents[key] : undefined;
  if (node === undefined) return null;
  const kind = agentRoleKind(node, roleKinds);
  return kind === 'general' ? null : ROLE_PROFILES[kind].finished;
}

function toastForItem(
  item: AttentionItem,
  toasts: ToastSettings,
  agents: Readonly<Record<AgentKey, AgentNode>> | undefined,
  roleKinds?: RoleKindOverrides,
): Toast | null {
  if (item.resolvedAt !== null) return null;
  const who = nameOf(agents, item.agentKey);
  const key = `item:${item.id}`;
  const detail = item.detail !== '' ? item.detail : item.title;
  switch (item.kind) {
    case 'approval': {
      if (!toasts.approval) return null;
      const a = item.approval;
      const body = a ? `${a.toolName}: ${a.summary}` : detail;
      return make(`${who} needs approval`, body, key, item.id, item.agentKey);
    }
    case 'question': {
      if (!toasts.question) return null;
      const qs = item.question?.questions ?? [];
      const first = qs[0]?.question ?? detail;
      const more = qs.length > 1 ? ` (+${String(qs.length - 1)} more)` : '';
      return make(`${who} asked a question`, `${first}${more}`, key, item.id, item.agentKey);
    }
    case 'stuck':
      return toasts.stuck ? make(`${who} looks stuck`, detail, key, item.id, item.agentKey) : null;
    case 'loop':
      return toasts.loop ? make(`${who} may be in a loop`, detail, key, item.id, item.agentKey) : null;
    case 'file_conflict': {
      if (!toasts.conflict) return null;
      const others = (item.relatedAgentKeys ?? []).filter((k) => k !== item.agentKey).map((k) => nameOf(agents, k));
      const title = others.length > 0 ? `File conflict: ${who} and ${others.join(', ')}` : `File conflict: ${who}`;
      return make(title, detail, key, item.id, item.agentKey);
    }
    case 'error':
      return toasts.doneOrError ? make(`${who} failed`, detail, key, item.id, item.agentKey) : null;
    case 'finished': {
      if (!toasts.doneOrError) return null;
      const words = finishedWords(agents, item.agentKey, roleKinds);
      return make(words !== null ? `${who}: ${words}` : `${who} finished`, detail, key, item.id, item.agentKey);
    }
    // F19: the budget detector's title already names whose budget and how far ("The session budget of X is nearly used").
    case 'budget':
      return toasts.budget ? make(item.title, detail, key, item.id, item.agentKey) : null;
    // 2026-11-18: the detector's title names the type ("A reviewer is changing files").
    case 'role_drift':
      return toasts.roleDrift !== false ? make(`${who}: ${item.title}`, detail, key, item.id, item.agentKey) : null;
    // context_high has no switch: no toast.
    case 'context_high':
      return null;
  }
}

function toastForEvent(
  event: HuddleEvent,
  toasts: ToastSettings,
  agents: Readonly<Record<AgentKey, AgentNode>> | undefined,
  roleKinds?: RoleKindOverrides,
): Toast | null {
  if (event.type === 'attention.raised') return toastForItem(event.item, toasts, agents, roleKinds);
  // Finished and failed turns: main agents only (subagents finish all the time and are reported to their parent).
  if (event.agentKey !== event.sessionId) return null;
  if (event.type === 'turn.ended') {
    if (!toasts.doneOrError) return null;
    // Still has subagents running in the background: the session is not waiting for the user yet.
    if (Array.isArray(event.backgroundAgentIds) && event.backgroundAgentIds.length > 0) return null;
    const who = nameOf(agents, event.agentKey);
    return make(`${who} finished its turn`, 'Waiting for your next prompt.', `event:${event.id}`, null, event.agentKey);
  }
  if (event.type === 'turn.failed') {
    if (!toasts.doneOrError) return null;
    const who = nameOf(agents, event.agentKey);
    const body = event.error ?? 'The turn ended with an error.';
    return make(`${who} failed`, body, `event:${event.id}`, null, event.agentKey);
  }
  return null;
}

/** Is it an inbox item (as opposed to an event)? Items have a `kind`, events a `type`. */
function isItem(source: AttentionItem | HuddleEvent): source is AttentionItem {
  return 'kind' in source && !('type' in source);
}

/**
 * Pure: the toast for one inbox item or one event, or null (switched off, resolved, or a kind that never toasts).
 * One toast per attention kind: approval, question, stuck, loop, conflict, done/error. `agents` supplies names.
 */
export function toastFor(
  source: AttentionItem | HuddleEvent,
  settings: Pick<UserSettings, 'toasts' | 'roleKinds'> = DEFAULT_USER_SETTINGS,
  agents?: Readonly<Record<AgentKey, AgentNode>>,
): Toast | null {
  return isItem(source)
    ? toastForItem(source, settings.toasts, agents, settings.roleKinds)
    : toastForEvent(source, settings.toasts, agents, settings.roleKinds);
}

/** Bounded set of toast keys already shown (insertion order = age). */
export class SeenKeys {
  private readonly keys = new Set<string>();
  constructor(private readonly limit = TOAST_MEMORY) {}
  has(key: string): boolean {
    return this.keys.has(key);
  }
  add(key: string): void {
    this.keys.add(key);
    while (this.keys.size > this.limit) {
      const oldest = this.keys.values().next();
      if (oldest.done) break;
      this.keys.delete(oldest.value);
    }
  }
}

export interface ToastBatchInput {
  batch: readonly HuddleEvent[];
  state: Pick<HuddleState, 'agents' | 'inbox'>;
  settings: Pick<UserSettings, 'toasts'>;
  /** Epoch ms: items created and events stamped before this are history (a replayed log), never toasted. */
  since: number;
}

/**
 * Pure apart from `seen`, which it updates: the toasts one batch raises. Candidates are the open inbox items and the
 * batch's events (an item seen both ways is one toast). At most TOASTS_PER_BATCH; past that one "N more" toast.
 */
export function planToasts(input: ToastBatchInput, seen: SeenKeys): Toast[] {
  const fresh: Toast[] = [];
  const keys = new Set<string>();
  const consider = (toast: Toast | null) => {
    if (!toast || seen.has(toast.key) || keys.has(toast.key)) return;
    keys.add(toast.key);
    fresh.push(toast);
  };
  for (const item of input.state.inbox) {
    if (item.createdAt >= input.since) consider(toastFor(item, input.settings, input.state.agents));
  }
  for (const event of input.batch) {
    if (event.ts >= input.since) consider(toastFor(event, input.settings, input.state.agents));
  }
  // Every candidate is remembered, including folded ones: a storm never comes back one toast at a time.
  for (const t of fresh) seen.add(t.key);
  if (fresh.length <= TOASTS_PER_BATCH) return fresh;
  const shown = fresh.slice(0, TOASTS_PER_BATCH - 1);
  const rest = fresh.length - shown.length;
  return [
    ...shown,
    make(`${String(rest)} more need you`, 'Open Agent Huddle to see them.', `more:${String(input.since)}`, null, null),
  ];
}

// ---------------------------------------------------------------------------------------------------------------------
// Thin adapter
// ---------------------------------------------------------------------------------------------------------------------

/** What the notifier needs from Electron's `Notification`: show a toast, call back on click. */
export type ShowToast = (toast: Toast, onClick: () => void) => void;

export interface ToastNotifierDeps {
  getState: () => Pick<HuddleState, 'agents' | 'inbox'>;
  getSettings: () => Pick<UserSettings, 'toasts'>;
  show: ShowToast;
  /** The user clicked a toast. */
  onClick: (toast: Toast) => void;
  now?: () => number;
}

/** Feed it every batch the core emits. */
export function createToastNotifier(deps: ToastNotifierDeps): (batch: readonly HuddleEvent[]) => void {
  const since = (deps.now ?? Date.now)();
  const seen = new SeenKeys();
  return (batch) => {
    let toasts: Toast[];
    try {
      toasts = planToasts({ batch, state: deps.getState(), settings: deps.getSettings(), since }, seen);
    } catch {
      return; // a toast is never worth breaking the event path
    }
    for (const toast of toasts) {
      deps.show(toast, () => {
        deps.onClick(toast);
      });
    }
  };
}

/** The Electron `Notification` surface used here (injected so this file stays testable without Electron). */
export interface NotificationLike {
  on(event: 'click' | 'close' | 'failed', listener: () => void): unknown;
  show(): void;
}
export interface NotificationApi {
  isSupported(): boolean;
  create(options: { title: string; body: string; silent: boolean }): NotificationLike;
}

/**
 * Show toasts with Electron's built-in Notification. Live notifications are kept referenced until clicked or closed:
 * on Windows an unreferenced Notification can be garbage-collected and its click handler lost.
 */
export function electronShowToast(api: NotificationApi): ShowToast {
  const live = new Set<NotificationLike>();
  return (toast, onClick) => {
    if (!api.isSupported()) return;
    const n = api.create({ title: toast.title, body: toast.body, silent: false });
    live.add(n);
    const forget = () => live.delete(n);
    n.on('click', () => {
      forget();
      onClick();
    });
    n.on('close', forget);
    n.on('failed', forget);
    n.show();
  };
}

/**
 * The URL that opens `itemId` in a main window showing `currentUrl`: same page, only the fragment changed
 * (`#item=<id>`), so it is a same-document navigation. Null for a malformed id or URL.
 */
export function mainUrlLinkingItem(currentUrl: string, itemId: string): string | null {
  if (!isItemIdFormat(itemId)) return null;
  try {
    const url = new URL(currentUrl);
    url.hash = `item=${encodeURIComponent(itemId)}`;
    return url.href;
  } catch {
    return null;
  }
}
