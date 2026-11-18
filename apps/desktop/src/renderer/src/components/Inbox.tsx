/**
 * The inbox (M3): approval cards (F10), question cards (F11) and detector cards (F21). One card component serves the
 * main window's Needs you section (NeedsYou.tsx, full card on Open) and the widget's pinned item (`compact`).
 *
 * Every button is a ControlButton fed from `selectControls` (view/inbox.ts `itemControls`). Every string from an
 * agent (titles, commands, questions, option labels) is a React text node. Inside a focused card: A allows, D opens
 * deny, T passes to the terminal, 1–9 pick an option.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import {
  CLIP_LIMITS,
  selectBudgetPaused,
  selectDismissControl,
  type AgentKey,
  type ApprovalRequest,
  type AskQuestion,
  type AttentionItem,
  type CommandResult,
  type HuddleCommand,
  type HuddleEvent,
  type HuddleState,
} from '@huddle/shared';
import { agentLabel, type HuddleStore } from '../store.js';
import { useNow } from '../useNow.js';
import { useAgentEvents } from '../useTimeline.js';
import { clockTime, clockTimeFull, UNKNOWN } from '../view/format.js';
import {
  allowCommand,
  answersCommand,
  approvalLimit,
  denyCommand,
  dismissCommand,
  handledAt,
  hiddenCommandWords,
  itemControls,
  itemEnding,
  kindWords,
  passThroughCommand,
  pickComplete,
  pickSummary,
  questionHasPicks,
  questionLimit,
  questionTerminalControl,
  togglePick,
  typePick,
  type QuestionPick,
  type LimitWords,
} from '../view/inbox.js';
import { approvalShortcut, armControl } from '../view/arming.js';
import { MESSAGE_MAX } from '../view/composer.js';
import { useArming } from './Arming.js';
import { ResumeAllButton } from './Budget.js';
import { ControlButton } from './ControlButton.js';

export type SendCommand = (cmd: HuddleCommand) => Promise<CommandResult>;

export interface InboxCardProps {
  state: HuddleState;
  item: AttentionItem;
  renames: ReadonlyMap<AgentKey, string>;
  onCommand: SendCommand;
  /** Click on the agent's name: select it (main) or open it in the main window (widget). */
  onAgent?: (key: AgentKey) => void;
  /** Widget layout: fewer lines, no option descriptions. */
  compact?: boolean;
  /**
   * Inside a widget session card (Widget v2): the card's need line already shows the glyph, the kind and who asked,
   * so the header keeps only the time limit.
   */
  inline?: boolean;
  /** Deep-linked (`#item=`): highlighted and scrolled into view. */
  selected?: boolean;
  /** The agent's recent events, for how a handled item ended. */
  events?: readonly HuddleEvent[];
  /** Fixed clock for tests; otherwise the card's countdown ticks every second. */
  now?: number;
  cardRef?: RefObject<HTMLElement | null>;
  /**
   * What the arming delay is keyed on; defaults to the item id. The widget adds the card's slot, so a waiting card that
   * moves into the spot the user just clicked (its neighbour was answered and sank) is armed again, as if new.
   */
  armKey?: string;
}

const ACCEPTED = 'Sent. Waiting for Claude Code…';

/** What the card shows while or after a command is sent. */
interface Sending {
  busy: string | null;
  sent: string | null;
  error: string | null;
}

export function useSender(onCommand: SendCommand) {
  const [s, setS] = useState<Sending>({ busy: null, sent: null, error: null });
  const send = (cmd: HuddleCommand, label: string) => {
    if (s.busy !== null) return;
    setS({ busy: label, sent: null, error: null });
    void onCommand(cmd).then((r) => {
      setS(r.ok ? { busy: null, sent: label, error: null } : { busy: null, sent: null, error: r.message });
    });
  };
  return { ...s, send };
}

/** The time limit, ticking every second (only this span re-renders). */
function Limit({ words, now }: { words: (now: number) => LimitWords; now?: number }) {
  // A parent that passes `now` already ticks; only a card on its own starts a timer.
  const ticking = useNow(now === undefined ? 1000 : null);
  const w = words(now ?? ticking);
  return (
    <span className="card-limit" title={w.title || undefined}>
      {w.text}
    </span>
  );
}

export function AgentName({
  state,
  agentKey,
  renames,
  onAgent,
}: {
  state: HuddleState;
  agentKey: AgentKey;
  renames: ReadonlyMap<AgentKey, string>;
  onAgent?: (key: AgentKey) => void;
}) {
  const agent = Object.hasOwn(state.agents, agentKey) ? state.agents[agentKey] : undefined;
  const name = agent ? agentLabel(state, agent, renames) : UNKNOWN;
  if (!agent || !onAgent) return <span className="card-agent">{name}</span>;
  return (
    <button
      type="button"
      className="card-agent link-button"
      onClick={() => {
        onAgent(agentKey);
      }}
      title="Show this agent"
    >
      {name}
    </button>
  );
}

/** The card's status words: sending, sent, or what went wrong. */
export function SendLine({ s }: { s: Sending }) {
  if (s.error !== null)
    return (
      <p className="card-error" role="alert">
        {s.error}
      </p>
    );
  if (s.busy !== null) return <p className="card-note">Sending {s.busy}…</p>;
  if (s.sent !== null) return <p className="card-note">{`${s.sent}: ${ACCEPTED}`}</p>;
  return null;
}

/**
 * Why buttons are off, in words under them (not only in tooltips): one line when every button is off for the same
 * reason, else one "<button>: <reason>" line per button that is off. Nothing when all are on.
 */
function ReasonLine({ reasons }: { reasons: readonly (readonly [string, string | null])[] }) {
  const off = reasons.filter((r): r is readonly [string, string] => r[1] !== null);
  if (off.length === 0) return null;
  const set = new Set(off.map((r) => r[1]));
  const [only] = set;
  if (off.length === reasons.length && set.size === 1 && only !== undefined)
    return <p className="card-reason">{only}</p>;
  return (
    <>
      {off.map(([label, reason]) => (
        <p key={label} className="card-reason">
          {label}: {reason}
        </p>
      ))}
    </>
  );
}

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target;
  return t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement;
}

// --- approval ---------------------------------------------------------------------------------------------------

/** The plain warning line when the summary does not show the whole command (AX-01). Words only, no colour signal. */
export function HiddenCommandLine({ req }: { req: ApprovalRequest | undefined }) {
  const words = hiddenCommandWords(req);
  return words === null ? null : (
    <p className="card-detail card-hidden" role="note">
      {words}
    </p>
  );
}

function ApprovalBody(props: InboxCardProps) {
  const { state, item, onCommand, compact = false } = props;
  const req = item.approval;
  // A request that just arrived ignores presses for a moment (view/arming.ts): a double-click must not answer the
  // next request that mounts in the same spot.
  const arming = useArming(props.armKey ?? item.id);
  // Unique per card: the same request can show twice (sidebar and the session's "Why it is asking").
  const denyId = `deny-${useId()}`;
  const raw = itemControls(state, item);
  const controls = {
    ...raw,
    approve: armControl(raw.approve, arming.armed),
    deny: armControl(raw.deny, arming.armed),
    passThrough: armControl(raw.passThrough, arming.armed),
  };
  const sender = useSender(onCommand);
  const [denying, setDenying] = useState(false);
  const [note, setNote] = useState('');
  const noteRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (denying) noteRef.current?.focus();
  }, [denying]);
  if (req === undefined) return null;

  const allow = () => {
    arming.guard(() => {
      sender.send(allowCommand(req.requestId), 'Allow');
    });
  };
  const deny = () => {
    arming.guard(() => {
      sender.send(denyCommand(req.requestId, note), 'Deny');
      setDenying(false);
    });
  };
  const pass = () => {
    arming.guard(() => {
      sender.send(passThroughCommand(req.requestId), 'Pass to terminal');
    });
  };
  const openDeny = () => {
    arming.guard(() => {
      setDenying(true);
    });
  };
  const onKey = (e: KeyboardEvent) => {
    if (isTyping(e) || e.ctrlKey || e.altKey || e.metaKey) return;
    const action = approvalShortcut(e.key, controls);
    if (action === null) return;
    if (action === 'allow') allow();
    else if (action === 'deny') openDeny();
    else pass();
    e.preventDefault();
  };

  return (
    <div className="card-body" onKeyDown={onKey}>
      <p className="card-request">
        <span className="card-tool">{req.toolName}</span>
        <span className="card-summary code" title={req.summary}>
          {req.summary || UNKNOWN}
        </span>
      </p>
      <HiddenCommandLine req={req} />
      {!compact && item.detail && item.detail !== `${req.toolName}: ${req.summary}` && (
        <p className="card-detail">{item.detail}</p>
      )}
      {denying ? (
        <form
          className="deny-form"
          onSubmit={(e) => {
            e.preventDefault();
            deny();
          }}
        >
          <label className="deny-label" htmlFor={denyId}>
            Tell the agent why (optional)
          </label>
          <textarea
            id={denyId}
            ref={noteRef}
            className="text-input deny-note"
            rows={compact ? 2 : 3}
            maxLength={MESSAGE_MAX}
            value={note}
            onChange={(e) => {
              setNote(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || !e.shiftKey)) {
                e.preventDefault();
                deny();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setDenying(false);
              }
            }}
          />
          <div className="card-actions">
            <ControlButton control={controls.deny} onPress={deny} variant="primary" hint="Deny and send the note">
              Deny
            </ControlButton>
            <button
              type="button"
              className="control control-quiet"
              onClick={() => {
                setDenying(false);
              }}
            >
              Back
            </button>
          </div>
        </form>
      ) : (
        <div className="card-actions">
          <ControlButton
            control={controls.approve}
            onPress={allow}
            variant="primary"
            shortcut="A"
            hint="Allow this call"
            busy={sender.busy !== null}
          >
            Allow
          </ControlButton>
          <ControlButton
            control={controls.deny}
            onPress={openDeny}
            shortcut="D"
            hint="Deny, with a note for the agent if you like"
            busy={sender.busy !== null}
          >
            Deny…
          </ControlButton>
          <ControlButton
            control={controls.passThrough}
            onPress={pass}
            variant={compact ? 'plain' : 'quiet'}
            shortcut="T"
            hint="Let Claude Code ask in the terminal instead"
            busy={sender.busy !== null}
          >
            {compact ? 'Terminal' : 'Pass to terminal'}
          </ControlButton>
        </div>
      )}
      {/* The reasons the request itself gives; the brief arming delay shows only on the buttons (no line that jumps). */}
      <ReasonLine
        reasons={[
          ['Allow', raw.approve.reason],
          ['Deny', raw.deny.reason],
          [compact ? 'Terminal' : 'Pass to terminal', raw.passThrough.reason],
        ]}
      />
      <SendLine s={sender} />
    </div>
  );
}

// --- question ---------------------------------------------------------------------------------------------------

function QuestionBlock({
  q,
  index,
  pick,
  compact,
  onPick,
  onType,
  answerOff,
}: {
  q: AskQuestion;
  index: number;
  pick: QuestionPick | undefined;
  compact: boolean;
  onPick: (label: string) => void;
  onType: (text: string) => void;
  answerOff: { enabled: boolean; reason: string | null };
}) {
  const typed = pick?.typed ?? '';
  return (
    <div className="question" role="group" aria-label={q.header ?? `Question ${String(index + 1)}`}>
      {q.header && <p className="question-header">{q.header}</p>}
      <p className="question-text">{q.question}</p>
      {q.multiSelect && <p className="question-hint">Choose any that apply.</p>}
      {q.options.length > 0 && (
        <div className="options">
          {q.options.map((o, i) => (
            <ControlButton
              key={`${String(i)}:${o.label}`}
              control={answerOff}
              onPress={() => {
                onPick(o.label);
              }}
              shortcut={index === 0 && i < 9 ? String(i + 1) : undefined}
              hint={o.description ?? (q.multiSelect ? `Choose "${o.label}" too` : `Answer "${o.label}"`)}
              className={`option${q.multiSelect ? ' is-multi' : ''}`}
              pressed={pick?.labels.includes(o.label) ?? false}
            >
              <span className="option-dot" aria-hidden="true" />
              <span className="option-words">
                <span className="option-label">{o.label}</span>
                {!compact && o.description && <span className="option-desc">{o.description}</span>}
              </span>
            </ControlButton>
          ))}
        </div>
      )}
      <input
        type="text"
        className="question-other"
        value={typed}
        maxLength={CLIP_LIMITS.message}
        disabled={!answerOff.enabled}
        title={answerOff.reason ?? undefined}
        placeholder={
          q.options.length === 0
            ? 'Type your answer'
            : q.multiSelect
              ? 'Other: add your own words (optional)'
              : 'Other: type your own answer instead'
        }
        aria-label={`Your own answer to: ${q.question}`}
        onChange={(e) => {
          onType(e.currentTarget.value);
        }}
      />
    </div>
  );
}

function QuestionBody(props: InboxCardProps) {
  const { state, item, onCommand, compact = false } = props;
  const request = item.question;
  // Same arming delay as approvals (view/arming.ts): picks, Send and Answer in terminal wait for it.
  const arming = useArming(props.armKey ?? item.id);
  const raw = itemControls(state, item);
  const controls = { ...raw, answer: armControl(raw.answer, arming.armed) };
  const terminal = armControl(questionTerminalControl(raw), arming.armed);
  const sender = useSender(onCommand);
  const [picks, setPicks] = useState<ReadonlyMap<number, QuestionPick>>(new Map());
  if (request === undefined) return null;
  const canPick = questionHasPicks(request.questions);
  const single = request.questions.length === 1;
  const complete = request.questions.every((_, i) => pickComplete(picks.get(i)));

  const send = () => {
    const list = request.questions.flatMap((q, i) => {
      const pick = picks.get(i);
      return pick !== undefined && pickComplete(pick) ? [{ question: q, pick }] : [];
    });
    if (list.length !== request.questions.length) return;
    arming.guard(() => {
      sender.send(answersCommand(request.requestId, list), pickSummary(list.map((p) => p.pick)));
    });
  };
  // A pick only selects; Send sends (Widget v2, owner's choice 2026-11-14): one stray click in an always-on-top
  // widget must not answer an agent, the same lesson as the palette's deliberate pick.
  const pick = (index: number, label: string) => {
    const q = request.questions[index];
    if (q === undefined) return;
    arming.guard(() => {
      const next = new Map(picks);
      next.set(index, togglePick(q, picks.get(index), label));
      setPicks(next);
    });
  };
  // Typing is not guarded by the arming delay: it sends nothing, and Send still waits for it.
  const typeAnswer = (index: number, text: string) => {
    const q = request.questions[index];
    if (q === undefined) return;
    setPicks((cur) => {
      const next = new Map(cur);
      next.set(index, typePick(q, cur.get(index), text));
      return next;
    });
  };
  const sendControl =
    controls.answer.enabled && !complete
      ? {
          enabled: false,
          reason: single ? 'Pick an answer or type one first.' : 'Answer every question first.',
        }
      : controls.answer;
  const pass = () => {
    arming.guard(() => {
      sender.send(passThroughCommand(request.requestId), 'Answer in terminal');
    });
  };
  const onKey = (e: KeyboardEvent) => {
    if (isTyping(e) || e.ctrlKey || e.altKey || e.metaKey) return;
    const first = request.questions[0];
    const n = Number(e.key);
    const k = e.key.toLowerCase();
    if (canPick && controls.answer.enabled && first && Number.isInteger(n) && n >= 1 && n <= first.options.length) {
      const opt = first.options[n - 1];
      if (opt) pick(0, opt.label);
    } else if (k === 's' && canPick && sendControl.enabled && sender.busy === null) send();
    else if (k === 't' && terminal.enabled) pass();
    else return;
    e.preventDefault();
  };
  const answerOff = sender.busy !== null ? { enabled: false, reason: 'Sending…' } : controls.answer;

  return (
    <div className="card-body" onKeyDown={onKey}>
      {request.questions.map((q, i) => (
        <QuestionBlock
          key={`${String(i)}:${q.question}`}
          q={q}
          index={i}
          pick={picks.get(i)}
          compact={compact}
          answerOff={answerOff}
          onPick={(label) => {
            pick(i, label);
          }}
          onType={(text) => {
            typeAnswer(i, text);
          }}
        />
      ))}
      <div className="card-actions">
        {canPick && (
          <ControlButton
            control={sendControl}
            onPress={send}
            variant="primary"
            shortcut="S"
            hint={single ? 'Send this answer' : 'Send these answers'}
            busy={sender.busy !== null}
          >
            {single ? 'Send' : 'Send answers'}
          </ControlButton>
        )}
        <ControlButton
          control={terminal}
          onPress={pass}
          // A graphite pill like Deny… and Terminal: as a plain word next to the Send pill it was easy to miss.
          variant="plain"
          shortcut="T"
          hint="Huddle steps aside and Claude Code shows its own question box"
          busy={sender.busy !== null}
        >
          Answer in terminal
        </ControlButton>
      </div>
      {!raw.answer.enabled ? (
        <p className="card-reason">{raw.answer.reason}</p>
      ) : (
        canPick && !complete && <p className="card-reason">{sendControl.reason}</p>
      )}
      <SendLine s={sender} />
    </div>
  );
}

// --- detectors (stuck, loop, conflict) --------------------------------------------------------------------------

function DetectorBody(props: InboxCardProps) {
  const { state, item, onCommand, renames, onAgent, compact = false } = props;
  const sender = useSender(onCommand);
  const related = (item.relatedAgentKeys ?? []).filter((k) => k !== item.agentKey);
  // A budget item names the agents it still holds paused (their Huddle pause carries this item's id).
  const paused = item.kind === 'budget' ? selectBudgetPaused(state, item.id) : [];
  const dismiss = selectDismissControl(state, item);
  return (
    <div className="card-body">
      {item.detail && <p className="card-detail">{item.detail}</p>}
      {!compact && related.length > 0 && (
        <p className="card-related">
          also{' '}
          {related.map((k, i) => (
            <span key={k}>
              {i > 0 && ', '}
              <AgentName state={state} agentKey={k} renames={renames} onAgent={onAgent} />
            </span>
          ))}
        </p>
      )}
      {paused.length > 0 && (
        <p className="card-related">
          still paused{' '}
          {paused.map((a, i) => (
            <span key={a.key}>
              {i > 0 && ', '}
              <AgentName state={state} agentKey={a.key} renames={renames} onAgent={onAgent} />
            </span>
          ))}
        </p>
      )}
      <div className="card-actions">
        {paused.length > 0 && (
          <ResumeAllButton
            agents={paused}
            onCommand={onCommand}
            hint={`Resume the ${String(paused.length)} agent${paused.length === 1 ? '' : 's'} this budget paused`}
          />
        )}
        <ControlButton
          // Dismissing is Huddle's own bookkeeping: it works whatever the agent or the connection is doing, except a
          // budget item that still holds agents paused (shared selectDismissControl; the core checks it again).
          control={dismiss}
          onPress={() => {
            sender.send(dismissCommand(item.id), 'Dismiss');
          }}
          variant="quiet"
          hint={
            item.kind === 'budget'
              ? 'Hide this; it is not raised again for this budget setting'
              : 'Hide this until it happens again'
          }
          busy={sender.busy !== null}
        >
          Dismiss
        </ControlButton>
      </div>
      <SendLine s={sender} />
    </div>
  );
}

// --- handled ----------------------------------------------------------------------------------------------------

function HandledBody({ item, events }: { item: AttentionItem; events: readonly HuddleEvent[] }) {
  const ending = itemEnding(item, events);
  return (
    <div className="card-body">
      {item.approval && (
        <p className="card-request">
          <span className="card-tool">{item.approval.toolName}</span>
          <span className="card-summary code">{item.approval.summary || UNKNOWN}</span>
        </p>
      )}
      {item.question?.questions[0] && <p className="question-text">{item.question.questions[0].question}</p>}
      {ending ? (
        <>
          {ending.answered.length > 0 && (
            <ul className="answered" aria-label="What Huddle answered">
              {ending.answered.map((a) => (
                <li key={a.question}>
                  <span className="answered-label">Huddle answered</span>{' '}
                  <span className="answered-text">{a.answer}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="card-note">{ending.text}</p>
          {ending.note && (
            <p className="card-note">
              With the note: <span className="answered-text">{ending.note}</span>
            </p>
          )}
        </>
      ) : null}
      {item.resolvedAt !== null && (
        <p className="card-time" title={clockTimeFull(item.resolvedAt)}>
          {handledAt(item)}
        </p>
      )}
    </div>
  );
}

// --- the card ---------------------------------------------------------------------------------------------------

export function glyphFor(item: AttentionItem): { glyph: string; tone: string } {
  if (item.resolvedAt !== null) return { glyph: '✓', tone: 'idle' };
  if (item.kind === 'approval' || item.kind === 'question') return { glyph: '▲', tone: 'needs-you' };
  return { glyph: '!', tone: 'needs-you' };
}

export function InboxCard(props: InboxCardProps) {
  const { state, item, renames, onAgent, compact = false, inline = false, selected = false, now } = props;
  const look = glyphFor(item);
  const handled = item.resolvedAt !== null;
  const limit =
    handled || item.kind === 'stuck' || item.kind === 'loop' || item.kind === 'file_conflict'
      ? null
      : item.kind === 'approval' && item.approval
        ? (t: number) => approvalLimit(item.approval?.expiresAt ?? null, t)
        : item.kind === 'question'
          ? (t: number) => questionLimit(state, item, t)
          : null;

  return (
    <article
      ref={props.cardRef}
      className={`card kind-${item.kind}${handled ? ' is-handled' : ''}${selected ? ' is-selected' : ''}${compact ? ' is-compact' : ''}${inline ? ' is-inline' : ''}`}
      aria-label={`${kindWords(item)}: ${item.title}`}
      data-item={item.id}
      tabIndex={-1}
    >
      <header className="card-head">
        {!inline && (
          <span className={`glyph tone-${look.tone}`} aria-hidden="true">
            {look.glyph}
          </span>
        )}
        {!inline && <AgentName state={state} agentKey={item.agentKey} renames={renames} onAgent={onAgent} />}
        {!inline && <span className={`card-kind${handled ? '' : ' tone-needs-you'}`}>{kindWords(item)}</span>}
        {limit ? (
          <Limit words={limit} now={now} />
        ) : (
          <span className="card-limit" title={clockTimeFull(item.createdAt)}>
            {clockTime(item.createdAt)}
          </span>
        )}
      </header>
      {handled ? (
        <HandledBody item={item} events={props.events ?? []} />
      ) : item.kind === 'approval' ? (
        <ApprovalBody {...props} />
      ) : item.kind === 'question' ? (
        <QuestionBody {...props} />
      ) : (
        <DetectorBody {...props} />
      )}
    </article>
  );
}

// --- handled cards (Needs you, Recently handled) ----------------------------------------------------------------

/** A handled card that reads its agent's events to say how it ended. */
export function HandledCard(props: Omit<InboxCardProps, 'events'> & { store: HuddleStore }) {
  const { store, ...rest } = props;
  const { events } = useAgentEvents(store, props.item.agentKey);
  return <InboxCard {...rest} events={events} />;
}
