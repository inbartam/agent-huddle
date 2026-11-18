/**
 * The command palette (F15, SPEC 3.3): the action list, fuzzy matching and keyboard navigation. Pure: the
 * component turns a chosen action into a command or a view change. Disabled actions stay listed with their reason
 * (from `selectControls` through view/inbox.ts) so the user sees why, but cannot be run.
 *
 * Deciding a request from the palette is guarded (M3 security review): the request the actions act on is the one at
 * the top when the palette opened (`PaletteOpened`), never whatever is on top when Enter lands; navigation comes first
 * so Ctrl+K, Enter never decides anything; and a guarded action runs from the keyboard only after the user typed or
 * moved to it.
 */
import {
  ASK_QUESTION_MAX,
  selectStaleSessionIds,
  type AgentKey,
  type AgentNode,
  type ControlState,
  type HuddleCommand,
  type HuddleState,
  type RoleKindOverrides,
} from '@huddle/shared';
import { agentLabel } from '../store.js';
import { allControl, allowCommand, denyCommand, itemControls, passThroughCommand, topApproval } from './inbox.js';
import { VIEW_MODE_WORDS, type ViewMode } from './prefs.js';
import { typeLabel } from './roles.js';
import { treeOptions } from './summary.js';

export type PaletteEffect =
  | { kind: 'command'; command: HuddleCommand }
  | { kind: 'select'; agentKey: AgentKey }
  | { kind: 'settings' }
  | { kind: 'team' }
  /** M4: the launch dialog, the template list, the rules. */
  | { kind: 'launch' }
  | { kind: 'templates' }
  | { kind: 'rules' }
  | { kind: 'roles' }
  /** M5: History, on its Runs or Scorecards tab. */
  | { kind: 'history'; tab: 'runs' | 'scorecards' }
  /** M5: Ask the Huddle, with this question in the box (null: empty). Opening it never sends anything. */
  | { kind: 'ask'; question: string | null }
  /** Switch between the Simple and Advanced view (a per-viewer choice, nothing is sent). */
  | { kind: 'viewMode'; mode: ViewMode };

export interface PaletteAction {
  id: string;
  label: string;
  /** A second line: the agent's role, the request, or why it is off. */
  hint: string;
  group: 'Actions' | 'Agents';
  control: ControlState;
  effect: PaletteEffect;
  /** Decides a request: Enter runs it only after the user typed something or moved to it (`paletteKey`). */
  guarded?: true;
}

/** What the palette saw when it opened. */
export interface PaletteOpened {
  /** The top approval's request id at that moment, or null when none was waiting. */
  topRequestId: string | null;
}

/** Take this when the palette opens and keep it until it closes. */
export function paletteOpened(state: HuddleState): PaletteOpened {
  return { topRequestId: topApproval(state)?.approval?.requestId ?? null };
}

export const PALETTE_REASONS = {
  topChanged: 'The top request changed since the palette opened. Reopen the palette to see it.',
  moveFirst: 'Type or use the arrow keys to pick this action first.',
} as const;

const ON: ControlState = { enabled: true, reason: null };

/** M4 panes (F16 to F18) and M5 History (F22, F24), after the top request so Ctrl+K, Enter still lands on navigation and never on a decision. */
const MANAGE_ACTIONS: readonly PaletteAction[] = [
  {
    id: 'launch',
    label: 'Launch…',
    hint: 'Start a run in a folder',
    group: 'Actions',
    control: ON,
    effect: { kind: 'launch' },
  },
  {
    id: 'templates',
    label: 'Templates',
    hint: 'Saved launch setups',
    group: 'Actions',
    control: ON,
    effect: { kind: 'templates' },
  },
  {
    id: 'rules',
    label: 'Rules',
    hint: 'What Huddle decides by itself, and the decision log',
    group: 'Actions',
    control: ON,
    effect: { kind: 'rules' },
  },
  {
    id: 'roles',
    label: 'Roles',
    hint: 'Agent types by role: reviewer, designer, builder and more',
    group: 'Actions',
    control: ON,
    effect: { kind: 'roles' },
  },
  {
    id: 'history',
    label: 'Show history',
    hint: 'Past runs: search, open, replay and report',
    group: 'Actions',
    control: ON,
    effect: { kind: 'history', tab: 'runs' },
  },
  {
    id: 'scorecards',
    label: 'Show scorecards',
    hint: 'How each role and model has done across your runs',
    group: 'Actions',
    control: ON,
    effect: { kind: 'history', tab: 'scorecards' },
  },
  {
    id: 'ask',
    label: 'Ask the Huddle…',
    hint: 'A question about your agents, answered by Haiku',
    group: 'Actions',
    control: ON,
    effect: { kind: 'ask', question: null },
  },
];

/**
 * Every action the palette offers for this state: the top request first (Open, then Allow, Deny, Pass), then Show the
 * selected agent, Open settings, Pause all, Resume all, the library and history actions, then agents (live sessions
 * first). The top request's actions act on
 * `opened.topRequestId`; when the top approval is now a different one (or gone), they stay listed but are off.
 */
export function paletteActions(
  state: HuddleState,
  renames: ReadonlyMap<AgentKey, string>,
  opened: PaletteOpened = paletteOpened(state),
  viewMode: ViewMode | null = null,
): PaletteAction[] {
  const other: ViewMode = viewMode === 'simple' ? 'advanced' : 'simple';
  // What waits on the user leads. Its first entry only navigates, so Enter on a fresh open never decides anything
  // (the decide actions are also `guarded`).
  const out: PaletteAction[] = [...topRequestActions(state, renames, opened)];
  out.push(
    {
      id: 'team',
      label: 'Show the selected agent',
      hint: 'Back to the selected agent',
      group: 'Actions',
      control: ON,
      effect: { kind: 'team' },
    },
    {
      id: 'settings',
      label: 'Open settings',
      hint: 'Notifications, detectors, questions, shortcut',
      group: 'Actions',
      control: ON,
      effect: { kind: 'settings' },
    },
    {
      id: 'all.pause',
      label: 'Pause all',
      hint: 'Every running agent stops at its next tool call',
      group: 'Actions',
      control: allControl(state, 'pause'),
      effect: { kind: 'command', command: { type: 'all.pause' } },
    },
    {
      id: 'all.resume',
      label: 'Resume all',
      hint: 'Every paused agent carries on',
      group: 'Actions',
      control: allControl(state, 'resume'),
      effect: { kind: 'command', command: { type: 'all.resume' } },
    },
  );
  out.push(...MANAGE_ACTIONS);
  if (viewMode !== null)
    out.push({
      id: 'viewMode',
      label: VIEW_MODE_WORDS.switchTo(other),
      hint: other === 'simple' ? VIEW_MODE_WORDS.simpleHint : VIEW_MODE_WORDS.advancedHint,
      group: 'Actions',
      control: ON,
      effect: { kind: 'viewMode', mode: other },
    });
  const stale = selectStaleSessionIds(state, treeOptions(state));
  const agents = Object.values(state.agents).sort(
    (a, b) =>
      Number(stale.has(a.sessionId)) - Number(stale.has(b.sessionId)) ||
      Number(a.endedAt !== null) - Number(b.endedAt !== null) ||
      b.lastEventAt - a.lastEventAt,
  );
  for (const a of agents) {
    out.push({
      id: `agent:${a.key}`,
      label: `Go to ${agentLabel(state, a, renames)}`,
      // A subagent's hint leads with its type, so typing "reviewer" finds every reviewer (2026-11-18).
      hint:
        a.kind === 'main' ? (a.lastPrompt ?? 'main agent of a session') : agentTypeHint(a, state.settings?.roleKinds),
      group: 'Agents',
      control: ON,
      effect: { kind: 'select', agentKey: a.key },
    });
  }
  return out;
}

const CHANGED: ControlState = { enabled: false, reason: PALETTE_REASONS.topChanged };

/** Allow, deny and pass for the request that was on top when the palette opened. None when there was none and is none. */
function topRequestActions(
  state: HuddleState,
  renames: ReadonlyMap<AgentKey, string>,
  opened: PaletteOpened,
): PaletteAction[] {
  const top = topApproval(state);
  const req = top?.approval;
  if (opened.topRequestId === null && req === undefined) return [];
  // The commands always name the request the user saw; a different (or no) top request turns them off.
  const requestId = opened.topRequestId ?? req?.requestId ?? '';
  const same = top !== null && req !== undefined && req.requestId === opened.topRequestId;
  const c = same ? itemControls(state, top) : { approve: CHANGED, deny: CHANGED, passThrough: CHANGED };
  const who = same && Object.hasOwn(state.agents, top.agentKey) ? state.agents[top.agentKey] : undefined;
  const hint = same ? `${who ? agentLabel(state, who, renames) : '—'}: ${req.toolName} ${req.summary}` : '—';
  const open: PaletteAction[] =
    same && who !== undefined
      ? [
          {
            id: 'top.open',
            label: 'Open the top request',
            hint,
            group: 'Actions',
            control: ON,
            effect: { kind: 'select', agentKey: who.key },
          },
        ]
      : [];
  return [
    ...open,
    {
      id: 'top.allow',
      label: 'Allow the top request',
      hint,
      group: 'Actions',
      control: c.approve,
      effect: { kind: 'command', command: allowCommand(requestId) },
      guarded: true,
    },
    {
      id: 'top.deny',
      label: 'Deny the top request',
      hint,
      group: 'Actions',
      control: c.deny,
      effect: { kind: 'command', command: denyCommand(requestId, '') },
      guarded: true,
    },
    {
      id: 'top.pass',
      label: 'Pass the top request to the terminal',
      hint,
      group: 'Actions',
      control: c.passThrough,
      effect: { kind: 'command', command: passThroughCommand(requestId) },
      guarded: true,
    },
  ];
}

/**
 * Fuzzy score of `query` against `text`: every query character must appear in order (case-insensitive). Runs of
 * consecutive characters and matches at the start of a word score higher. Null when it does not match.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.trim().toLowerCase();
  if (q === '') return 0;
  const t = text.toLowerCase();
  let score = 0;
  let ti = 0;
  let run = 0;
  for (const ch of q) {
    if (ch === ' ') continue;
    const found = t.indexOf(ch, ti);
    if (found === -1) return null;
    const wordStart = found === 0 || /[\s\-_:./\\]/.test(t[found - 1] ?? '');
    run = found === ti ? run + 1 : 0;
    score += 1 + run * 2 + (wordStart ? 3 : 0) - Math.min(3, found - ti) * 0.1;
    ti = found + 1;
  }
  return score;
}

function agentTypeHint(a: AgentNode, overrides: RoleKindOverrides | undefined): string {
  const label = typeLabel(a, overrides);
  return label === null ? a.role : `${label}: ${a.role}`;
}

/** Matching actions, best first; ties keep the list order (actions before agents). */
export function filterActions(actions: readonly PaletteAction[], query: string): PaletteAction[] {
  if (query.trim() === '') return [...actions];
  return actions
    .map((a, i) => ({ a, i, s: fuzzyScore(query, `${a.label} ${a.hint}`) }))
    .filter((x): x is { a: PaletteAction; i: number; s: number } => x.s !== null)
    .sort((x, y) => y.s - x.s || x.i - y.i)
    .map((x) => x.a);
}

export type PaletteKeyResult =
  | { kind: 'move'; index: number }
  | { kind: 'run'; action: PaletteAction }
  /** Enter on a disabled action, or on a guarded one too soon: nothing runs; `reason` says why. */
  | { kind: 'blocked'; action: PaletteAction; reason: string | null }
  | { kind: 'close' }
  | { kind: 'none' };

/**
 * What a key does in the palette. Up and Down wrap; Home and End jump; Enter runs; Escape closes. `deliberate` is true
 * once the user typed a query or moved the selection with a key; until then Enter does not run a guarded action
 * (it comes back `blocked` with `reason`).
 */
export function paletteKey(
  key: string,
  index: number,
  list: readonly PaletteAction[],
  deliberate = false,
): PaletteKeyResult {
  const n = list.length;
  switch (key) {
    case 'Escape':
      return { kind: 'close' };
    case 'ArrowDown':
      return n === 0 ? { kind: 'none' } : { kind: 'move', index: (index + 1) % n };
    case 'ArrowUp':
      return n === 0 ? { kind: 'none' } : { kind: 'move', index: (index - 1 + n) % n };
    case 'Home':
      return n === 0 ? { kind: 'none' } : { kind: 'move', index: 0 };
    case 'End':
      return n === 0 ? { kind: 'none' } : { kind: 'move', index: n - 1 };
    case 'Enter': {
      const action = list[Math.min(Math.max(0, index), n - 1)];
      if (action === undefined) return { kind: 'none' };
      if (!action.control.enabled) return { kind: 'blocked', action, reason: action.control.reason };
      if (action.guarded && !deliberate) return { kind: 'blocked', action, reason: PALETTE_REASONS.moveFirst };
      return { kind: 'run', action };
    }
    default:
      return { kind: 'none' };
  }
}

/** The no-match offer's label shows at most this much of the typed text. */
const OFFER_LABEL_MAX = 80;

/**
 * When the typed text matches nothing: "Ask the Huddle: “<text>”". It opens Ask with the text in the box (clipped to
 * ASK_QUESTION_MAX) and never sends it; only the Ask button sends. Null for empty text.
 */
export function askOffer(query: string): PaletteAction | null {
  const text = query.trim().slice(0, ASK_QUESTION_MAX);
  if (text === '') return null;
  const shown = text.length > OFFER_LABEL_MAX ? `${text.slice(0, OFFER_LABEL_MAX - 1)}…` : text;
  return {
    id: 'ask.offer',
    label: `Ask the Huddle: “${shown}”`,
    hint: 'Opens Ask with this question. Nothing is sent until you press Ask.',
    group: 'Actions',
    control: ON,
    effect: { kind: 'ask', question: text },
  };
}

/** What the palette lists: the matching actions, or the Ask offer when nothing matches the typed text. */
export function paletteList(actions: readonly PaletteAction[], query: string): PaletteAction[] {
  const list = filterActions(actions, query);
  if (list.length > 0) return list;
  const offer = askOffer(query);
  return offer ? [offer] : [];
}
