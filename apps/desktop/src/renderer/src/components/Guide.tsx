/**
 * The first-run guide (main window redesign, WP3; mockup 3): four short steps in a dialog. It opens by itself once
 * (view/prefs.ts `shouldShowGuide`, never over the consent screen) and again from the rail's Guide. Skip, Esc and
 * "Start using Huddle" close it and mark it seen. Fixed words only; no agent text.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

export interface GuideStep {
  title: string;
  body: ReactNode;
}

const LEGEND: readonly { glyph: string; tone: string; word: string; meaning: string }[] = [
  { glyph: '●', tone: 'working', word: 'working', meaning: 'doing something right now' },
  { glyph: '▲', tone: 'needs-you', word: 'needs you', meaning: 'waiting for your approval or answer' },
  { glyph: '‖', tone: 'paused', word: 'paused', meaning: 'held by you or a budget' },
  { glyph: '○', tone: 'idle', word: 'idle', meaning: 'finished its turn, waiting for a new prompt' },
  { glyph: '✓', tone: 'idle', word: 'done', meaning: 'the session or subagent ended' },
  { glyph: '✕', tone: 'failed', word: 'failed', meaning: 'it stopped with an error' },
  { glyph: '!', tone: 'needs-you', word: 'warning', meaning: 'looks stuck, loops, or a budget is near (not a status)' },
];

export const GUIDE_STEPS: readonly GuideStep[] = [
  {
    title: 'Projects, sessions and agents',
    body: (
      <>
        <p>
          The left side is a tree. A project is a folder you work in. A session is one Claude Code conversation in that
          folder, from a terminal, VS Code or Huddle. Inside it are its agents: the main one and any subagents it
          started.
        </p>
        <p className="muted">
          Huddle only watches unless you act. It sees sessions through Claude Code&apos;s hooks, which you installed
          once.
        </p>
      </>
    ),
  },
  {
    title: 'Reading the signs',
    body: (
      <>
        <p>Every status has a shape and a word, so colour is never the only clue.</p>
        <dl className="guide-legend">
          {LEGEND.map((l) => (
            <div key={l.word} className="guide-legend-row">
              <dt>
                <span className={`glyph tone-${l.tone}`} aria-hidden="true">
                  {l.glyph}
                </span>{' '}
                {l.word}
              </dt>
              <dd>{l.meaning}</dd>
            </div>
          ))}
        </dl>
        <p className="muted">Times left and progress are estimates and say so. Unknown shows as —, never 0.</p>
      </>
    ),
  },
  {
    title: 'When an agent needs you',
    body: (
      <>
        <p>
          It appears at the top of the left side under Needs you, and as a Windows notification. Allow or Deny answers
          Claude Code directly. The terminal still works too: whichever answers first wins.
        </p>
        <p>
          To stop being asked about the same safe command, use Make a rule from this… in the session view: it opens the
          rule editor filled in from the request. The rules Huddle ships allow only read-only commands, and rules answer
          only for sessions Huddle launched, while it is open.
        </p>
        <p className="muted">
          Pause holds an agent at its next step. Stop works only for runs you started from Huddle.
        </p>
      </>
    ),
  },
  {
    title: 'Looking back, and asking',
    body: (
      <>
        <p>
          History keeps your runs. Open one to replay it step by step, see why an agent got stuck, or read its report.
          Scorecards compare roles and models over time.
        </p>
        <p>
          Ask the Huddle on Home answers questions about your agents in plain words. It can read, never act, and it is
          off until you turn it on, because it sends a masked summary to Anthropic.
        </p>
        <p className="muted">Open this guide again any time from Guide at the bottom of the rail.</p>
      </>
    ),
  },
];

export function Guide({ onClose, initialStep = 0 }: { onClose: () => void; initialStep?: number }) {
  const [step, setStep] = useState(Math.min(Math.max(0, initialStep), GUIDE_STEPS.length - 1));
  const dialog = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);
  const current = GUIDE_STEPS[step] ?? GUIDE_STEPS[0];
  const last = step === GUIDE_STEPS.length - 1;

  // Focus goes back to where it was when the dialog closes.
  useEffect(() => {
    opener.current = document.activeElement;
    return () => {
      if (opener.current instanceof HTMLElement) opener.current.focus();
    };
  }, []);
  // On open and on every step the primary button (Next, or Start using Huddle) takes the focus: the button that was
  // pressed may be gone (Back on step 1, Next on the last), and focus must never fall to the page behind.
  useEffect(() => {
    dialog.current?.querySelector<HTMLElement>('.guide-foot .control-primary')?.focus();
  }, [step]);

  // Tab stays inside the dialog; Esc closes it.
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key !== 'Tab') return;
    const items = [...(dialog.current?.querySelectorAll<HTMLElement>('button') ?? [])];
    const first = items[0];
    const end = items[items.length - 1];
    if (!first || !end) return;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      end.focus();
    } else if (!e.shiftKey && document.activeElement === end) {
      e.preventDefault();
      first.focus();
    }
  };

  if (current === undefined) return null;
  return (
    <div className="guide-backdrop">
      <div
        ref={dialog}
        className="guide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="guide-title"
        aria-describedby="guide-step"
        onKeyDown={onKey}
      >
        <div className="guide-top">
          <span className="guide-brand">Welcome to Huddle</span>
          <span className="muted" id="guide-step">
            · step {step + 1} of {GUIDE_STEPS.length}
          </span>
          <span className="guide-gap" />
          <span className="guide-dots" aria-hidden="true">
            {GUIDE_STEPS.map((s, i) => (
              <span key={s.title} className={`guide-dot${i <= step ? ' is-on' : ''}`} />
            ))}
          </span>
        </div>
        <div className="guide-content">
          <h2 className="guide-title" id="guide-title">
            {current.title}
          </h2>
          {current.body}
        </div>
        <div className="guide-foot">
          <button type="button" className="control control-quiet" onClick={onClose}>
            Skip
          </button>
          <span className="guide-gap" />
          {step > 0 && (
            <button
              type="button"
              className="control control-plain"
              onClick={() => {
                setStep(step - 1);
              }}
            >
              Back
            </button>
          )}
          {last ? (
            <button type="button" className="control control-primary" onClick={onClose}>
              Start using Huddle
            </button>
          ) : (
            <button
              type="button"
              className="control control-primary"
              onClick={() => {
                setStep(step + 1);
              }}
            >
              Next
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
