/**
 * Home (main window redesign, WP3; mockup 1): the default place. Title, date · project and session counts, "ⓘ Explain
 * this screen" and "Start a run"; Today, the sessions active today, each opening its session view; and the Ask the
 * Huddle card (a read-only conversation, kept in that card's state only). The live counts are in the title bar only
 * (slop review 2026-11-18: three count cards repeated them and pushed Today below the fold).
 *
 * Titles, project names and answers are text nodes. Nothing on Home acts on an agent: the only commands it can send are
 * Ask's own (huddle.ask, ask.cancel).
 */
import { useId } from 'react';
import type { AgentKey, AskStatus, CommandResult, HuddleCommand, ProjectView, SessionIdentity } from '@huddle/shared';
import type { QueryFn } from '../query.js';
import { HOME_WORDS as W, homeCountsLine, homeHeading, todayRows } from '../view/home.js';
import type { FlagStore } from '../view/prefs.js';
import { AskPanel } from './Ask.js';
import { ExplainButton, ExplainNote, useExplain } from './Explain.js';

export interface HomeProps {
  projects: readonly ProjectView[];
  now: number;
  identity: (rootKey: AgentKey) => SessionIdentity | null;
  onStart: () => void;
  onHistory: () => void;
  onOpenSession: (rootKey: AgentKey) => void;
  /** Ask: the Settings switch, the core's status, and the two ways out (commands, Settings at the Ask section). */
  askEnabled: boolean;
  askStatus: AskStatus | null;
  query: QueryFn | null;
  onCommand: (cmd: HuddleCommand) => Promise<CommandResult>;
  onOpenAskSettings: () => void;
  /** The palette's hand-off: fills Ask's box (never sends). */
  askPrefill: { question: string; n: number } | null;
  /** F28/F29: Ask's "Make a task from this" and "Create skill from this" (open the Library form, filled in). */
  onMakeTask?: (question: string, answer: string) => void;
  onMakeSkill?: (question: string, answer: string) => void;
  /** Tests: a fake store (null: storage unavailable). */
  explainStore?: FlagStore | null;
}

export function Home(props: HomeProps) {
  const explain = useExplain('home', props.explainStore);
  const noteId = useId();
  const today = todayRows(props.projects, props.now, props.identity);
  return (
    <article className="detail home" aria-label="Home">
      <header className="home-head">
        <div className="home-title">
          <h1 className="home-h1">{homeHeading(props.now)}</h1>
          <p className="muted">{homeCountsLine(props.projects.length, today.length)}</p>
        </div>
        <span className="home-head-gap" />
        <ExplainButton explain={explain} controls={noteId} />
        <button type="button" className="control control-plain" onClick={props.onStart}>
          {W.start}
        </button>
      </header>
      <div className="home-body">
        <ExplainNote id={noteId} shown={explain.shown}>
          {W.explanation}
        </ExplainNote>

        <div className="home-cols">
          <section className="home-card home-today" aria-label={W.today}>
            <header className="home-card-head">
              <h2 className="home-card-title">{W.today}</h2>
              <button type="button" className="link-button" onClick={props.onHistory}>
                {W.allHistory}
              </button>
            </header>
            {today.length === 0 ? (
              <p className="empty-line home-empty">{W.todayEmpty}</p>
            ) : (
              <ul className="home-today-list">
                {today.map((r) => (
                  <li key={r.rootKey}>
                    <button
                      type="button"
                      className="home-today-row"
                      aria-label={`${r.title}, ${r.meta}`}
                      onClick={() => {
                        props.onOpenSession(r.rootKey);
                      }}
                    >
                      <span className={`glyph tone-${r.tone}`} aria-hidden="true">
                        {r.glyph}
                      </span>
                      <span className="home-today-text">
                        <span className="home-today-title" title={r.title}>
                          {r.title}
                        </span>
                        <span className="home-today-meta">{r.meta}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <AskPanel
            layout="card"
            enabled={props.askEnabled}
            status={props.askStatus}
            query={props.query}
            onCommand={props.onCommand}
            onOpenSettings={props.onOpenAskSettings}
            prefill={props.askPrefill}
            {...(props.onMakeTask ? { onMakeTask: props.onMakeTask } : {})}
            {...(props.onMakeSkill ? { onMakeSkill: props.onMakeSkill } : {})}
          />
        </div>
      </div>
    </article>
  );
}
