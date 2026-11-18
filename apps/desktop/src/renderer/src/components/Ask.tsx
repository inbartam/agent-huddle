/**
 * Ask the Huddle (M5, F25; DESIGN.md "Ask the Huddle (F25)"). A question box, "What will be sent" (the exact text the
 * core would put on `claude -p`'s stdin, from `ask.preview`), and the answer.
 *
 * - Off by default: the box and Ask are off with the reason, and "Turn on in Settings" only opens Settings at that
 *   section. "What would be sent" still opens, so the user can read the text before agreeing.
 * - `huddle.ask` carries the question only; the core builds the rest. One ask at a time, with Cancel (`ask.cancel`).
 * - The preview, the answer and any model error are untrusted text: text nodes only, pre-wrapped, nothing clickable,
 *   no link detection, no Markdown. The preview's three parts are cut at the core's offsets into text nodes.
 * - The answer lives in this component's state only. It is gone when the view closes; leaving while an ask is in
 *   flight cancels it, since nothing would be left to show the answer.
 * - Up front (U6, `HuddleState.ask`): an API key in the environment turns Ask off with the refusal words before
 *   anything is sent, and an ask already running (started before this view opened) shows with Cancel. Absent means
 *   unknown: the view behaves as before and the `huddle.ask` answer says why it was refused.
 * - The `--system-prompt` (`AskPreview.systemPrompt`) shows as its own first part, in its own `<pre>`, above the stdin.
 */
import { Fragment, useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
  ASK_QUESTION_MAX,
  type AskAnswer,
  type AskPreview,
  type AskStatus,
  type CommandResult,
  type HuddleCommand,
} from '@huddle/shared';
import { loadAskPreview } from '../ask-query.js';
import type { QueryFn } from '../query.js';
import { useNow } from '../useNow.js';
import { useViewMode } from '../viewMode.js';
import { MessageText } from './MessageText.js';
import {
  ASK_WORDS as W,
  answerMeta,
  askControl,
  askingWords,
  askKey,
  askLive,
  askRefusalKind,
  asOfWords,
  CANCEL_COMMAND,
  failureWords,
  prefillQuestion,
  PREVIEW_DEBOUNCE_MS,
  previewFailure,
  previewSegments,
  previewSize,
  questionCounter,
  runAsk,
  SAMPLE_QUESTION,
  addTurn,
  againQuestion,
  historyFor,
  previewCovers,
  type ConversationTurn,
  systemPromptSize,
  type AskFailure,
} from '../view/ask.js';
import { ControlButton } from './ControlButton.js';

const COPIED_MS = 2000;

/** The F28/F29 hand-offs under an answer (the same words as view/orch.ts ORCH_WORDS). */
const MAKE_WORDS = { task: 'Make a task from this', skill: 'Create skill from this' } as const;

export type AskPhase =
  | { kind: 'idle' }
  | { kind: 'asking'; startedAt: number; question?: string; again?: boolean }
  | { kind: 'answered'; answer: AskAnswer }
  | { kind: 'failed'; failure: AskFailure };

export type PreviewLoad =
  | { kind: 'loading' }
  /** `sample`: built with SAMPLE_QUESTION because the box was empty. */
  | { kind: 'ready'; preview: AskPreview; sample: boolean }
  | { kind: 'failed'; text: string };

/** What tests (and nothing else) hand in instead of asking the core. */
export interface AskInitial {
  phase?: AskPhase;
  preview?: PreviewLoad;
  previewOpen?: boolean;
  /** The clock for "Asking Haiku… 4 s". */
  now?: number;
  copy?: 'copied' | 'failed';
  /** Earlier answered turns (the conversation), oldest first. */
  turns?: ConversationTurn[];
}

export interface AskPanelProps {
  /** Settings, Ask the Huddle (`settings.ask.enabled`). `status.enabled` wins when the core sent one (view/ask.ts). */
  enabled: boolean;
  /** `HuddleState.ask`: what the core says before anything is asked. Absent or null: unknown. */
  status?: AskStatus | null;
  query: QueryFn | null;
  onCommand: (cmd: HuddleCommand) => Promise<CommandResult>;
  /** The panel's "Back to Home"; absent on Home's card. */
  onClose?: () => void;
  /** Open Settings at the Ask the Huddle section. Never turns anything on. */
  onOpenSettings: () => void;
  /** Put this in the box (the palette's "Ask the Huddle: “…”"). Never sent until the user presses Ask. */
  initialQuestion?: string | null;
  /** A question handed in later (the palette): `n` changes each time; fills the box, keeps the conversation. */
  prefill?: { question: string; n: number } | null;
  /** panel: the old full view. card: Home's Ask card (title, read-only pill, conversation above the box). */
  layout?: 'panel' | 'card';
  initial?: AskInitial;
  /**
   * F29/F28: "Make a task from this" and "Create skill from this" under an answer. They only hand the question and
   * the answer text to a form the user reviews; nothing is sent from here. Absent: the buttons are not shown.
   */
  onMakeTask?: (question: string, answer: string) => void;
  onMakeSkill?: (question: string, answer: string) => void;
}

/** Fixed words may name a command in backticks; those parts show in the code face. Every part is a text node. */
function WithCode({ text }: { text: string }) {
  return (
    <>
      {text.split('`').map((part, i) =>
        i % 2 === 1 ? (
          <span key={i} className="code">
            {part}
          </span>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}

/**
 * Ask is off: the reason and "Turn on in Settings". It is handed only the way to Settings, never a command sender, so
 * it cannot turn anything on.
 */
export function AskOff({ id, onOpenSettings }: { id: string; onOpenSettings: () => void }) {
  return (
    <div className="ask-off" id={id}>
      <p>{W.off}</p>
      <button type="button" className="control control-plain" onClick={onOpenSettings}>
        {W.turnOn}
      </button>
    </div>
  );
}

/** "Asking Haiku… 4 s", ticking once a second while it is mounted. */
function Elapsed({ startedAt, now }: { startedAt: number; now?: number }) {
  const tick = useNow(1000);
  return <span className="ask-elapsed">{askingWords(startedAt, now ?? tick)}</span>;
}

/**
 * The preview in read-only `<pre>`s: the system prompt first (when the core sent it), then the stdin text with its
 * three parts labelled. Both are text nodes.
 */
export function PreviewText({ preview }: { preview: Pick<AskPreview, 'text' | 'parts' | 'systemPrompt'> }) {
  const sp = preview.systemPrompt;
  const hasSp = typeof sp === 'string';
  return (
    <>
      {hasSp && (
        <pre className="ask-pre ask-pre-system" tabIndex={0} aria-label={W.systemPromptLabel}>
          <span className="ask-part ask-part-system">
            <span className="ask-part-label">{W.systemPromptLabel}</span>
            {sp}
          </span>
        </pre>
      )}
      <pre className="ask-pre" tabIndex={0} aria-label="The exact text that is sent">
        {previewSegments(preview).map((s, i) =>
          s.part === null ? (
            <Fragment key={i}>{s.text}</Fragment>
          ) : (
            <span key={i} className={`ask-part ask-part-${s.part}`}>
              <span className="ask-part-label">
                {hasSp && s.part === 'instructions' ? W.inputInstructionsLabel : W.partLabels[s.part]}
              </span>
              {s.text}
            </span>
          ),
        )}
      </pre>
    </>
  );
}

function PreviewBlock({
  enabled,
  load,
  open,
  onToggle,
  onRefresh,
  covers = null,
}: {
  enabled: boolean;
  load: PreviewLoad;
  open: boolean;
  onToggle: (open: boolean) => void;
  onRefresh: () => void;
  /** What this preview is for, when that needs saying (a conversation: the box, not Ask again). */
  covers?: string | null;
}) {
  const ready = load.kind === 'ready' ? load : null;
  return (
    <details
      className="ask-preview"
      open={open}
      onToggle={(e) => {
        onToggle(e.currentTarget.open);
      }}
    >
      <summary className="ask-preview-summary">
        <span className="ask-preview-title">{enabled ? W.willSend : W.wouldSend}</span>
        {ready && (
          <>
            <span className="ask-preview-size">{previewSize(ready.preview)}</span>
            {ready.preview.systemPrompt !== undefined && (
              <span className="ask-preview-size">{systemPromptSize(ready.preview.systemPrompt)}</span>
            )}
            <span className="ask-preview-asof">{asOfWords(ready.preview.asOf)}</span>
          </>
        )}
      </summary>
      <div className="ask-preview-body">
        {covers !== null && <p className="ask-note ask-covers">{covers}</p>}
        <div className="ask-preview-bar">
          <button type="button" className="quiet-button" onClick={onRefresh}>
            {W.refresh}
          </button>
          <span className="ask-preview-status" role="status">
            {load.kind === 'loading' ? W.building : ready?.sample ? W.sampleNote : ''}
          </span>
        </div>
        {load.kind === 'failed' && (
          <p className="inline-error" role="alert">
            {load.text}
          </p>
        )}
        {ready && <PreviewText preview={ready.preview} />}
        {ready?.preview.systemPrompt !== undefined && <p className="ask-note">{W.systemPromptNote}</p>}
        {ready?.preview.truncated && <p className="ask-note">{W.truncated}</p>}
        <p className="ask-note">{W.masking}</p>
      </div>
    </details>
  );
}

function AnswerBlock({
  answer,
  copy,
  onCopy,
  bodyRef,
  again,
  extra = null,
}: {
  answer: AskAnswer;
  copy: 'copied' | 'failed' | null;
  onCopy: () => void;
  bodyRef: (el: HTMLDivElement | null) => void;
  again: ReactNode;
  /** More actions after Copy (F28/F29 hand-offs). */
  extra?: ReactNode;
}) {
  const { simple } = useViewMode();
  const meta = answerMeta(answer, simple);
  return (
    <section className="ask-answer" aria-label={W.answer}>
      <p className="ask-meta">
        <span className="ask-answer-title">{W.answer}</span>
        {meta.map((m) => (
          <span key={m.key} className={`ask-meta-item${m.mono ? ' code' : ''}`} title={m.title}>
            {m.text}
          </span>
        ))}
      </p>
      <p className="ask-label">{W.answerLabel}</p>
      {/* The model writes light Markdown: drawn as React elements, every string a text child, no links (SECURITY.md). */}
      <div className="ask-body" ref={bodyRef}>
        <MessageText text={answer.text} />
      </div>
      <div className="ask-actions">
        {again}
        <button type="button" className="control control-quiet" onClick={onCopy}>
          {W.copyAnswer}
        </button>
        {extra}
        <span className="ask-copy-status" role="status">
          {copy === 'copied' ? W.copied : copy === 'failed' ? W.copyFailed : ''}
        </span>
      </div>
      <details className="ask-sent">
        <summary>{W.showSent}</summary>
        <pre className="ask-pre" tabIndex={0} aria-label={W.showSent}>
          {answer.sent}
        </pre>
      </details>
    </section>
  );
}

/** The question as the user typed it, in its own bubble (a text node). */
function QuestionBubble({ text }: { text: string }) {
  return (
    <div className="ask-q">
      <span className="ask-q-label">{W.youAsked}</span>
      <span className="ask-q-text">{text}</span>
    </div>
  );
}

export function AskPanel({
  enabled: settingsEnabled,
  status = null,
  query,
  onCommand,
  onClose,
  onOpenSettings,
  initialQuestion = null,
  prefill = null,
  layout = 'panel',
  initial = {},
  onMakeTask,
  onMakeSkill,
}: AskPanelProps) {
  const [question, setQuestion] = useState(() => prefillQuestion(prefill?.question ?? initialQuestion));
  const [turns, setTurns] = useState<ConversationTurn[]>(() =>
    initial.turns
      ? [...initial.turns]
      : initial.phase?.kind === 'answered'
        ? [{ question: prefillQuestion(initialQuestion), answer: initial.phase.answer }]
        : [],
  );
  const [phase, setPhase] = useState<AskPhase>(
    initial.phase?.kind === 'answered' ? { kind: 'idle' } : (initial.phase ?? { kind: 'idle' }),
  );
  const [preview, setPreview] = useState<PreviewLoad>(initial.preview ?? { kind: 'loading' });
  const [previewOpen, setPreviewOpen] = useState(initial.previewOpen ?? false);
  // Copy status of one turn's answer (by index); the initial one is the last turn's.
  const [copy, setCopy] = useState<{ at: number; state: 'copied' | 'failed' } | null>(() =>
    initial.copy ? { at: Math.max(0, (initial.turns?.length ?? 1) - 1), state: initial.copy } : null,
  );
  // A hand-off (the palette) fills the box again without dropping the conversation.
  const [seenPrefill, setSeenPrefill] = useState(prefill?.n ?? null);
  if (prefill !== null && prefill.n !== seenPrefill) {
    setSeenPrefill(prefill.n);
    setQuestion(prefillQuestion(prefill.question));
  }
  const box = useRef<HTMLTextAreaElement>(null);
  const bodies = useRef(new Map<number, HTMLDivElement>());
  const mounted = useRef(false);
  const inFlight = useRef(false);
  const previewSeq = useRef(0);
  const send = useRef(onCommand);
  send.current = onCommand;
  const turnsNow = useRef(turns);
  turnsNow.current = turns;
  /**
   * The `status` object seen when this view's own ask ended, or when its Cancel of another ask came back. Until a newer
   * state arrives (a new object), its `busy` is that ask's and is not shown as "another question".
   */
  const [settledOn, setSettledOn] = useState<AskStatus | null>(null);
  const statusNow = useRef(status);
  statusNow.current = status;
  const ids = useId();
  const offId = `${ids}-off`;
  const keyId = `${ids}-key`;
  const keysId = `${ids}-keys`;

  const live = askLive(status, settingsEnabled);
  const enabled = live.enabled;
  const asking = phase.kind === 'asking';
  // An ask this view did not start (or the state from before its own ended): shown up front with Cancel.
  const otherBusy = live.busy && !asking && status !== settledOn;
  // L1: a billed key or another provider refuses every ask; one up-front notice says which.
  const refusal = askRefusalKind(live);
  const blocked = { apiKeySet: live.apiKeySet, otherProvider: live.otherProvider, busy: otherBusy };
  const control = askControl(enabled, question, blocked);
  const lastQuestion = againQuestion(turns);
  const againControl = askControl(enabled, lastQuestion ?? '', blocked);
  const counter = questionCounter(question);
  const busyWords = failureWords({ kind: 'busy', message: '' }).text;
  const keyWords = refusal === null ? '' : failureWords({ kind: refusal, message: '' }).text;

  // Focus lands in the box when the panel opens (not on Home, where the card is one part of the screen). Leaving while
  // an ask is in flight cancels it.
  useEffect(() => {
    mounted.current = true;
    if (layout === 'panel') box.current?.focus();
    return () => {
      mounted.current = false;
      if (inFlight.current) void send.current(CANCEL_COMMAND);
    };
  }, [layout]);

  const loadPreview = useCallback(
    (q: string) => {
      const n = ++previewSeq.current;
      const typed = q.trim();
      setPreview((p) => (p.kind === 'ready' ? p : { kind: 'loading' }));
      const history = historyFor(turnsNow.current, false);
      void loadAskPreview(query, typed === '' ? SAMPLE_QUESTION : typed, history).then((r) => {
        if (!mounted.current || n !== previewSeq.current) return;
        setPreview(
          r.ok
            ? { kind: 'ready', preview: r.preview, sample: typed === '' }
            : { kind: 'failed', text: previewFailure(r) },
        );
      });
    },
    [query],
  );

  // Built again shortly after the question stops changing, and after each answer (the history it carries changes).
  useEffect(() => {
    const t = setTimeout(() => {
      loadPreview(question);
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      clearTimeout(t);
    };
  }, [question, turns, loadPreview]);

  useEffect(() => {
    if (copy?.state !== 'copied') return;
    const t = setTimeout(() => {
      setCopy(null);
    }, COPIED_MS);
    return () => {
      clearTimeout(t);
    };
  }, [copy]);

  /** Ask the question in the box, or (again) the last turn's question once more, with the history before it. */
  const start = (again: boolean) => {
    const q = again ? lastQuestion : question;
    const c = again ? againControl : control;
    if (q === null || !c.enabled || inFlight.current) return;
    inFlight.current = true;
    setCopy(null);
    const history = historyFor(turns, again);
    setPhase({ kind: 'asking', startedAt: Date.now(), question: q.trim(), again });
    // The box empties as soon as the question is sent (it shows as "You asked" above); a failed ask puts it back,
    // unless something new was typed meanwhile, so nothing typed is ever lost (owner, 2026-11-18).
    if (!again) setQuestion('');
    void runAsk(onCommand, q, history).then((o) => {
      inFlight.current = false;
      if (!mounted.current) return;
      setSettledOn(statusNow.current);
      if (o.kind === 'answer') {
        setTurns((prev) => addTurn(prev, { question: q.trim(), answer: o.answer }, again));
        setPhase({ kind: 'idle' });
      } else {
        if (!again) setQuestion((now) => (now === '' ? q : now));
        setPhase({ kind: 'failed', failure: o.failure });
      }
    });
  };

  const cancel = () => {
    void onCommand(CANCEL_COMMAND);
  };

  /** Cancel an ask this view did not start; its notice hides until a newer state says another is running. */
  const cancelOther = () => {
    const seen = statusNow.current;
    void onCommand(CANCEL_COMMAND).then(
      (r) => {
        if (mounted.current && r.ok) setSettledOn(seen);
      },
      () => undefined,
    );
  };

  const copyAnswer = (at: number, text: string) => {
    const failed = () => {
      if (!mounted.current) return;
      const sel = window.getSelection();
      const el = bodies.current.get(at);
      if (sel && el) sel.selectAllChildren(el);
      setCopy({ at, state: 'failed' });
    };
    try {
      void onCommand({ type: 'ask.copyAnswer', text }).then((r) => {
        if (!mounted.current) return;
        if (r.ok) setCopy({ at, state: 'copied' });
        else failed();
      }, failed);
    } catch {
      failed();
    }
  };

  const askingNow = (again: boolean) => phase.kind === 'asking' && (phase.again ?? false) === again;
  const askButton = (again: boolean) => (
    <ControlButton
      control={again ? againControl : control}
      onPress={() => {
        start(again);
      }}
      variant={again ? 'plain' : 'primary'}
      busy={asking}
      hint={again ? undefined : W.keys}
    >
      {askingNow(again) ? W.asking : again ? W.askAgain : W.ask}
    </ControlButton>
  );

  // A failure the up-front notices already say is not shown twice.
  const failure =
    phase.kind === 'failed' && !(phase.failure.kind === 'busy' && otherBusy) && !(phase.failure.kind === refusal)
      ? failureWords(phase.failure)
      : null;
  const describedBy = [enabled ? null : offId, refusal !== null ? keyId : null, keysId]
    .filter((x) => x !== null)
    .join(' ');
  // The "write a question" / "too long" hint; the off, API key and busy reasons have their own lines.
  const showHint = enabled && !control.enabled && !asking && refusal === null && !otherBusy;
  const card = layout === 'card';
  const pending =
    phase.kind === 'asking' && phase.again !== true && phase.question !== undefined ? phase.question : null;

  const conversation =
    turns.length > 0 || pending !== null ? (
      <div className="ask-conversation">
        {turns.map((t, i) => (
          <div key={`${String(i)}:${String(t.answer.askedAt)}`} className="ask-turn">
            <QuestionBubble text={t.question} />
            <AnswerBlock
              answer={t.answer}
              copy={copy?.at === i ? copy.state : null}
              onCopy={() => {
                copyAnswer(i, t.answer.text);
              }}
              bodyRef={(el) => {
                if (el) bodies.current.set(i, el);
                else bodies.current.delete(i);
              }}
              again={i === turns.length - 1 && pending === null ? askButton(true) : null}
              extra={
                onMakeTask || onMakeSkill ? (
                  <span className="ask-make">
                    {onMakeTask && (
                      <button
                        type="button"
                        className="control control-quiet"
                        onClick={() => {
                          onMakeTask(t.question, t.answer.text);
                        }}
                      >
                        {MAKE_WORDS.task}
                      </button>
                    )}
                    {onMakeSkill && (
                      <button
                        type="button"
                        className="control control-quiet"
                        onClick={() => {
                          onMakeSkill(t.question, t.answer.text);
                        }}
                      >
                        {MAKE_WORDS.skill}
                      </button>
                    )}
                  </span>
                ) : null
              }
            />
          </div>
        ))}
        {pending !== null && <QuestionBubble text={pending} />}
        {turns.length > 0 && <p className="ask-note">{W.notSaved}</p>}
      </div>
    ) : null;

  const form = (
    <div className="ask-form">
      <label className="ask-label-q" htmlFor={`${ids}-q`}>
        {turns.length > 0 ? W.followUp : W.questionLabel}
      </label>
      <textarea
        id={`${ids}-q`}
        ref={box}
        className={`text-input ask-box${enabled ? '' : ' is-off'}`}
        rows={card ? 2 : 3}
        maxLength={ASK_QUESTION_MAX}
        placeholder={W.placeholder}
        value={question}
        readOnly={!enabled}
        aria-disabled={enabled ? undefined : true}
        aria-describedby={describedBy}
        onChange={(e) => {
          setQuestion(e.target.value);
        }}
        onKeyDown={(e) => {
          if (askKey({ key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing }) !== 'ask') return;
          e.preventDefault();
          start(false);
        }}
      />
      <div className="ask-row">
        {askButton(false)}
        {phase.kind === 'asking' && (
          <>
            <button type="button" className="control control-quiet" onClick={cancel}>
              {W.cancel}
            </button>
            <span role="status">
              <Elapsed startedAt={phase.startedAt} {...(initial.now !== undefined ? { now: initial.now } : {})} />
            </span>
          </>
        )}
        <span className="ask-keys" id={keysId}>
          {W.keys}
        </span>
        {counter && (
          <span className="ask-counter" aria-live="polite">
            {counter}
          </span>
        )}
      </div>
      {showHint && <p className="ask-hint">{control.reason}</p>}
    </div>
  );

  const body = (
    <>
      {!enabled && <AskOff id={offId} onOpenSettings={onOpenSettings} />}
      {refusal !== null && (
        <p className="inline-error ask-upfront" id={keyId} role="status">
          <WithCode text={keyWords} />
        </p>
      )}
      {card && conversation}
      {/* Home's card while Ask is off: the reason and the way to Settings, not a box that cannot be sent. */}
      {(enabled || !card) && form}

      {otherBusy && (
        <div className="ask-failure ask-busy">
          <p className="ask-note" role="status">
            {busyWords}
          </p>
          <button type="button" className="control control-quiet" onClick={cancelOther}>
            {W.cancel}
          </button>
        </div>
      )}

      {failure && (
        <div className="ask-failure">
          <p className={failure.alert ? 'inline-error' : 'ask-note'} role={failure.alert ? 'alert' : 'status'}>
            <WithCode text={failure.text} />
          </p>
          {phase.kind === 'failed' && phase.failure.kind === 'busy' && (
            <button type="button" className="control control-quiet" onClick={cancel}>
              {W.cancel}
            </button>
          )}
        </div>
      )}

      <PreviewBlock
        enabled={enabled && refusal === null}
        covers={turns.length > 0 ? previewCovers(historyFor(turns, false).length) : null}
        load={preview}
        open={previewOpen}
        onToggle={(open) => {
          setPreviewOpen(open);
          if (open) loadPreview(question);
        }}
        onRefresh={() => {
          loadPreview(question);
        }}
      />

      {!card && conversation}
    </>
  );

  if (card)
    return (
      <section className="home-card ask ask-card" aria-label={W.title}>
        <header className="ask-card-head">
          <h2 className="ask-card-title">{W.title}</h2>
          <span className="pill">{W.pill}</span>
          <span className="ask-card-note">{W.notSavedShort}</span>
        </header>
        <p className="ask-intro">{W.intro}</p>
        <div className="ask-panel ask-card-body">{body}</div>
      </section>
    );

  return (
    <article className="detail ask" aria-label={W.title}>
      <header className="detail-head">
        <div className="name-block">
          <h1 className="agent-name">{W.title}</h1>
          {onClose && (
            <button type="button" className="quiet-button" onClick={onClose}>
              {W.back}
            </button>
          )}
        </div>
        <p className="ask-intro">{W.intro}</p>
      </header>
      <div className="panel ask-panel">{body}</div>
    </article>
  );
}
