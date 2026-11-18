/**
 * Team talk (2026-11-18): the session's hand-offs as a conversation (view/team-talk.ts). Each speaker wears its type's
 * hat. An answer can be forwarded to another agent of the session: that opens the agent's message box with the answer
 * filled in, and the user sends it (the Huddle never sends a message by itself). All agent text is rendered as text.
 */
import { useId, useState } from 'react';
import type { AgentKey, HuddleState } from '@huddle/shared';
import { faceHue, faceMood } from '../view/face.js';
import { clockTime } from '../view/format.js';
import {
  forwardTargets,
  forwardText,
  partyType,
  TALK_WORDS as W,
  teamTalk,
  type TalkEntry,
  type TalkParty,
} from '../view/team-talk.js';
import { displayName } from '../store.js';
import { ControlButton } from './ControlButton.js';
import { Face } from './Face.js';
import { MessageText } from './MessageText.js';

const ON = { enabled: true, reason: null };
/** Longer than this many characters starts folded, with Show all. */
const FOLD_AT = 420;

function Speaker({ p, sessionId }: { p: TalkParty; sessionId: string }) {
  return (
    <span className="talk-face" aria-hidden="true">
      <Face mood={faceMood(p.status)} hue={faceHue(sessionId)} type={p.type} />
    </span>
  );
}

function Who({ p }: { p: TalkParty }) {
  const type = partyType(p);
  return (
    <span className="talk-who">
      <span className="talk-name">{p.name}</span>
      {type !== null && <span className="talk-type">{type}</span>}
    </span>
  );
}

function Entry({
  entry,
  state,
  rootKey,
  renames,
  onForward,
}: {
  entry: TalkEntry;
  state: HuddleState;
  rootKey: AgentKey;
  renames: ReadonlyMap<AgentKey, string>;
  onForward: (to: AgentKey, text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const pickId = useId();
  const long = entry.text.length > FOLD_AT;
  const targets = entry.kind === 'result' ? forwardTargets(state, rootKey, entry.from.key) : [];
  const [target, setTarget] = useState<string>('');
  // The list changes while the row is open (an agent finishes, one starts): work the pick out on every render.
  const chosen = targets.some((t) => t.key === target) ? target : (targets[0]?.key ?? '');
  const sessionId = state.agents[rootKey]?.sessionId ?? rootKey;
  return (
    <li className={`talk-entry talk-${entry.kind}`}>
      <Speaker p={entry.from} sessionId={sessionId} />
      <div className="talk-body">
        <p className="talk-line">
          <Who p={entry.from} />
          <span className="talk-verb">{entry.kind === 'brief' ? W.brief : W.result}</span>
          <Who p={entry.to} />
          <time className="talk-time">{clockTime(entry.at)}</time>
        </p>
        {/* The title often is the subagent's name already; say it only when it adds something. */}
        {entry.title !== null && entry.kind === 'brief' && entry.title !== entry.to.name && (
          <p className="talk-title">{entry.title}</p>
        )}
        <div className={`talk-text${long && !open ? ' is-folded' : ''}`}>
          {entry.text === '' ? (
            entry.title === null && <p className="muted">{W.noText}</p>
          ) : (
            <MessageText text={entry.text} />
          )}
        </div>
        <div className="talk-actions">
          {long && (
            <button
              type="button"
              className="quiet-button"
              aria-expanded={open}
              onClick={() => {
                setOpen(!open);
              }}
            >
              {open ? W.showLess : W.showAll}
            </button>
          )}
          {entry.kind === 'result' && targets.length > 0 && !picking && (
            <button
              type="button"
              className="quiet-button"
              title={W.forwardHint}
              onClick={() => {
                setPicking(true);
              }}
            >
              {W.forward}
            </button>
          )}
        </div>
        {picking && (
          <div className="talk-forward" role="group" aria-label={W.forwardTo}>
            <label htmlFor={pickId}>{W.forwardTo}</label>
            <select
              id={pickId}
              className="text-input select-input"
              value={chosen}
              onChange={(e) => {
                setTarget(e.target.value);
              }}
            >
              {targets.map((t) => (
                <option key={t.key} value={t.key}>
                  {displayName(t, renames)}
                </option>
              ))}
            </select>
            <ControlButton
              control={chosen === '' ? { enabled: false, reason: 'Pick an agent' } : ON}
              hint={W.forwardHint}
              onPress={() => {
                if (chosen === '') return;
                setPicking(false);
                onForward(chosen, forwardText(entry));
              }}
            >
              Open message
            </ControlButton>
            <ControlButton
              control={ON}
              variant="quiet"
              onPress={() => {
                setPicking(false);
              }}
            >
              {W.cancel}
            </ControlButton>
            <p className="form-note">{W.forwardHint}</p>
          </div>
        )}
      </div>
    </li>
  );
}

export function TeamTalk({
  state,
  rootKey,
  renames,
  onForward,
}: {
  state: HuddleState;
  rootKey: AgentKey;
  renames: ReadonlyMap<AgentKey, string>;
  /** Open `to`'s message box with `text` in it (the user sends it). */
  onForward: (to: AgentKey, text: string) => void;
}) {
  const entries = teamTalk(state, rootKey, renames);
  if (entries.length === 0) return <p className="empty-line">{W.empty}</p>;
  return (
    <ol className="talk" aria-label={W.tab}>
      {entries.map((e) => (
        <Entry key={e.id} entry={e} state={state} rootKey={rootKey} renames={renames} onForward={onForward} />
      ))}
    </ol>
  );
}
