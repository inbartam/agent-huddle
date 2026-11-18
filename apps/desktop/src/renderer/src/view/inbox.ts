/**
 * The inbox (M3: F10 approvals, F11 questions, F21 detectors) as the renderer shows it: which items, in what order,
 * which controls each card offers (always from the shared `selectControls`, never decided here), the commands the
 * buttons send, the time-limit words, and how a handled item ended (read from that agent's events).
 * Pure: `now` and the events are passed in.
 */
import {
  approvalTextHidden,
  CONTROL_REASONS,
  DEFAULT_USER_SETTINGS,
  isTerminal,
  selectControls,
  type AgentKey,
  type ApprovalRequest,
  type AskQuestion,
  type AttentionItem,
  type ControlState,
  type ControlsView,
  type HuddleCommand,
  type HuddleEvent,
  type HuddleState,
} from '@huddle/shared';
import { clockTime, UNKNOWN } from './format.js';

/** The line on an approval card whose summary does not show the whole command (AX-01, DESIGN "Words for interacting"). */
export const HIDDEN_COMMAND_WORDS =
  "Part of this command is hidden (masked or too long). Check the full command in the agent's terminal before allowing.";

/** HIDDEN_COMMAND_WORDS when the request's summary hides part of the command (`approvalTextHidden`), else null. */
export function hiddenCommandWords(req: ApprovalRequest | undefined): string | null {
  return req !== undefined && approvalTextHidden(req) ? HIDDEN_COMMAND_WORDS : null;
}

/** How many handled items stay visible under "Recently handled". */
export const RECENT_LIMIT = 5;

/** Open items: the ones that need action first, then oldest first (the longest wait is on top). */
export function openItems(state: HuddleState): AttentionItem[] {
  const rank = (i: AttentionItem) => (i.severity === 'action_required' ? 0 : i.severity === 'warning' ? 1 : 2);
  return state.inbox
    .filter((i) => i.resolvedAt === null)
    .sort((a, b) => rank(a) - rank(b) || a.createdAt - b.createdAt);
}

/** Handled items, newest first, at most RECENT_LIMIT; `keep` (a deep-linked item) is always included. */
export function recentItems(state: HuddleState, keep: string | null = null): AttentionItem[] {
  const handled = state.inbox
    .filter((i) => i.resolvedAt !== null)
    .sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0));
  const top = handled.slice(0, RECENT_LIMIT);
  const linked = keep === null ? undefined : handled.find((i) => i.id === keep);
  return linked !== undefined && !top.includes(linked) ? [linked, ...top] : top;
}

/** The top open approval (the palette's "allow top request"). */
export function topApproval(state: HuddleState): AttentionItem | null {
  return openItems(state).find((i) => i.kind === 'approval' && i.approval !== undefined) ?? null;
}

const ALL_OFF_AGENT_GONE: ControlState = { enabled: false, reason: CONTROL_REASONS.ended };

function allOff(state: ControlState): ControlsView {
  return {
    approve: state,
    deny: state,
    passThrough: state,
    answer: state,
    message: state,
    messageTurnEnd: state,
    pause: state,
    resume: state,
    cancelMessage: state,
  };
}

/** The controls for one inbox item, from `selectControls`. An item whose agent is not in state offers nothing. */
export function itemControls(state: HuddleState, item: AttentionItem): ControlsView {
  const agent = Object.hasOwn(state.agents, item.agentKey) ? state.agents[item.agentKey] : undefined;
  if (agent === undefined) return allOff(ALL_OFF_AGENT_GONE);
  return selectControls(agent, state.connection, state.connection?.startedAt, item);
}

/**
 * "Answer in terminal" on a question card. `selectControls` has no question pass-through of its own (its
 * `passThrough` is for approvals), so this reads its `answer` state: when the Huddle could answer, it can also step
 * aside; when the only reason it cannot answer is that two choices look the same here, stepping aside is exactly what
 * is left to do. Every other reason (not connected, ended, answered) keeps it off.
 */
export function questionTerminalControl(controls: ControlsView): ControlState {
  const a = controls.answer;
  if (a.enabled || a.reason === CONTROL_REASONS.ambiguousChoice) return { enabled: true, reason: null };
  return a;
}

/** Whether the card can take an answer at all: at least one question (each one has options, a typed answer, or both). */
export function questionHasPicks(questions: readonly AskQuestion[]): boolean {
  return questions.length > 0;
}

/** One question's answer on the card: chosen option labels (one for single-select) and the user's own words. */
export interface QuestionPick {
  labels: readonly string[];
  typed: string;
}

/** A pick is complete when it names an option or has typed words. */
export function pickComplete(p: QuestionPick | undefined): boolean {
  return p !== undefined && (p.labels.length > 0 || p.typed.trim() !== '');
}

/**
 * Clicking an option. Single-select: that option alone, typed words cleared (one or the other). Multi-select: the
 * option toggles, typed words kept (they follow the labels). Labels keep option order.
 */
export function togglePick(q: AskQuestion, p: QuestionPick | undefined, label: string): QuestionPick {
  if (!q.multiSelect) return { labels: [label], typed: '' };
  const cur = p?.labels ?? [];
  const next = cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label];
  const order = q.options.map((o) => o.label);
  return { labels: [...next].sort((a, b) => order.indexOf(a) - order.indexOf(b)), typed: p?.typed ?? '' };
}

/** Typing an own answer. Single-select: words replace the chosen option. */
export function typePick(q: AskQuestion, p: QuestionPick | undefined, typed: string): QuestionPick {
  if (!q.multiSelect && typed.trim() !== '') return { labels: [], typed };
  return { labels: p?.labels ?? [], typed };
}

/** What the card shows as sent: labels, then the typed words, per question; questions joined with " · ". */
export function pickSummary(picks: readonly QuestionPick[]): string {
  return picks.map((p) => [...p.labels, ...(p.typed.trim() === '' ? [] : [p.typed.trim()])].join(', ')).join(' · ');
}

// --- commands (the exact control.ts shapes) ---------------------------------------------------------------------

export function allowCommand(requestId: string): HuddleCommand {
  return { type: 'approval.decide', requestId, decision: 'allow' };
}

/** Deny, with the user's note when they wrote one (trimmed; an empty note sends no `message`). */
export function denyCommand(requestId: string, message: string): HuddleCommand {
  const note = message.trim();
  return note === ''
    ? { type: 'approval.decide', requestId, decision: 'deny' }
    : { type: 'approval.decide', requestId, decision: 'deny', message: note };
}

export function passThroughCommand(requestId: string): HuddleCommand {
  return { type: 'approval.passThrough', requestId };
}

/**
 * The answer command for a full card: per question its labels (a list for multi-select, one label otherwise) and
 * the typed words in `other` (S14 b: Claude Code takes labels joined with ", " and typed words verbatim; the broker
 * builds that from the raw payload).
 */
export function answersCommand(
  requestId: string,
  list: readonly { question: AskQuestion; pick: QuestionPick }[],
): HuddleCommand {
  const answers: Record<string, string | string[]> = {};
  const other: Record<string, string> = {};
  for (const { question, pick } of list) {
    if (pick.labels.length > 0)
      answers[question.question] = question.multiSelect ? [...pick.labels] : (pick.labels[0] ?? '');
    if (pick.typed.trim() !== '') other[question.question] = pick.typed.trim();
  }
  return Object.keys(other).length > 0
    ? { type: 'question.answer', requestId, answers, other }
    : { type: 'question.answer', requestId, answers };
}

export function dismissCommand(itemId: string): HuddleCommand {
  return { type: 'attention.dismiss', itemId };
}

// --- time limits ------------------------------------------------------------------------------------------------

/** "9:42" for a remaining time; "0:00" when it has passed; `—` when unknown. */
export function countdown(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return UNKNOWN;
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${String(h)}:${String(m).padStart(2, '0')}:${ss}` : `${String(m)}:${ss}`;
}

export interface LimitWords {
  /** Short: "~9:42 left, est." or "time limit unknown". */
  text: string;
  /** What happens then, for the tooltip. */
  title: string;
}

/** An approval's time limit (`expiresAt`, the hook timeout): after it Claude Code asks in the terminal. */
export function approvalLimit(expiresAt: number | null, now: number): LimitWords {
  if (expiresAt === null) {
    return { text: 'time limit unknown', title: "Huddle doesn't know when Claude Code stops waiting for it." };
  }
  const left = expiresAt - now;
  if (left <= 0) {
    return { text: 'time limit reached, est.', title: 'Claude Code has probably asked in the terminal by now.' };
  }
  return {
    text: `~${countdown(left)} left, est.`,
    title: "Estimated from Claude Code's time limit for an answer. After it, Claude Code asks in the terminal instead.",
  };
}

/**
 * When a held question is handed to the terminal: Huddle holds it for `questionHoldSeconds` (settings), never past
 * the hook timeout (`expiresAt`). Estimated, since the hold started when the hook arrived, not when the card showed.
 */
export function questionLimit(state: HuddleState, item: AttentionItem, now: number): LimitWords {
  const q = item.question;
  if (q === undefined) return { text: 'time limit unknown', title: '' };
  const holdMs = (state.settings ?? DEFAULT_USER_SETTINGS).questionHoldSeconds * 1000;
  const ends = [q.receivedAt + holdMs, ...(typeof q.expiresAt === 'number' ? [q.expiresAt] : [])];
  const left = Math.min(...ends) - now;
  if (left <= 0) {
    return { text: 'in the terminal now, est.', title: 'Huddle has probably handed this question to the terminal.' };
  }
  return {
    text: `terminal in ~${countdown(left)}, est.`,
    title: 'After this, Huddle steps aside and Claude Code shows its own question box in the terminal.',
  };
}

// --- how a handled item ended -----------------------------------------------------------------------------------

/**
 * Words for how an item ended, from its agent's events (`approval.resolved`, `question.answered`, `question.closed`,
 * `attention.resolved`). `answered` holds what Huddle answered, as `Question → label` pairs. Null when the events do
 * not say (then the card shows only when it was handled).
 */
export interface ItemEnding {
  text: string;
  /** Huddle's own answers to a question, shown as they will read in the terminal. */
  answered: { question: string; answer: string }[];
  /** The note sent with a deny. */
  note: string | null;
}

function requestIdOf(item: AttentionItem): string | null {
  return item.approval?.requestId ?? item.question?.requestId ?? null;
}

export function itemEnding(item: AttentionItem, events: readonly HuddleEvent[]): ItemEnding | null {
  const requestId = requestIdOf(item);
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e === undefined) continue;
    if (requestId !== null && e.type === 'approval.resolved' && e.requestId === requestId) {
      return { text: approvalEndingWords(e.outcome, e.by), answered: [], note: e.message };
    }
    if (requestId !== null && e.type === 'question.answered' && e.requestId === requestId) {
      const answered = Object.entries(e.answers).map(([question, a]) => ({
        question,
        answer: Array.isArray(a) ? a.join(', ') : a,
      }));
      return {
        text: 'Huddle answered. The terminal shows it as if you had typed it.',
        answered,
        note: null,
      };
    }
    if (requestId !== null && e.type === 'question.closed' && e.requestId === requestId) {
      return { text: QUESTION_CLOSED_WORDS[e.outcome], answered: [], note: null };
    }
    if (e.type === 'attention.resolved' && e.itemId === item.id) {
      // Older logs have no reason: before the M4 runbook fix a dismiss was never written, so it was the condition.
      return {
        text: e.reason === 'dismissed' ? 'Dismissed.' : 'Cleared: it no longer applies.',
        answered: [],
        note: null,
      };
    }
  }
  return null;
}

type ApprovalOutcome = Extract<HuddleEvent, { type: 'approval.resolved' }>['outcome'];
type ApprovalBy = Extract<HuddleEvent, { type: 'approval.resolved' }>['by'];
type QuestionOutcome = Extract<HuddleEvent, { type: 'question.closed' }>['outcome'];
type HoldWhy = Extract<HuddleEvent, { type: 'hold.ended' }>['why'];

export function approvalEndingWords(outcome: ApprovalOutcome, by: ApprovalBy): string {
  if (by === 'shutdown') return 'Released when Huddle quit. Claude Code asked in the terminal.';
  switch (outcome) {
    case 'allowed':
      return by === 'policy' ? 'Allowed by a rule.' : 'Allowed from Huddle.';
    case 'denied':
      return by === 'policy' ? 'Denied by a rule.' : 'Denied from Huddle.';
    case 'passed_through':
      return 'Passed to the terminal.';
    case 'expired':
      return 'Time limit reached. Claude Code asked in the terminal.';
    case 'answered_elsewhere':
      return 'Answered elsewhere, most likely in the terminal.';
  }
}

export const QUESTION_CLOSED_WORDS: Record<QuestionOutcome, string> = {
  passed_through: 'Handed to the terminal. Answer it there.',
  expired: 'Time limit reached. Answer it in the terminal.',
  answered_elsewhere: 'Answered elsewhere, most likely in the terminal.',
  shutdown: 'Released when Huddle quit. Answer it in the terminal.',
};

/** How a pause hold ended (F13), for the agent detail's pause line. */
export const HOLD_ENDED_WORDS: Record<HoldWhy, string> = {
  resumed: 'resumed',
  hold_limit: 'released before the time limit',
  closed_by_claude_code: 'ended by Claude Code',
  shutdown: 'released when Huddle quit',
};

export interface HoldEnding {
  words: string;
  ts: number;
}

/** The most recent `hold.ended` in an agent's events, in words. */
export function lastHoldEnding(events: readonly HuddleEvent[], key: AgentKey): HoldEnding | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e?.type === 'hold.ended' && e.agentKey === key) return { words: HOLD_ENDED_WORDS[e.why], ts: e.ts };
  }
  return null;
}

/** "Handled at 17:02" when the events do not say more. */
export function handledAt(item: AttentionItem): string {
  return item.resolvedAt === null ? '' : `Handled at ${clockTime(item.resolvedAt)}.`;
}

// --- everything at once (F13: pause all, resume all) -------------------------------------------------------------

/** Words the renderer adds for the "all" controls (DESIGN.md word list). */
export const ALL_REASONS = {
  nothingToPause: 'No running agent can be paused right now.',
  nothingToResume: 'Nothing is paused.',
} as const;

const CONNECTION_REASONS: ReadonlySet<string> = new Set([
  CONTROL_REASONS.notConnected,
  CONTROL_REASONS.portInUse,
  CONTROL_REASONS.connectionError,
]);

/**
 * Pause all / resume all: on when `selectControls` allows that control for at least one running agent. When none
 * does, the reason is the first agent's own reason if they all share it (not connected, for example), else a summary.
 */
export function allControl(state: HuddleState, which: 'pause' | 'resume'): ControlState {
  const reasons = new Set<string>();
  for (const agent of Object.values(state.agents)) {
    if (isTerminal(agent.status) || agent.endedAt !== null) continue;
    const c = selectControls(agent, state.connection, state.connection?.startedAt)[which];
    if (c.enabled) return c;
    if (c.reason !== null) reasons.add(c.reason);
  }
  // A reason that holds for every agent at once (the connection) is the honest one to show.
  const [only] = reasons;
  if (reasons.size === 1 && only !== undefined && CONNECTION_REASONS.has(only)) return { enabled: false, reason: only };
  return { enabled: false, reason: which === 'pause' ? ALL_REASONS.nothingToPause : ALL_REASONS.nothingToResume };
}

/** A label for the item's kind, in words the user sees (DESIGN.md "Words"). */
export function kindWords(item: AttentionItem): string {
  switch (item.kind) {
    case 'approval':
      return 'needs approval';
    case 'question':
      return 'asked a question';
    case 'stuck':
      return 'looks stuck';
    case 'loop':
      return 'may be in a loop';
    case 'file_conflict':
      return 'file conflict';
    case 'budget':
      // A budget item at the warning line is a warning; one at the cap (paused or stopped) needs the user.
      return item.severity === 'action_required' ? 'over budget' : 'near its budget';
    case 'context_high':
      return 'context is high';
    case 'error':
      return 'failed';
    case 'finished':
      return 'finished';
    case 'role_drift':
      return 'editing off-role';
  }
}
