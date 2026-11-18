/**
 * Detail of the selected agent: identity (F2), status (F3), "Now" facts, progress (F4), usage (F5), context (F6),
 * the handoff (F7) and the timeline (F8).
 * Sections sit one after another, separated by spacing and a hairline (DESIGN.md: no cards).
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import {
  isTerminal,
  LEAD_AGENT,
  ROLE_PROFILES,
  modelLabel,
  selectAgent,
  selectSessionIdentity,
  selectStaleSessionIds,
  type AgentKey,
  type AgentNode,
  type CommandResult,
  type HuddleEvent,
  type HuddleState,
} from '@huddle/shared';
import { typeOf } from '../view/roles.js';
import { agentLabel, displayName } from '../store.js';
import {
  clockTime,
  clockTimeFull,
  count,
  folderName,
  linkQuality,
  orUnknown,
  shortCount,
  UNKNOWN,
} from '../view/format.js';
import { totalTokens } from '../view/meters.js';
import { lastTeammateIdle, leadWords, TEAMMATE_WORDS, teammateCount } from '../view/teammates.js';
import { treeOptions } from '../view/summary.js';
import type { TimelineFilter, TimelineRow } from '../view/timeline.js';
import { useNow } from '../useNow.js';
import { HISTORY_WORDS, type RunTab } from '../view/history.js';
import type { HoldEnding } from '../view/inbox.js';
import { MessageSection, PauseControl } from './AgentControls.js';
import type { SendCommand } from './Inbox.js';
import { BudgetSection } from './Budget.js';
import {
  ContextBarSection,
  ContextSection,
  HandoffSection,
  ProgressSection,
  TokenShareSection,
  UsageSection,
} from './Meters.js';
import { useViewMode } from '../viewMode.js';
import { RunPanel } from './RunPanel.js';
import { StatusBadge } from './Status.js';
import { Timeline } from './Timeline.js';

export type DetailSection = 'now' | 'timeline';

/**
 * The selected agent's timeline rows, and (M6) the raw events they came from, oldest first: a teammate's team name and
 * last idle time come from its own `teammate.idle` events. Absent events: those facts show `—`.
 */
export interface DetailTimeline {
  rows: readonly TimelineRow[];
  loading: boolean;
  events?: readonly HuddleEvent[];
}

export interface AgentDetailProps {
  state: HuddleState;
  agent: AgentNode;
  renames: ReadonlyMap<AgentKey, string>;
  onRename: (name: string) => Promise<CommandResult>;
  onSelect: (key: AgentKey) => void;
  section: DetailSection;
  onSection: (section: DetailSection) => void;
  timeline: DetailTimeline;
  filter: TimelineFilter;
  onFilter: (filter: TimelineFilter) => void;
  /** Clock for progress and ETA; defaults to a ticking clock (tests pass a fixed time). */
  now?: number;
  /** M3: send a command (pause, resume, message, cancel). Without it the controls render but send nothing. */
  onCommand?: SendCommand;
  /** M3: how this agent's last pause ended, from its events. */
  lastHoldEnding?: HoldEnding | null;
  /** The session view's head already has the lead's Pause / Resume: here only the pause words show for it. */
  leadInHead?: boolean;
  /** M5: open this session's run in History, on its Replay or Report tab. Without it the buttons do not show. */
  onOpenRun?: (sessionId: string, tab: RunTab) => void;
  /** The session view: the message box starts closed; bumping this opens it with the focus in it. */
  composerSignal?: number;
  /** With the signal: text to open the box with (Team talk's Forward; the user edits and sends it). */
  composerText?: string;
  /** The signal has been acted on (one-shot). */
  onComposerSignalUsed?: () => void;
}

/**
 * M5 (DESIGN "Where each view lives"): a session's main agent offers "Replay this run" (every session that reports to
 * Huddle has stored events) and, once the session has ended, "Open the report".
 */
export function RunLinks({
  agent,
  onOpenRun,
}: {
  agent: AgentNode;
  onOpenRun: (sessionId: string, tab: RunTab) => void;
}) {
  if (agent.kind !== 'main') return null;
  return (
    <span className="run-links">
      <button
        type="button"
        className="quiet-button"
        onClick={() => {
          onOpenRun(agent.sessionId, 'replay');
        }}
      >
        {HISTORY_WORDS.replayThisRun}
      </button>
      {agent.endedAt !== null && (
        <button
          type="button"
          className="quiet-button"
          onClick={() => {
            onOpenRun(agent.sessionId, 'report');
          }}
        >
          {HISTORY_WORDS.openTheReport}
        </button>
      )}
    </span>
  );
}

const NO_SEND: SendCommand = () => Promise.resolve({ ok: true });

const NAME_MAX = 200;

/** A name with an inline Rename (double-click or F2 too). The new name shows at once (the store's optimistic rename). */
export function RenameableName({
  name,
  onRename,
  level = 1,
  inputLabel = 'Agent name',
}: {
  name: string;
  onRename: (name: string) => Promise<CommandResult>;
  level?: 1 | 2;
  inputLabel?: string;
}) {
  const inputId = useId();
  const Heading = level === 1 ? 'h1' : 'h2';
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);

  const start = () => {
    setDraft(name);
    setError(null);
    setEditing(true);
  };
  const finish = (save: boolean) => {
    setEditing(false);
    const next = draft.trim();
    queueMicrotask(() => button.current?.focus());
    if (!save || next === '' || next === name) return;
    void onRename(next).then((r) => {
      if (!r.ok) setError(`Couldn't rename: ${r.message}`);
    });
  };
  const onSubmit = (e: { preventDefault: () => void }) => {
    e.preventDefault();
    finish(true);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
    }
  };

  return (
    <div className="name-block">
      {editing ? (
        <form className="rename" onSubmit={onSubmit}>
          <label className="visually-hidden" htmlFor={inputId}>
            {inputLabel}
          </label>
          <input
            id={inputId}
            ref={input}
            className="rename-input"
            value={draft}
            maxLength={NAME_MAX}
            onChange={(e) => {
              setDraft(e.target.value);
            }}
            onKeyDown={onKey}
            onBlur={() => {
              finish(true);
            }}
          />
        </form>
      ) : (
        <Heading className="agent-name" title={name} onDoubleClick={start}>
          {name}
        </Heading>
      )}
      {!editing && (
        <button ref={button} type="button" className="quiet-button" onClick={start} title="Rename (F2)">
          Rename
        </button>
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function Fact({ label, children, code = false }: { label: string; children: ReactNode; code?: boolean }) {
  return (
    <>
      <dt>{label}</dt>
      <dd className={code ? 'code' : undefined}>{children}</dd>
    </>
  );
}

/** This agent's tokens so far, short (`1.2M tokens`), the exact figure and its parts on hover. Unknown says so. */
function TokensFact({ agent }: { agent: AgentNode }) {
  const total = totalTokens(agent.usage);
  if (total === null) {
    return (
      <span
        className="tokens-fact muted"
        title="No requests recorded for this agent yet (telemetry starts with the session)"
      >
        tokens {UNKNOWN}
      </span>
    );
  }
  const u = agent.usage;
  const parts =
    `${count(total)} tokens: ${count(u.inputTokens)} input, ${count(u.outputTokens)} output, ` +
    `${count(u.cacheReadTokens)} cache read, ${count(u.cacheCreationTokens)} cache written, over ${count(u.requests)} requests`;
  return (
    <span className="tokens-fact" title={parts}>
      {shortCount(total)} tokens
    </span>
  );
}

/**
 * Agent teams (M6, S20). A teammate: which team, when it last went idle, and the limits of what Huddle can see. A
 * lead: how many teammates it leads, and that their usage lands on it. Nothing for an agent outside a team.
 */
function TeamFacts({ state, agent, events }: { state: HuddleState; agent: AgentNode; events: readonly HuddleEvent[] }) {
  if (agent.kind === 'teammate') {
    const idle = lastTeammateIdle(events, agent.key);
    return (
      <section className="team-facts" aria-label="Team">
        <dl className="facts">
          <Fact label="Team">
            {idle?.teamName ? (
              // One span: the facts' dd is a flex row, which would drop the space before the team name.
              <span>
                Teammate in <span className="code">{idle.teamName}</span>
              </span>
            ) : (
              'Teammate (team name not reported yet)'
            )}
          </Fact>
          <Fact label="Last idle">
            {idle === null ? UNKNOWN : <span title={clockTimeFull(idle.ts)}>{clockTime(idle.ts)}</span>}
          </Fact>
          {agent.usage.requests === 0 && (
            <Fact label="Tokens">
              <span title={TEAMMATE_WORDS.tokensOnLead}>{UNKNOWN} (counted on the lead)</span>
            </Fact>
          )}
        </dl>
        <ul className="meter-notes">
          <li>{TEAMMATE_WORDS.staysIdle}</li>
        </ul>
      </section>
    );
  }
  const kids = agent.childKeys.map((k) => selectAgent(state, k)).filter((n): n is AgentNode => n !== null);
  const teammates = teammateCount(kids);
  if (teammates === 0) return null;
  return (
    <section className="team-facts" aria-label="Team">
      <dl className="facts">
        <Fact label="Team">
          {TEAMMATE_WORDS.lead}: {leadWords(teammates).toLowerCase()}
        </Fact>
      </dl>
      <ul className="meter-notes">
        <li>{TEAMMATE_WORDS.leadCarriesTeam}</li>
      </ul>
    </section>
  );
}

const NO_EVENTS: readonly HuddleEvent[] = [];

/** The agent's model: "Opus 5.5" in the Simple view (the raw id on hover), the raw id in Advanced. */
function ModelWords({ model, simple }: { model: string | null; simple: boolean }) {
  if (simple) return <span title={model ?? undefined}>{modelLabel(model) ?? 'model unknown'}</span>;
  return <span className="code">{orUnknown(model)}</span>;
}

export function AgentDetail(props: AgentDetailProps) {
  const { state, agent, renames, section } = props;
  const { simple } = useViewMode();
  const ticking = useNow();
  const now = props.now ?? ticking;
  const lead = agent.kind === 'main';
  // Agent types (2026-11-18): the type word leads the role line; its tooltip says what the Huddle expects of it.
  const type = typeOf({ ...agent, hasChildren: agent.childKeys.length > 0 }, state.settings?.roleKinds);
  // The folder this agent works in: its own, else its session root's (subagents do not record one).
  const sessionRoot = Object.hasOwn(state.agents, agent.sessionId) ? state.agents[agent.sessionId] : undefined;
  const folderOf = agent.cwd ?? sessionRoot?.cwd ?? null;
  // The session's name (one rule, F2) is in the session view's head; here the main agent is "Lead agent".
  const identity = lead ? selectSessionIdentity(state, agent.key, now, { renames }) : null;
  const name = lead ? LEAD_AGENT : displayName(agent, renames);
  const parent = agent.parentKey ? selectAgent(state, agent.parentKey) : null;
  const parentName = parent === null ? null : parent.kind === 'main' ? LEAD_AGENT : agentLabel(state, parent, renames);
  // A finished agent keeps its final status; only a live status is in doubt after a restart.
  const stale = !isTerminal(agent.status) && selectStaleSessionIds(state, treeOptions(state)).has(agent.sessionId);
  const sep = (
    <span className="sep" aria-hidden="true">
      ·
    </span>
  );

  return (
    <article
      className="detail"
      aria-label={`${name} details`}
      onKeyDown={(e) => {
        if (e.key === 'F2' && !(e.target instanceof HTMLInputElement)) {
          e.preventDefault();
          e.currentTarget.querySelector<HTMLButtonElement>('.name-block .quiet-button')?.click();
        }
      }}
    >
      <header className="detail-head">
        <div className="detail-head-top">
          {lead ? (
            <h2 className="agent-name agent-lead">{LEAD_AGENT}</h2>
          ) : (
            <RenameableName key={agent.key} name={name} level={2} onRename={props.onRename} />
          )}
          {props.onOpenRun && <RunLinks agent={agent} onOpenRun={props.onOpenRun} />}
        </div>
        <p className="role-line">
          {type !== null && (
            <>
              <span className="role-type" title={ROLE_PROFILES[type].about}>
                {ROLE_PROFILES[type].label}
              </span>
              {sep}
            </>
          )}
          {agent.kind === 'teammate' && (
            <span className="team-chip" title={TEAMMATE_WORDS.badgeTitle}>
              {TEAMMATE_WORDS.badge}
            </span>
          )}
          {!lead && (
            <>
              <span title={agent.roleDescription ?? undefined}>{agent.role}</span>
              {sep}
              {!simple && (
                <>
                  <span className="role-desc">{orUnknown(agent.roleDescription)}</span>
                  {sep}
                </>
              )}
            </>
          )}
          <ModelWords model={agent.model} simple={simple} />
          {!simple && (
            <>
              {sep}
              <TokensFact agent={agent} />
            </>
          )}
          {parent !== null && (
            <>
              {sep}
              <span className="reports-to">
                reports to{' '}
                <button
                  type="button"
                  className="link-button"
                  onClick={() => {
                    props.onSelect(parent.key);
                  }}
                >
                  {parentName}
                </button>
              </span>
            </>
          )}
        </p>
        {identity !== null && identity.topic !== null && (
          <p className="topic-line" title={identity.topic}>
            {identity.topic}
          </p>
        )}
        {!lead && (
          // The lead's status is the session head's status line; a subagent's is here, once.
          <div className="now-line">
            <StatusBadge status={agent.status} stale={stale} kind={agent.kind} />
            {stale ? (
              <span className="now-activity is-stale" title={clockTimeFull(agent.lastEventAt)}>
                last heard {clockTime(agent.lastEventAt)}
              </span>
            ) : (
              <span className="now-activity" title={agent.currentActivity ?? undefined}>
                {agent.currentActivity ?? ''}
              </span>
            )}
          </div>
        )}
        <PauseControl
          state={state}
          agent={agent}
          onCommand={props.onCommand ?? NO_SEND}
          lastEnding={props.lastHoldEnding ?? null}
          now={props.now}
          wordsOnly={lead && props.leadInHead === true}
        />
      </header>

      <div className="tabs" role="tablist" aria-label="Agent sections">
        {(['timeline', 'now'] as const).map((s) => (
          <button
            key={s}
            type="button"
            role="tab"
            id={`tab-${s}`}
            aria-selected={section === s}
            aria-controls={`panel-${s}`}
            tabIndex={section === s ? 0 : -1}
            className="tab"
            onClick={() => {
              props.onSection(s);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                e.preventDefault();
                const next = s === 'now' ? 'timeline' : 'now';
                props.onSection(next);
                document.getElementById(`tab-${next}`)?.focus();
              }
            }}
          >
            {s === 'now' ? 'Details' : 'Timeline'}
          </button>
        ))}
      </div>

      {section === 'now' ? (
        <div className="panel" role="tabpanel" id="panel-now" aria-labelledby="tab-now">
          <dl className="facts">
            <Fact label={stale ? 'Last seen doing' : 'Doing now'}>{orUnknown(agent.currentActivity)}</Fact>
            {!lead && <Fact label="Handed off as">{orUnknown(agent.handoff?.title)}</Fact>}
            {!lead && (
              <Fact label="Reports to">
                {parentName ?? UNKNOWN} <span className="fact-note">({linkQuality(agent.handoff?.link)})</span>
              </Fact>
            )}
            <Fact label="Started">
              <span title={clockTimeFull(agent.startedAt)}>{clockTime(agent.startedAt)}</span>
            </Fact>
            {(!simple || agent.endedAt !== null) && (
              <Fact label="Ended">
                {agent.endedAt === null ? (
                  UNKNOWN
                ) : (
                  <span title={clockTimeFull(agent.endedAt)}>{clockTime(agent.endedAt)}</span>
                )}
              </Fact>
            )}
            <Fact label="Tool calls">
              {String(agent.toolCalls)}
              {agent.toolFailures > 0 ? `, ${String(agent.toolFailures)} failed` : ''}
            </Fact>
            {!simple && (
              <Fact label="Folder" code>
                {/* A subagent works in its session's folder; only the root records it. */}
                <span title={folderOf ?? undefined}>{folderOf ? folderName(folderOf) : UNKNOWN}</span>
              </Fact>
            )}
            <Fact label="Started by">{agent.origin === 'managed' ? 'Huddle' : 'you, in a terminal or editor'}</Fact>
          </dl>
          <TeamFacts state={state} agent={agent} events={props.timeline.events ?? NO_EVENTS} />
          <RunPanel key={agent.key} state={state} agent={agent} onCommand={props.onCommand ?? NO_SEND} />
          <ProgressSection state={state} agent={agent} now={now} />
          <BudgetSection
            key={`budget:${agent.key}`}
            state={state}
            agent={agent}
            now={now}
            onCommand={props.onCommand}
          />
          {simple ? (
            <>
              <TokenShareSection state={state} agent={agent} />
              <ContextBarSection agent={agent} />
            </>
          ) : (
            <>
              <UsageSection state={state} agent={agent} />
              <ContextSection agent={agent} />
            </>
          )}
          <HandoffSection agent={agent} />
        </div>
      ) : (
        <div className="panel panel-timeline" role="tabpanel" id="panel-timeline" aria-labelledby="tab-timeline">
          <Timeline
            rows={props.timeline.rows}
            loading={props.timeline.loading}
            filter={props.filter}
            onFilter={props.onFilter}
            simple={simple}
          />
        </div>
      )}
      <footer className="detail-foot">
        <MessageSection
          key={agent.key}
          state={state}
          agent={agent}
          onCommand={props.onCommand ?? NO_SEND}
          collapsible={props.composerSignal !== undefined}
          openSignal={props.composerSignal ?? 0}
          {...(props.composerText !== undefined ? { openText: props.composerText } : {})}
          {...(props.onComposerSignalUsed !== undefined ? { onSignalUsed: props.onComposerSignalUsed } : {})}
        />
      </footer>
    </article>
  );
}
