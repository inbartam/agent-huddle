/**
 * Ask the Huddle (M5, F25): words, controls and the pure steps of the view (DESIGN.md "Ask the Huddle (F25)" and
 * "Words for remembering"). The component (components/Ask.tsx) holds the state; everything it shows or decides comes
 * from here, so render tests can check it without a DOM.
 *
 * Text that came from the core (the preview text, the answer, a model error message) is untrusted: it is split and
 * clipped here as plain strings and rendered as text nodes. Nothing in an answer becomes a link or a button.
 */
import {
  ASK_HISTORY_ANSWER_MAX,
  ASK_HISTORY_TURNS_MAX,
  ASK_QUESTION_MAX,
  ASK_TIMEOUT_MS,
  type AskAnswer,
  type AskErrorKind,
  type AskPreview,
  type AskPreviewPart,
  type AskTurn,
  type CommandResult,
  type ControlState,
  type HuddleCommand,
  type QueryResult,
} from '@huddle/shared';
import { clockTime, clockTimeFull, count, duration, plural, shortCount, shortModel, UNKNOWN } from './format.js';

export const ASK_WORDS = {
  title: 'Ask the Huddle',
  back: 'Back to Home',
  intro: 'Answers come from Haiku through your Claude Code login. It sees only the text it is sent, and has no tools.',
  questionLabel: 'Your question',
  placeholder: 'What is everyone doing? Why is ui-engineer slow?',
  keys: 'Enter asks · Shift+Enter adds a line',
  ask: 'Ask',
  asking: 'Asking…',
  cancel: 'Cancel',
  writeFirst: 'Write a question first.',
  tooLong: `A question holds at most ${String(ASK_QUESTION_MAX)} characters.`,
  off: 'Ask the Huddle is off. It sends a summary of your agents to Anthropic, so it waits until you turn it on.',
  turnOn: 'Turn on in Settings',
  /** The disclosure while Ask is on, and while it is off. */
  willSend: 'What will be sent',
  wouldSend: 'What would be sent',
  refresh: 'Refresh',
  building: 'Building the text…',
  sampleNote: 'Shown with a sample question until you write one.',
  partLabels: {
    instructions: 'Instructions to the model',
    history: 'Earlier in this conversation',
    question: 'Your question',
    summary: 'Summary of your agents',
  } satisfies Record<AskPreviewPart, string>,
  /** The `--system-prompt` part, shown first when the core sends it (`AskPreview.systemPrompt`). */
  systemPromptLabel: 'Instructions to the model (system prompt)',
  /** The stdin `instructions` part's label while the system prompt shows above it, so the two are told apart. */
  inputInstructionsLabel: 'Instructions to the model (in the input)',
  systemPromptNote:
    'The system prompt is passed to claude as a command-line setting; the rest is sent as its input. The size above counts the input.',
  truncated: 'Cut to 50 KB: the oldest events are left out.',
  masking:
    'Secrets are masked and long text is clipped, as best effort: a secret in an unusual format can still show. Never file contents or tool output.',
  previewNotAvailable: "The text to send can't be shown in this build.",
  answer: 'Answer',
  answerLabel: "A model's answer. It can be wrong, and it saw only the text that was sent.",
  askAgain: 'Ask again',
  copyAnswer: 'Copy answer',
  copied: 'Copied.',
  copyFailed: "Couldn't copy here. The answer is selected: press Ctrl+C.",
  showSent: 'Show what was sent',
  notSaved: 'Kept until you leave Home. Never saved to disk.',
  /** The card's header on Home: what it can do, and that nothing is kept. */
  pill: 'read-only · Haiku',
  notSavedShort: 'Not saved after you leave',
  youAsked: 'You asked',
  followUp: 'Ask a follow-up',
} as const;

/** The question the preview is built with while the box is empty (the core refuses an empty one). */
export const SAMPLE_QUESTION = 'What is everyone doing?';
/** The counter shows from this many characters (DESIGN: "A counter shows from 400"). */
export const COUNTER_FROM = 400;
/** How long the question must stay unchanged before the preview is built again. */
export const PREVIEW_DEBOUNCE_MS = 400;
/** Longest model error message shown in "Claude Code couldn't answer: …". */
export const ERROR_MESSAGE_MAX = 300;

// ---------------------------------------------------------------------------
// The question box and the Ask button
// ---------------------------------------------------------------------------

/** "412 / 500" from COUNTER_FROM characters on; null below. */
export function questionCounter(question: string): string | null {
  return question.length >= COUNTER_FROM ? `${String(question.length)} / ${String(ASK_QUESTION_MAX)}` : null;
}

/** What the palette (or anything else) may put in the box: clipped to the limit, never sent. */
export function prefillQuestion(text: string | null | undefined): string {
  return (text ?? '').trim().slice(0, ASK_QUESTION_MAX);
}

/**
 * What the view knows before it asks: `HuddleState.ask` when the core filled it, otherwise the Settings switch and
 * nothing else (unknown reads as "not set" and "not busy", today's behaviour; the `huddle.ask` answer still says why).
 *
 * `enabled` comes from `HuddleState.ask` when present: it is the value the core itself checks when it refuses
 * `huddle.ask`, and it is read in the same snapshot as `apiKeySet` and `busy`, so the three always agree. With the real
 * core `HuddleState.settings.ask.enabled` is read from the same place, so they only differ in a host that fills one and
 * not the other.
 */
export interface AskLive {
  enabled: boolean;
  apiKeySet: boolean;
  /** `HuddleState.ask.otherProvider` (M5 security review L1); absent reads as false. */
  otherProvider: boolean;
  busy: boolean;
}

/** Why the core refuses every ask up front, or null: a billed key first, then another provider. */
export function askRefusalKind(live: AskLive): 'api_key_set' | 'other_provider' | null {
  if (live.apiKeySet) return 'api_key_set';
  if (live.otherProvider) return 'other_provider';
  return null;
}

export function askLive(status: unknown, settingsEnabled: boolean): AskLive {
  if (typeof status !== 'object' || status === null) {
    return { enabled: settingsEnabled, apiKeySet: false, otherProvider: false, busy: false };
  }
  const s = status as Record<string, unknown>;
  return {
    enabled: typeof s['enabled'] === 'boolean' ? s['enabled'] : settingsEnabled,
    apiKeySet: s['apiKeySet'] === true,
    otherProvider: s['otherProvider'] === true,
    busy: s['busy'] === true,
  };
}

/**
 * Whether Ask can be pressed now, and why not. An ask this view started is shown by the button itself; `blocked`
 * carries what the core said up front (an API key in the environment, another ask already running).
 */
export function askControl(
  enabled: boolean,
  question: string,
  blocked: { apiKeySet?: boolean; otherProvider?: boolean; busy?: boolean } = {},
): ControlState {
  if (!enabled) return { enabled: false, reason: ASK_WORDS.off };
  if (blocked.apiKeySet === true)
    return { enabled: false, reason: failureWords({ kind: 'api_key_set', message: '' }).text };
  if (blocked.otherProvider === true) {
    return { enabled: false, reason: failureWords({ kind: 'other_provider', message: '' }).text };
  }
  if (blocked.busy === true) return { enabled: false, reason: failureWords({ kind: 'busy', message: '' }).text };
  const q = question.trim();
  if (q === '') return { enabled: false, reason: ASK_WORDS.writeFirst };
  if (q.length > ASK_QUESTION_MAX) return { enabled: false, reason: ASK_WORDS.tooLong };
  return { enabled: true, reason: null };
}

/**
 * The one command Ask sends: the question, trimmed, and the earlier turns of the conversation when there are any (the
 * core builds the context itself). A first question carries no `history` key at all.
 */
export function askCommand(question: string, history: readonly AskTurn[] = []): HuddleCommand {
  return history.length > 0
    ? { type: 'huddle.ask', question: question.trim(), history: [...history] }
    : { type: 'huddle.ask', question: question.trim() };
}

export const CANCEL_COMMAND: HuddleCommand = { type: 'ask.cancel' };

/** Enter asks, and so does Ctrl+Enter; Shift+Enter (and Enter while an IME is composing) adds a line. */
export function askKey(e: {
  key: string;
  shiftKey: boolean;
  ctrlKey?: boolean;
  isComposing?: boolean;
}): 'ask' | 'none' {
  return e.key === 'Enter' && !e.shiftKey && e.isComposing !== true ? 'ask' : 'none';
}

/** "Asking Haiku… 4 s" while the ask waits. */
export function askingWords(startedAt: number, now: number): string {
  const s = Math.max(0, Math.floor((now - startedAt) / 1000));
  return `Asking Haiku… ${String(s)} s`;
}

// ---------------------------------------------------------------------------
// "What will be sent"
// ---------------------------------------------------------------------------

/** One run of the preview text: a labelled part, or text between parts (`part` null). */
export interface PreviewSegment {
  part: AskPreviewPart | null;
  text: string;
}

const PARTS: ReadonlySet<string> = new Set<AskPreviewPart>(['instructions', 'history', 'question', 'summary']);

/**
 * The preview text cut at the core's part offsets, as plain strings. Offsets that are not whole numbers, run past the
 * text, go backwards or overlap are not trusted: then the whole text is one unlabelled segment. Text the parts leave
 * out still shows, unlabelled, so the user always reads everything that is sent.
 */
export function previewSegments(preview: Pick<AskPreview, 'text' | 'parts'>): PreviewSegment[] {
  const { text } = preview;
  const whole: PreviewSegment[] = text === '' ? [] : [{ part: null, text }];
  if (!Array.isArray(preview.parts)) return whole;
  const out: PreviewSegment[] = [];
  let at = 0;
  for (const p of preview.parts) {
    const ok =
      typeof p === 'object' &&
      PARTS.has(p.part) &&
      Number.isInteger(p.start) &&
      Number.isInteger(p.end) &&
      p.start >= at &&
      p.end >= p.start &&
      p.end <= text.length;
    if (!ok) return whole;
    if (p.start > at) out.push({ part: null, text: text.slice(at, p.start) });
    out.push({ part: p.part, text: text.slice(p.start, p.end) });
    at = p.end;
  }
  if (at < text.length) out.push({ part: null, text: text.slice(at) });
  return out;
}

/** "3.4 KB" (1 KB = 1,000 bytes, like the 50 KB cap), "820 bytes", `—`. */
export function sizeWords(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return UNKNOWN;
  if (bytes < 1000) return `${String(Math.round(bytes))} bytes`;
  return `${(bytes / 1000).toFixed(1)} KB`;
}

/** "3.4 KB · ~900 tokens, est." */
export function previewSize(preview: Pick<AskPreview, 'bytes' | 'estTokens'>): string {
  const tokens = Number.isFinite(preview.estTokens) ? `~${count(preview.estTokens)} tokens, est.` : `${UNKNOWN} tokens`;
  return `${sizeWords(preview.bytes)} · ${tokens}`;
}

/** "system prompt 1.2 KB": the `--system-prompt`'s own size, kept apart from the stdin bytes. */
export function systemPromptSize(systemPrompt: string): string {
  return `system prompt ${sizeWords(new TextEncoder().encode(systemPrompt).length)}`;
}

export function asOfWords(ts: number): string {
  return `as of ${clockTimeFull(ts)}`;
}

/** The preview failed: an older core, or the core's own message. */
export function previewFailure(r: Extract<QueryResult, { ok: false }>): string {
  if (r.code === 'not_available' || r.code === 'unsupported') return ASK_WORDS.previewNotAvailable;
  return `Couldn't build the text to send: ${trimStop(clip(r.message, ERROR_MESSAGE_MAX))}.`;
}

// ---------------------------------------------------------------------------
// The answer
// ---------------------------------------------------------------------------

/** One item of the answer's meta line. `title` is the tooltip; `mono` marks the model id. */
export interface MetaItem {
  key: 'model' | 'time' | 'wall' | 'tokens' | 'cost';
  text: string;
  title?: string;
  mono?: true;
}

/** "~$0.001 est.", "<$0.001 est.", "~$0.12 est."; `—` when the result carried no cost. Claude Code's own estimate. */
export function askCost(usd: number | null): string {
  if (usd === null || !Number.isFinite(usd) || usd < 0) return UNKNOWN;
  if (usd > 0 && usd < 0.001) return '<$0.001 est.';
  if (usd < 0.01) return `~$${usd.toFixed(3)} est.`;
  return `~$${usd.toFixed(2)} est.`;
}

/** Model id, clock time, wall time, tokens, cost: each `—` when the result lacks it. */
/** The answer's meta line. Simple names the model in words ("Haiku 5.5", the id in its tooltip); Advanced shows the id. */
export function answerMeta(answer: AskAnswer, simple = false): MetaItem[] {
  const t = answer.tokens;
  return [
    simple
      ? { key: 'model', text: shortModel(answer.model), ...(answer.model !== null ? { title: answer.model } : {}) }
      : { key: 'model', text: answer.model ?? UNKNOWN, mono: true },
    { key: 'time', text: clockTime(answer.askedAt), title: clockTimeFull(answer.askedAt) },
    {
      key: 'wall',
      text: duration(answer.wallMs),
      ...(answer.apiMs !== null ? { title: `model time ${duration(answer.apiMs)}` } : {}),
    },
    t
      ? {
          key: 'tokens',
          text: `${shortCount(t.input + t.output)} tokens`,
          title: `${count(t.input)} in · ${count(t.output)} out`,
        }
      : { key: 'tokens', text: `${UNKNOWN} tokens` },
    { key: 'cost', text: askCost(answer.costUsd), title: "Claude Code's own estimate" },
  ];
}

// ---------------------------------------------------------------------------
// What came back from `huddle.ask`
// ---------------------------------------------------------------------------

/** Why an ask ended without an answer: the core's kinds, plus an older core and anything else. */
export type AskFailure =
  | { kind: AskErrorKind; message: string }
  | { kind: 'not_available'; message: string }
  | { kind: 'other'; message: string };

export type AskOutcome = { kind: 'answer'; answer: AskAnswer } | { kind: 'failed'; failure: AskFailure };

const ERROR_KINDS: ReadonlySet<string> = new Set<AskErrorKind>([
  'disabled',
  'api_key_set',
  'other_provider',
  'claude_not_found',
  'not_logged_in',
  'timeout',
  'model_error',
  'cancelled',
  'busy',
]);

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isNumOrNull = (v: unknown): v is number | null => v === null || isNum(v);

/** The answer, when it has the shape `AskAnswer` promises; null otherwise. Unknown extra fields are dropped. */
export function parseAnswer(v: unknown): AskAnswer | null {
  if (typeof v !== 'object' || v === null) return null;
  const a = v as Record<string, unknown>;
  const tokens = a['tokens'];
  let parsedTokens: AskAnswer['tokens'] = null;
  if (tokens !== null && tokens !== undefined) {
    if (typeof tokens !== 'object') return null;
    const t = tokens as Record<string, unknown>;
    const input = t['input'];
    const output = t['output'];
    if (!isNum(input) || !isNum(output)) return null;
    parsedTokens = { input, output };
  }
  const model = a['model'] ?? null;
  const apiMs = a['apiMs'] ?? null;
  const costUsd = a['costUsd'] ?? null;
  if (
    typeof a['text'] !== 'string' ||
    typeof a['sent'] !== 'string' ||
    !isNum(a['askedAt']) ||
    !isNum(a['wallMs']) ||
    (model !== null && typeof model !== 'string') ||
    !isNumOrNull(apiMs) ||
    !isNumOrNull(costUsd)
  ) {
    return null;
  }
  return {
    text: a['text'],
    model,
    askedAt: a['askedAt'],
    wallMs: a['wallMs'],
    apiMs,
    tokens: parsedTokens,
    costUsd,
    sent: a['sent'],
  };
}

/**
 * Read a `huddle.ask` result. A success without a well-formed answer, or a refusal without `askError` that says the
 * command is unknown (`unsupported`, `invalid` from an older core's placeholder schema), means this build cannot ask.
 */
export function askOutcome(r: CommandResult): AskOutcome {
  if (r.ok) {
    const answer = parseAnswer(r.ask);
    return answer ? { kind: 'answer', answer } : { kind: 'failed', failure: { kind: 'not_available', message: '' } };
  }
  const kind: unknown = r.askError;
  if (typeof kind === 'string' && ERROR_KINDS.has(kind)) {
    return { kind: 'failed', failure: { kind: kind as AskErrorKind, message: r.message } };
  }
  if (r.code === 'unsupported' || r.code === 'invalid') {
    return { kind: 'failed', failure: { kind: 'not_available', message: r.message } };
  }
  return { kind: 'failed', failure: { kind: 'other', message: r.message } };
}

/** Send the ask and read the result; a thrown bridge call reads as `other`. */
export async function runAsk(
  send: (cmd: HuddleCommand) => Promise<CommandResult>,
  question: string,
  history: readonly AskTurn[] = [],
): Promise<AskOutcome> {
  try {
    return askOutcome(await send(askCommand(question, history)));
  } catch {
    return { kind: 'failed', failure: { kind: 'other', message: "Huddle couldn't reach its core" } };
  }
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function trimStop(text: string): string {
  return text.replace(/[.\s]+$/, '');
}

const SECONDS = String(Math.round(ASK_TIMEOUT_MS / 1000));

/**
 * The failure in plain words (DESIGN "Words"). `alert` is false for the one the user asked for (Cancel), which shows
 * as a status line instead of an error.
 */
export function failureWords(f: AskFailure): { text: string; alert: boolean } {
  switch (f.kind) {
    case 'claude_not_found':
      return {
        text: "Huddle couldn't find the `claude` command. Install Claude Code, or add it to PATH, then ask again.",
        alert: true,
      };
    case 'not_logged_in':
      return { text: "Claude Code isn't logged in. Run `claude` in a terminal, log in, then ask again.", alert: true };
    case 'timeout':
      return { text: `No answer within ${SECONDS} seconds. Ask again, or ask something shorter.`, alert: true };
    case 'model_error': {
      const m = trimStop(clip(f.message, ERROR_MESSAGE_MAX));
      return { text: m === '' ? "Claude Code couldn't answer." : `Claude Code couldn't answer: ${m}.`, alert: true };
    }
    case 'disabled':
      return { text: 'Stopped: Ask the Huddle was turned off.', alert: true };
    case 'api_key_set':
      return {
        text:
          "ANTHROPIC_API_KEY is set on this computer (in the environment, or in Claude Code's settings.json with " +
          'an auth token or apiKeyHelper), so the ask would be billed to that key instead of your Claude Code login. ' +
          "Huddle won't send it. Remove it and restart Huddle to ask.",
        alert: true,
      };
    case 'other_provider':
      return {
        text:
          'Claude Code on this computer is set to use another provider (ANTHROPIC_BASE_URL, Bedrock, Vertex or ' +
          "Foundry), so the summary would not go to Anthropic. Huddle won't send it. Remove the setting and restart " +
          'Huddle to ask.',
        alert: true,
      };
    case 'cancelled':
      return { text: 'Cancelled. Nothing was answered.', alert: false };
    case 'busy':
      return { text: 'Another question is still being answered. Wait for it, or cancel it.', alert: true };
    case 'not_available':
      return { text: "Ask the Huddle isn't available in this build.", alert: true };
    case 'other': {
      const m = trimStop(clip(f.message, ERROR_MESSAGE_MAX));
      return { text: m === '' ? "Huddle couldn't ask." : `Huddle couldn't ask: ${m}.`, alert: true };
    }
  }
}
// ---------------------------------------------------------------------------
// The conversation (Home's Ask card): turns kept in component state only, never stored
// ---------------------------------------------------------------------------

/** One answered question in the card. */
export interface ConversationTurn {
  question: string;
  answer: AskAnswer;
}

function clipTo(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

/**
 * The earlier turns a follow-up carries (`huddle.ask` and `ask.preview` alike, so What will be sent matches): the
 * newest ASK_HISTORY_TURNS_MAX, oldest first, each clipped (question ASK_QUESTION_MAX, answer ASK_HISTORY_ANSWER_MAX).
 * The core clips and masks again; this keeps the renderer from sending more than it may.
 */
export function askHistory(turns: readonly ConversationTurn[]): AskTurn[] {
  return turns.slice(-ASK_HISTORY_TURNS_MAX).map((t) => ({
    question: clipTo(t.question.trim(), ASK_QUESTION_MAX),
    answer: clipTo(t.answer.text, ASK_HISTORY_ANSWER_MAX),
  }));
}

/** What an ask carries as history: every turn for a new question; for Ask again, the turns before the last one. */
export function historyFor(turns: readonly ConversationTurn[], again: boolean): AskTurn[] {
  return askHistory(again ? turns.slice(0, -1) : turns);
}

/** The turns after an answer: appended for a new question, the last one replaced for Ask again. */
export function addTurn(
  turns: readonly ConversationTurn[],
  turn: ConversationTurn,
  again: boolean,
): ConversationTurn[] {
  return again && turns.length > 0 ? [...turns.slice(0, -1), turn] : [...turns, turn];
}

/** The question Ask again repeats: the last turn's; null with no turn yet. */
export function againQuestion(turns: readonly ConversationTurn[]): string | null {
  return turns.length > 0 ? (turns[turns.length - 1]?.question ?? null) : null;
}

/**
 * What the preview covers once there is a conversation: the question in the box with the turns a follow-up carries.
 * Ask again sends the last question with the turns before it, one fewer, so the text differs a little.
 */
export function previewCovers(turnsCarried: number): string {
  return `For the question in the box, with the last ${plural(turnsCarried, 'earlier turn')}. Ask again sends the last question with the turns before it instead.`;
}
