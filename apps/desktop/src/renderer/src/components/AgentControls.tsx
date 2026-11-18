/**
 * What the user can do to one agent from its detail pane (M3): pause or resume (F13) with the hold countdown, and the
 * message composer with its queued outbox (F12). Every button is a ControlButton fed from `selectControls`; where a
 * message lands comes from `whereMessageLands`. Queued text is the user's own, still rendered as text.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  selectControls,
  selectSessionBudgetPaused,
  type AgentNode,
  type ComposerMode,
  type ControlsView,
  type HuddleState,
} from '@huddle/shared';
import { ResumeAllButton } from './Budget.js';
import { useNow } from '../useNow.js';
import { clockTime, clockTimeFull } from '../view/format.js';
import {
  cancelMessageCommand,
  deliveryWords,
  effectiveMode,
  MESSAGE_AUTHOR_WORDS,
  messageAuthorWords,
  landingLine,
  messageCommand,
  modeOptions,
  MESSAGE_MAX,
  pauseCommand,
  resumeCommand,
} from '../view/composer.js';
import { countdown, type HoldEnding } from '../view/inbox.js';
import { ControlButton } from './ControlButton.js';
import type { SendCommand } from './Inbox.js';

export function agentControls(state: HuddleState, agent: AgentNode): ControlsView {
  return selectControls(agent, state.connection, state.connection?.startedAt);
}

function Ticking({ render, now }: { render: (now: number) => ReactNode; now?: number }) {
  const ticking = useNow(1000);
  return <>{render(now ?? ticking)}</>;
}

/**
 * The pause line in the detail head: Pause, or Resume while held, or "Cancel pause" while a pause waits for the next
 * tool call. A hold shows when Huddle lets go by itself (`hold.limitAt`); after a hold, how it ended.
 */
export function PauseControl({
  state,
  agent,
  onCommand,
  lastEnding = null,
  now,
  wordsOnly = false,
}: {
  state: HuddleState;
  agent: AgentNode;
  onCommand: SendCommand;
  lastEnding?: HoldEnding | null;
  now?: number;
  /** The button lives elsewhere (the session head): show only the pause words, and nothing when there are none. */
  wordsOnly?: boolean;
}) {
  const controls = agentControls(state, agent);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const hold = agent.hold ?? null;
  const pending = agent.pausePending === true;
  const send = (cmd: Parameters<SendCommand>[0]) => {
    setBusy(true);
    setError(null);
    void onCommand(cmd).then((r) => {
      setBusy(false);
      if (!r.ok) setError(r.message);
    });
  };
  const showResume = hold !== null || pending;
  // On a session's main agent: the agents a budget paused across the session (M4 runbook: Cancel pause on the root
  // left a held subagent paused). Offered as its own button, so Resume / Cancel pause keeps meaning "this agent".
  // Shown only when it reaches beyond this agent.
  const budgetPaused = agent.parentKey === null ? selectSessionBudgetPaused(state, agent.sessionId) : [];
  const sessionPaused = budgetPaused.some((a) => a.key !== agent.key) ? budgetPaused : [];
  const button = showResume ? controls.resume : controls.pause;
  if (wordsOnly && hold === null && !pending && lastEnding === null && sessionPaused.length === 0 && error === null)
    return null;

  return (
    <div className="pause-line">
      {wordsOnly ? null : showResume ? (
        <ControlButton
          control={controls.resume}
          onPress={() => {
            send(resumeCommand(agent.key));
          }}
          hint={hold ? 'Let the agent carry on' : 'Call off the pause before it starts'}
          busy={busy}
        >
          {hold ? 'Resume' : 'Cancel pause'}
        </ControlButton>
      ) : (
        <ControlButton
          control={controls.pause}
          onPress={() => {
            send(pauseCommand(agent.key));
          }}
          hint="Hold the agent at its next tool call"
          busy={busy}
        >
          Pause
        </ControlButton>
      )}
      {sessionPaused.length > 0 && (
        <ResumeAllButton
          agents={sessionPaused}
          onCommand={onCommand}
          label={`Resume all ${String(sessionPaused.length)}`}
          hint={`A budget paused ${String(sessionPaused.length)} agents of this session: ${sessionPaused.map((a) => a.name).join(', ')}. Resume every one of them`}
        />
      )}
      {!wordsOnly && !button.enabled && button.reason !== null && (
        <span className="pause-words control-reason">{button.reason}</span>
      )}
      {hold !== null ? (
        <span className="pause-words tone-paused">
          <span title={`Paused since ${clockTimeFull(hold.since)}; Huddle lets go at ${clockTimeFull(hold.limitAt)}`}>
            <Ticking now={now} render={(t) => `resumes by itself in ${countdown(hold.limitAt - t)}`} />
          </span>
        </span>
      ) : pending ? (
        <span className="pause-words tone-paused">pausing at the next tool call</span>
      ) : lastEnding !== null ? (
        <span className="pause-words muted" title={clockTimeFull(lastEnding.ts)}>
          last pause {lastEnding.words} at {clockTime(lastEnding.ts)}
        </span>
      ) : null}
      {error && (
        <span className="inline-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

/** The composer and the queued messages, as one detail section. */
export function MessageSection({
  state,
  agent,
  onCommand,
  collapsible = false,
  openSignal = 0,
  openText,
  onSignalUsed,
}: {
  state: HuddleState;
  agent: AgentNode;
  onCommand: SendCommand;
  /**
   * The agent panel (2026-11-18 design pass): the box starts closed as one "Message…" row, so the timeline gets the
   * height; it opens on that button or on `openSignal`, and stays open while messages wait to be delivered.
   */
  collapsible?: boolean;
  /** Bumped by the session head's Message: open the box and put the focus in it. */
  openSignal?: number;
  /** With a new signal: put this text in the box (Team talk's Forward). The user edits and sends it; nothing is sent. */
  openText?: string;
  /** Called once the signal has opened the box and focused it, so a later re-pick of the agent does not do it again. */
  onSignalUsed?: () => void;
}) {
  const controls = agentControls(state, agent);
  const [opened, setOpened] = useState(openSignal > 0);
  const [focusTick, setFocusTick] = useState(openSignal > 0 ? 1 : 0);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(openSignal > 0 ? (openText ?? '') : '');
  useEffect(() => {
    if (openSignal === 0) return;
    setOpened(true);
    if (openText !== undefined) setText(openText);
    setFocusTick((n) => n + 1);
    // Only a new signal opens the box; the text rides along with it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openSignal]);
  useEffect(() => {
    if (focusTick === 0) return;
    textRef.current?.focus();
    onSignalUsed?.();
    // Only a new tick focuses; the callback's identity does not matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusTick]);
  const [chosen, setChosen] = useState<ComposerMode>('auto');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mode = effectiveMode(chosen, controls);
  const outbox = agent.outbox ?? [];
  const cmd = messageCommand(agent.key, text, mode);
  const sendControl =
    controls.message.enabled && cmd === null ? { enabled: false, reason: 'Write a message first.' } : controls.message;

  const send = () => {
    if (cmd === null || busy) return;
    setBusy(true);
    setError(null);
    void onCommand(cmd).then((r) => {
      setBusy(false);
      if (r.ok) setText('');
      else setError(r.message);
    });
  };
  const cancel = (messageId: string) => {
    void onCommand(cancelMessageCommand(agent.key, messageId)).then((r) => {
      if (!r.ok) setError(r.message);
    });
  };

  if (collapsible && !opened && outbox.length === 0 && text === '') {
    return (
      <section className="composer composer-closed" aria-label="Message">
        <ControlButton
          control={controls.message}
          variant="quiet"
          onPress={() => {
            setOpened(true);
            setFocusTick((n) => n + 1);
          }}
          hint="Write to this agent"
        >
          Message…
        </ControlButton>
        {!controls.message.enabled && <p className="composer-lands">{controls.message.reason}</p>}
      </section>
    );
  }

  return (
    <section className="meter-section composer" aria-labelledby={`composer-${agent.key}`}>
      <h2 className="section-title" id={`composer-${agent.key}`}>
        Message
      </h2>
      <label className="visually-hidden" htmlFor={`composer-text-${agent.key}`}>
        Message to the agent
      </label>
      <textarea
        ref={textRef}
        id={`composer-text-${agent.key}`}
        className="text-input composer-text"
        rows={2}
        maxLength={MESSAGE_MAX}
        placeholder="Message this agent (Ctrl+Enter sends)"
        value={text}
        aria-disabled={controls.message.enabled ? undefined : true}
        readOnly={!controls.message.enabled}
        title={controls.message.reason ?? undefined}
        onChange={(e) => {
          setText(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && e.ctrlKey) {
            e.preventDefault();
            if (sendControl.enabled) send();
          }
        }}
      />
      <div className="composer-row">
        <div className="segmented" role="radiogroup" aria-label="When it lands">
          {modeOptions(controls).map((o) => (
            <button
              key={o.mode}
              type="button"
              role="radio"
              aria-checked={mode === o.mode}
              aria-disabled={o.control.enabled ? undefined : true}
              className={`segment${o.control.enabled ? '' : ' is-off'}`}
              title={o.control.reason ?? undefined}
              onClick={() => {
                if (o.control.enabled) setChosen(o.mode);
              }}
            >
              {o.label}
            </button>
          ))}
        </div>
        {/* Where it lands, or why it cannot be sent, on the same row as Send (owner review: less height). */}
        <p className="composer-lands">
          {controls.message.enabled ? landingLine(agent, mode) : controls.message.reason}
        </p>
        <ControlButton
          control={sendControl}
          onPress={send}
          variant="primary"
          hint="Queue this message"
          shortcut="Control+Enter"
          busy={busy}
        >
          Send
        </ControlButton>
      </div>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {outbox.length > 0 && (
        <>
          <h3 className="inbox-sub">Waiting to be delivered</h3>
          <ul className="outbox">
            {outbox.map((m) => (
              <li key={m.messageId} className={`outbox-row${m.author === 'huddle' ? ' is-automatic' : ''}`}>
                <span className="outbox-text">{m.text}</span>
                <span className="outbox-meta" title={clockTimeFull(m.queuedAt)}>
                  <span
                    className="outbox-author"
                    title={m.author === 'huddle' ? MESSAGE_AUTHOR_WORDS.huddleTitle : undefined}
                  >
                    {messageAuthorWords(m)}
                  </span>
                  {' · '}
                  {deliveryWords(m.delivery)}, queued {clockTime(m.queuedAt)}
                </span>
                <ControlButton
                  control={controls.cancelMessage}
                  onPress={() => {
                    cancel(m.messageId);
                  }}
                  variant="quiet"
                  hint="Take this message back"
                >
                  Cancel
                </ControlButton>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
