/**
 * The session view (main window redesign, WP3; mockup 2): what the main area shows when a session or agent is picked.
 *
 *  - One compact head (owner's review 2026-11-17): the session's name with Rename and, on the same row, Message, Pause
 *    or Resume, and Stop for the lead agent; under it one status line (shape, word, project, model, started, agents,
 *    what it is doing). Every action that is off says why in words under the row.
 *  - Tabs Live · Replay, and Report once the run has ended. Live: the picked agent's panel (the existing agent detail
 *    with Budget, the run panel and its worktree actions). The session's tree is the sidebar's, not drawn a second
 *    time here (2026-11-18 design pass); Replay keeps its own tree, since a past moment differs from now.
 *  - A Stop that can never work for this session (started in a terminal) is not drawn; the status line says
 *    "started in a terminal" instead. A Stop that is off for a passing reason keeps its reason under the row.
 *  - The message box starts closed; the head's Message opens it on the lead agent with the focus in it. Replay and Report: the History components for this
 *    session id. Replay offers no action, as in History.
 *  - On an agent with an open approval or question: the request itself with its Allow / Deny / Terminal (the shared
 *    InboxCard), the "why" as one muted line, and "Make a rule from this…", which only opens the rule editor filled in from the request (nothing is saved without its Save).
 *
 * Titles, paths, commands and answers are text nodes.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  RUN_REASONS,
  selectAgent,
  type AgentKey,
  type CommandResult,
  type HuddleCommand,
  type HuddleState,
} from '@huddle/shared';
import { openRun, type HeadAnswer } from '../history-query.js';
import type { QueryFn } from '../query.js';
import { HISTORY_WORDS, runFailure } from '../view/history.js';
import type { HoldEnding } from '../view/inbox.js';
import { newTemplateId } from '../view/launch.js';
import type { RuleDraft } from '../view/rules.js';
import { runCommand } from '../view/runs.js';
import {
  makeRuleNote,
  openRequestOf,
  ruleDraftFromRequest,
  sessionActions,
  sessionHead,
  sessionOf,
  sessionTabs,
  SESSION_WORDS as W,
  whyAsking,
  type SessionTab,
} from '../view/session.js';
import type { TimelineFilter } from '../view/timeline.js';
import { AgentDetail, RenameableName, type DetailSection, type DetailTimeline } from './AgentDetail.js';
import { ControlButton } from './ControlButton.js';
import { InboxCard } from './Inbox.js';
import { Replay } from './Replay.js';
import { TeamTalk } from './TeamTalk.js';
import { Report } from './Report.js';

type Send = (cmd: HuddleCommand) => Promise<CommandResult>;

export interface SessionViewProps {
  state: HuddleState;
  /** The picked agent; its session is the one shown. */
  agentKey: AgentKey;
  renames: ReadonlyMap<AgentKey, string>;
  now: number;
  query: QueryFn | null;
  onCommand: Send;
  onRename: (key: AgentKey, name: string) => Promise<CommandResult>;
  onSelect: (key: AgentKey) => void;
  onHome: () => void;
  /** The agent panel's state, kept by the window so it survives a re-pick. */
  section: DetailSection;
  onSection: (s: DetailSection) => void;
  timeline: DetailTimeline;
  filter: TimelineFilter;
  onFilter: (f: TimelineFilter) => void;
  lastHoldEnding: HoldEnding | null;
  /** Open Library → Rules with the editor filled in. */
  onMakeRule: (draft: RuleDraft) => void;
  initialTab?: SessionTab;
  /** Tests: a run head already loaded for Replay or Report. */
  initialHead?: HeadAnswer;
}

/** Replay or Report of this session, from the stored events (History's components). */
function SessionRun({
  query,
  sessionId,
  tab,
  onCommand,
  onLive,
  onTab,
  initialHead,
}: {
  query: QueryFn | null;
  sessionId: string;
  tab: 'replay' | 'report';
  onCommand: Send;
  onLive: () => void;
  onTab: (tab: 'replay' | 'report') => void;
  initialHead?: HeadAnswer;
}) {
  const [head, setHead] = useState<HeadAnswer | null>(initialHead ?? null);
  const [replayAt, setReplayAt] = useState<{ index: number | null; n: number }>({ index: null, n: 0 });
  useEffect(() => {
    if (initialHead !== undefined) return;
    let live = true;
    void openRun(query, sessionId).then((a) => {
      if (live) setHead(a);
    });
    return () => {
      live = false;
    };
  }, [query, sessionId, initialHead]);
  const reloadHead = useCallback(() => {
    void openRun(query, sessionId).then((a) => {
      if (a.ok) setHead(a);
    });
  }, [query, sessionId]);
  if (head === null) return <p className="muted">{HISTORY_WORDS.openingRun}</p>;
  if (!head.ok)
    return (
      <p className={head.code === 'failed' ? 'inline-error' : 'empty-line'} role="alert">
        {runFailure(head)}
      </p>
    );
  return tab === 'report' ? (
    <Report
      query={query}
      onCommand={onCommand}
      head={head.head}
      onShowInReplay={(index) => {
        setReplayAt((prev) => ({ index, n: prev.n + 1 }));
        onTab('replay');
      }}
    />
  ) : (
    <Replay
      key={replayAt.n}
      query={query}
      head={head.head}
      startIndex={replayAt.index}
      onShowLive={onLive}
      onLoadNewer={reloadHead}
    />
  );
}

export function SessionView(props: SessionViewProps) {
  const { state, agentKey: picked, now } = props;
  const head = sessionHead(state, picked, now, props.renames);
  const view = useMemo(() => sessionOf(state, picked), [state, picked]);
  const [chosenTab, setTab] = useState<SessionTab>(props.initialTab ?? 'live');
  const [confirmStop, setConfirmStop] = useState(false);
  // "Message" opens the lead agent's message box with the focus in it; only that agent's box, not every later one.
  // Forward (Team talk) opens a box with text in it; the user sends it.
  const [composer, setComposer] = useState<{ key: AgentKey | null; n: number; text?: string }>({ key: null, n: 0 });
  const tabsId = useId();
  const root = useRef<HTMLElement>(null);

  if (head === null || view === null) return <p className="empty">{W.noSession}</p>;
  const main = selectAgent(state, head.rootKey);
  const agent = selectAgent(state, picked) ?? main;
  if (main === null || agent === null) return <p className="empty">{W.noSession}</p>;

  const actions = sessionActions(state, main);
  const request = openRequestOf(state, agent.key);
  const why = request ? whyAsking(request) : null;
  const note = makeRuleNote(state, agent);
  const send = (cmd: HuddleCommand) => {
    void props.onCommand(cmd);
  };

  const tabs = sessionTabs(head.ended, main.childKeys.length > 0);
  // A tab this session does not offer (Report before the run ended) reads as Live, so the panel is never empty.
  const tab: SessionTab = tabs.includes(chosenTab) ? chosenTab : 'live';
  // Stop that can never work here (a session started in a terminal) is not a control at all: no button, no reason.
  const terminalOnly = !actions.stop.enabled && actions.stop.reason === RUN_REASONS.notManaged;
  // Every action that is off says why, in words, right under the row (not only in a tooltip).
  const offReasons = [
    actions.message.enabled ? null : `Message: ${actions.message.reason ?? ''}`,
    actions.paused
      ? actions.resume.enabled
        ? null
        : `Resume: ${actions.resume.reason ?? ''}`
      : actions.pause.enabled
        ? null
        : `Pause: ${actions.pause.reason ?? ''}`,
    actions.stop.enabled || terminalOnly ? null : `Stop: ${actions.stop.reason ?? ''}`,
  ].filter((r): r is string => r !== null);
  const onTabKey = (e: { key: string; preventDefault: () => void }, i: number) => {
    let next: number | null = null;
    if (e.key === 'ArrowRight') next = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length;
    if (next === null) return;
    e.preventDefault();
    const t = tabs[next];
    if (t === undefined) return;
    setTab(t);
    document.getElementById(`${tabsId}-tab-${t}`)?.focus();
  };

  return (
    <article ref={root} className="detail session-view" aria-label={`Session ${head.title}`}>
      <header className="session-head">
        <div className="session-title-row">
          <RenameableName
            key={head.rootKey}
            name={head.title}
            level={1}
            inputLabel="Session name"
            onRename={(name) => props.onRename(head.rootKey, name)}
          />
          <div className="session-actions" role="group" aria-label="Session actions">
            <ControlButton
              control={actions.message}
              onPress={() => {
                props.onSelect(main.key);
                setTab('live');
                setComposer((c) => ({ key: main.key, n: c.n + 1 }));
              }}
              hint="Write to the lead agent"
            >
              Message
            </ControlButton>
            {actions.paused ? (
              <ControlButton
                control={actions.resume}
                onPress={() => {
                  send({ type: 'agent.resume', agentKey: main.key });
                }}
                hint="The lead agent carries on"
              >
                Resume
              </ControlButton>
            ) : (
              <ControlButton
                control={actions.pause}
                onPress={() => {
                  send({ type: 'agent.pause', agentKey: main.key });
                }}
                hint="The lead agent stops at its next tool call"
              >
                Pause
              </ControlButton>
            )}
            {confirmStop && actions.stop.enabled ? (
              <span className="confirm-inline" role="group" aria-label="Confirm stopping this run">
                <span className="confirm-words">{W.stopAsk}</span>
                <ControlButton
                  control={actions.stop}
                  className="control-danger"
                  onPress={() => {
                    setConfirmStop(false);
                    if (actions.runId !== null) send(runCommand.stop(actions.runId));
                  }}
                >
                  Yes
                </ControlButton>
                <ControlButton
                  control={{ enabled: true, reason: null }}
                  variant="quiet"
                  onPress={() => {
                    setConfirmStop(false);
                  }}
                >
                  No
                </ControlButton>
              </span>
            ) : terminalOnly ? null : (
              <ControlButton
                control={actions.stop}
                variant="quiet"
                onPress={() => {
                  setConfirmStop(true);
                }}
                hint="Stop this run now"
              >
                Stop
              </ControlButton>
            )}
          </div>
        </div>
        <p className="session-status">
          <span className={`status tone-${head.tone}`}>
            <span className="glyph" aria-hidden="true">
              {head.glyph}
            </span>
            <span className="status-label">{head.label}</span>
          </span>
          {head.lastHeard !== null && <span className="muted"> ({head.lastHeard})</span>}
          <span className="sep" aria-hidden="true">
            ·
          </span>
          <span title={head.projectPath ?? undefined}>{head.facts}</span>
          {terminalOnly && !head.ended && (
            <>
              <span className="sep" aria-hidden="true">
                ·
              </span>
              <span title={RUN_REASONS.notManaged}>{W.startedInTerminal}</span>
            </>
          )}
          {head.activity !== null && !head.ended && !head.stale && (
            <>
              <span className="sep" aria-hidden="true">
                ·
              </span>
              <span className="session-activity" title={head.activity}>
                {head.activity}
              </span>
            </>
          )}
        </p>
        {offReasons.length > 0 && (
          <ul className="session-reasons">
            {offReasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        )}
        <div className="tabs session-tabs" role="tablist" aria-label="Session sections">
          {tabs.map((t, i) => (
            <button
              key={t}
              type="button"
              role="tab"
              id={`${tabsId}-tab-${t}`}
              aria-selected={tab === t}
              aria-controls={`${tabsId}-panel`}
              tabIndex={tab === t ? 0 : -1}
              className="tab"
              onClick={() => {
                setTab(t);
              }}
              onKeyDown={(e) => {
                onTabKey(e, i);
              }}
            >
              {W.tabs[t]}
            </button>
          ))}
        </div>
      </header>

      <div
        className={`session-panel session-${tab}`}
        role="tabpanel"
        id={`${tabsId}-panel`}
        aria-labelledby={`${tabsId}-tab-${tab}`}
      >
        {tab === 'live' ? (
          <div className="session-live">
            <div className="session-agent">
              {request !== null && why !== null && (
                <section className="why-block" aria-label={W.whyTitle}>
                  <InboxCard
                    key={request.id}
                    state={state}
                    item={request}
                    renames={props.renames}
                    onCommand={props.onCommand}
                    onAgent={props.onSelect}
                    now={now}
                  />
                  <p className="why-line">{why}</p>
                  {request.approval && (
                    <>
                      <div className="card-actions">
                        <ControlButton
                          control={{ enabled: true, reason: null }}
                          variant="plain"
                          hint={W.makeRuleHint}
                          onPress={() => {
                            if (request.approval)
                              props.onMakeRule(ruleDraftFromRequest(request.approval, agent, newTemplateId('rule')));
                          }}
                        >
                          {W.makeRule}
                        </ControlButton>
                      </div>
                      {note !== null && <p className="form-note">{note}</p>}
                    </>
                  )}
                </section>
              )}
              <AgentDetail
                state={state}
                agent={agent}
                renames={props.renames}
                onRename={(name) => props.onRename(agent.key, name)}
                onSelect={props.onSelect}
                section={props.section}
                onSection={props.onSection}
                timeline={props.timeline}
                filter={props.filter}
                onFilter={props.onFilter}
                onCommand={props.onCommand}
                lastHoldEnding={props.lastHoldEnding}
                leadInHead
                composerSignal={composer.key === agent.key ? composer.n : 0}
                {...(composer.key === agent.key && composer.text !== undefined ? { composerText: composer.text } : {})}
                onComposerSignalUsed={() => {
                  setComposer((c) => (c.key === null ? c : { key: null, n: c.n }));
                }}
              />
            </div>
          </div>
        ) : tab === 'team' ? (
          <TeamTalk
            state={state}
            rootKey={main.key}
            renames={props.renames}
            onForward={(to, text) => {
              props.onSelect(to);
              setTab('live');
              setComposer((c) => ({ key: to, n: c.n + 1, text }));
            }}
          />
        ) : (
          <SessionRun
            key={view.sessionId}
            query={props.query}
            sessionId={view.sessionId}
            tab={tab}
            onCommand={props.onCommand}
            onLive={() => {
              setTab('live');
            }}
            onTab={setTab}
            {...(props.initialHead !== undefined ? { initialHead: props.initialHead } : {})}
          />
        )}
      </div>
    </article>
  );
}
