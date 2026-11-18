/**
 * Questions (F11): a PreToolUse(AskUserQuestion) of an attached session is held for a window so the user can answer it
 * in the Huddle (S5), then released with no decision so Claude Code shows its own question box. Pure.
 *
 *  - Hold window: `questionHoldSeconds` (default 120 s), never past the hook timeout minus the self-release margin.
 *    0 means "never hold": the question is closed `passed_through` at once.
 *  - `question.answer`: the answer is built from the raw held payload, keyed by the exact question text. One option
 *    label for a single-select question (S5); for a multi-select one the chosen labels in option order joined with
 *    ", ", and a typed ("Other") answer verbatim, or after the labels (S14 b: both forms are what the terminal itself
 *    sends). The event records the same in the display (masked, clipped) words of `question.asked`. Questions whose
 *    shown options or questions repeat (`questionIsAmbiguous`) go to the terminal: an answer could reach the wrong one.
 *  - "Answer in terminal" (`approval.passThrough` with the question's request id) releases early -> passed_through.
 *  - Endings: window over -> passed_through; Claude Code closed it -> expired (about its timeout, inferred from timing)
 *    or answered_elsewhere; shutdown -> shutdown. A refused hold -> passed_through, or shutdown while closing.
 */
import {
  CLIP_LIMITS,
  CONTROL_REASONS,
  questionIsAmbiguous,
  type AskQuestion,
  type HuddleState,
  type QuestionRequest,
} from '@huddle/shared';
import type { QuestionAnswers } from '../ingest/hook-replies.js';
import { questionItemId } from '../state/reduce.js';
import {
  agentOf,
  closedAtTimeout,
  commandResult,
  effects,
  holdLimitAt,
  makeEvent,
  type BrokerCtx,
  type BrokerEffects,
  type BrokerView,
  type HeldEntry,
} from './model.js';
import type { RawQuestionCall } from '../normalize/hook-facts.js';
import { clip } from '../text.js';
import { maskSecrets } from '../privacy/redact.js';

type ClosedOutcome = 'passed_through' | 'expired' | 'answered_elsewhere' | 'shutdown';

function closedEvent(
  ctx: BrokerCtx,
  who: { sessionId: string; agentKey: string },
  requestId: string,
  outcome: ClosedOutcome,
  source: 'user' | 'huddle' = 'huddle',
) {
  return makeEvent<'question.closed'>(ctx, who, source, { type: 'question.closed', requestId, outcome });
}

/** The open inbox item's question, if the reducer shows one. */
function openQuestion(state: HuddleState, requestId: string): QuestionRequest | null {
  const item = state.inbox.find((i) => i.id === questionItemId(requestId));
  return item !== undefined && item.resolvedAt === null ? (item.question ?? null) : null;
}

/** A PreToolUse(AskUserQuestion) arrived. */
export function onAskUserQuestion(
  view: BrokerView,
  hook: {
    sessionId: string;
    agentKey: string;
    receivedAt: number;
    toolUseId: string | null;
    requestId: string | null;
    question: RawQuestionCall | null;
  },
  ctx: BrokerCtx,
): BrokerEffects {
  const node = agentOf(view.state, hook.agentKey);
  const requestId = hook.requestId;
  if (requestId === null) return effects();
  // Already held under this request id (a repeated post): answer this one with no decision at once; the first hold
  // keeps the inbox item and its own endings.
  if (heldQuestion(view, requestId) !== undefined) return effects();
  const entry: HeldEntry = {
    holdId: ctx.nextId(),
    kind: 'question',
    agentKey: hook.agentKey,
    sessionId: hook.sessionId,
    requestId,
    toolUseId: hook.toolUseId,
    receivedAt: hook.receivedAt,
    timeoutAt: hook.receivedAt + view.timeouts.preToolUse,
    question: hook.question,
    call: null,
  };
  const windowEnd = Math.min(hook.receivedAt + view.questionHoldSeconds * 1000, holdLimitAt(entry));
  const holdable =
    node !== undefined && node.capabilities.answerQuestions && hook.question !== null && windowEnd > hook.receivedAt;
  if (!holdable) {
    // Not ours to answer: close the inbox item so the Huddle does not offer an answer it cannot deliver.
    return openQuestion(view.state, requestId) === null
      ? effects()
      : effects({ events: [closedEvent(ctx, hook, requestId, 'passed_through')] });
  }
  return effects({ hold: { entry, timers: [{ at: windowEnd, kind: 'question_window' }], events: [] } });
}

export function heldQuestion(view: BrokerView, requestId: string): HeldEntry | undefined {
  return view.held.find((h) => h.kind === 'question' && h.requestId === requestId);
}

/**
 * The option one shown or raw label names: the answer may name the display label or the raw label. Index or null.
 */
function optionIndex(label: string, raw: { labels: string[] }, shown: AskQuestion | undefined): number | null {
  const shownIndex = shown?.options.findIndex((o) => o.label === label) ?? -1;
  if (shownIndex >= 0 && shownIndex < raw.labels.length) return shownIndex;
  const rawIndex = raw.labels.indexOf(label);
  return rawIndex >= 0 ? rawIndex : null;
}

/** The value for one question in a record keyed by the display text or the raw text. */
function valueFor<T>(record: Readonly<Record<string, T>> | undefined, raw: string, shown: AskQuestion | undefined) {
  if (record === undefined) return undefined;
  const own = (key: string): T | undefined => (Object.hasOwn(record, key) ? record[key] : undefined);
  return (shown !== undefined ? own(shown.question) : undefined) ?? own(raw);
}

/** `question.answer`. */
export function answerQuestion(
  view: BrokerView,
  cmd: {
    requestId: string;
    answers: Record<string, string | string[]>;
    other?: Record<string, string>;
    freeText?: string;
  },
  ctx: BrokerCtx,
  via?: 'phone',
): BrokerEffects {
  const entry = heldQuestion(view, cmd.requestId);
  if (entry === undefined || entry.question === null) {
    const known = view.state.inbox.some((i) => i.id === questionItemId(cmd.requestId));
    return known
      ? commandResult({ ok: false, code: 'expired', message: 'This question was already answered or closed.' })
      : commandResult({ ok: false, code: 'not_found', message: 'That question is not known.' });
  }
  const raw = entry.question.questions;
  const display = openQuestion(view.state, cmd.requestId);
  // Masked or clipped words can make two options (or questions) look alike, and repeated raw words cannot be told
  // apart in the answer either: the first match could be the wrong one, so these go to the terminal. The hold stays.
  const rawRepeats =
    new Set(raw.map((q) => q.question)).size !== raw.length ||
    raw.some((q) => new Set(q.labels).size !== q.labels.length) ||
    // Multi-select labels are joined with ", " (S14 b): a label holding ", " would read as two choices.
    raw.some((q) => q.multiSelect && q.labels.some((l) => l.includes(', ')));
  if (rawRepeats || (display !== null && questionIsAmbiguous(display))) {
    return commandResult({ ok: false, code: 'unsupported', message: CONTROL_REASONS.ambiguousChoice });
  }
  // The older one-field form of a typed answer: only for a single question.
  const legacyText = cmd.freeText?.trim() ?? '';
  if (legacyText !== '' && raw.length !== 1) {
    return commandResult({ ok: false, code: 'invalid', message: 'Type your own answer next to its question.' });
  }
  const shownList = display !== null && display.questions.length === raw.length ? display.questions : null;
  const rawAnswers: Record<string, string> = {};
  const recorded: Record<string, string> = {};
  for (const [index, q] of raw.entries()) {
    const shown = shownList?.[index];
    const value = valueFor(cmd.answers, q.question, shown);
    const labels = value === undefined ? [] : (Array.isArray(value) ? value : [value]).filter((l) => l !== '');
    const indexes: number[] = [];
    for (const label of labels) {
      const i = optionIndex(label, q, shown);
      if (i === null)
        return commandResult({ ok: false, code: 'invalid', message: 'That choice is not one of the options.' });
      if (!indexes.includes(i)) indexes.push(i);
    }
    indexes.sort((x, y) => x - y);
    const typed = clip(
      (valueFor(cmd.other, q.question, shown) ?? (raw.length === 1 ? legacyText : '')).trim(),
      CLIP_LIMITS.message,
    );
    if (!q.multiSelect && indexes.length > 1) {
      return commandResult({ ok: false, code: 'invalid', message: 'Choose one option for this question.' });
    }
    if (!q.multiSelect && indexes.length > 0 && typed !== '') {
      return commandResult({
        ok: false,
        code: 'invalid',
        message: 'Choose an option or type your own answer, not both.',
      });
    }
    if (indexes.length === 0 && typed === '') {
      return commandResult({ ok: false, code: 'invalid', message: 'Answer every question.' });
    }
    const rawParts = indexes.map((i) => q.labels[i] ?? '');
    const shownParts = indexes.map((i) => shown?.options[i]?.label ?? q.labels[i] ?? '');
    if (typed !== '') {
      rawParts.push(typed);
      // Claude Code gets the words as typed; the log gets them masked, like every stored free text.
      shownParts.push(maskSecrets(typed));
    }
    rawAnswers[q.question] = rawParts.join(', ');
    // The log keeps the display words (masked and clipped), like question.asked.
    recorded[shown?.question ?? q.question] = clip(shownParts.join(', '), CLIP_LIMITS.message);
  }
  const answers: QuestionAnswers = rawAnswers;
  return commandResult(
    { ok: true },
    {
      releases: [
        {
          holdId: entry.holdId,
          reply: { kind: 'preToolUse.answer', toolInput: entry.question.toolInput, answers },
          events: [
            makeEvent<'question.answered'>(ctx, entry, 'user', {
              type: 'question.answered',
              requestId: cmd.requestId,
              answers: recorded,
              ...(via !== undefined ? { via } : {}),
            }),
          ],
        },
      ],
    },
  );
}

/** "Answer in terminal": release now with no decision; Claude Code shows its own question box. */
export function passQuestionToTerminal(entry: HeldEntry, ctx: BrokerCtx): BrokerEffects {
  return commandResult(
    { ok: true },
    {
      releases: [
        {
          holdId: entry.holdId,
          reply: { kind: 'none' },
          events: [closedEvent(ctx, entry, entry.requestId ?? '', 'passed_through', 'user')],
        },
      ],
    },
  );
}

/** The window is over (or the hold limit came first): release with no decision. */
export function questionWindowOver(entry: HeldEntry, ctx: BrokerCtx): BrokerEffects {
  return effects({
    releases: [
      {
        holdId: entry.holdId,
        reply: { kind: 'none' },
        events: [closedEvent(ctx, entry, entry.requestId ?? '', 'passed_through')],
      },
    ],
  });
}

export function questionClosed(
  entry: HeldEntry,
  why: 'closed_by_claude_code' | 'shutdown',
  ctx: BrokerCtx,
): BrokerEffects {
  const outcome: ClosedOutcome =
    why === 'shutdown' ? 'shutdown' : closedAtTimeout(entry, ctx.now) ? 'expired' : 'answered_elsewhere';
  return effects({ events: [closedEvent(ctx, entry, entry.requestId ?? '', outcome)] });
}

export function questionShutdown(entry: HeldEntry, ctx: BrokerCtx): BrokerEffects {
  return effects({
    releases: [
      {
        holdId: entry.holdId,
        reply: { kind: 'none' },
        events: [closedEvent(ctx, entry, entry.requestId ?? '', 'shutdown')],
      },
    ],
  });
}

export function questionRefused(entry: HeldEntry, why: 'cap' | 'closing', ctx: BrokerCtx): BrokerEffects {
  return effects({
    events: [closedEvent(ctx, entry, entry.requestId ?? '', why === 'closing' ? 'shutdown' : 'passed_through')],
  });
}
