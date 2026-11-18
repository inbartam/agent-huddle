/**
 * One session in the widget (Widget v2, owner's choice 2026-11-14): face, name, what it is doing or what it needs,
 * the progress line and bar; at right "open in the main window" and the × that hides the card until the session does
 * something new. A request waiting on the user renders inline as the shared InboxCard (same buttons, words and
 * shortcuts as the main window's inbox). Clicking the card opens its tasks and subagent tree in place (the shared
 * TeamTree), or, for a session with nothing to open, shows it in the main window.
 *
 * Every agent string is a React text node (docs/SECURITY.md). The face is decorative; the glyph and label carry status.
 */
import {
  isTerminal,
  selectCurrentTask,
  selectProgress,
  selectSessionIdentity,
  startedWords,
  type AgentKey,
  type HuddleState,
} from '@huddle/shared';
import { displayName } from '../store.js';
import { approxUsd, orUnknown } from '../view/format.js';
import { faceHue, faceMood } from '../view/face.js';
import { typeOf } from '../view/roles.js';
import { HIDE_HINT } from '../view/hidden.js';
import { cardProgress } from '../view/meters.js';
import type { SessionCardModel } from '../view/cards.js';
import { lookFor } from '../view/status.js';
import { buildRows, isExpanded, type TreeRow } from '../view/tree.js';
import { BudgetChip } from './Budget.js';
import { Face } from './Face.js';
import { InboxCard, type SendCommand } from './Inbox.js';
import { Bar } from './Meters.js';
import { StatusGlyph } from './Status.js';
import { TeamTree, type RowMeters } from './TeamTree.js';

export interface SessionCardProps {
  /**
   * The card's position in the widget. The inline request's arming delay is keyed on it, so a waiting card that moves
   * into the spot the user just clicked (cards sort by need) ignores presses for a moment, like a new request.
   */
  slot?: number;
  state: HuddleState;
  card: SessionCardModel;
  renames: ReadonlyMap<AgentKey, string>;
  /** Rows the user flipped open or closed (the session's root key opens the card). */
  opened: ReadonlySet<AgentKey>;
  onToggle: (key: AgentKey) => void;
  onOpenMain: (agentKey?: AgentKey) => void;
  /** Hide the card until the session does something new; null: no × (a card that needs the user stays). */
  onHide: (() => void) | null;
  onCommand: SendCommand;
  /** Meters for the rows of the in-place tree, and the session's own (row = null). */
  meters: (row: TreeRow) => RowMeters | null;
  sessionMeters: RowMeters | null;
  now: number;
  /** A fixed clock for the inline request's countdown (tests); otherwise it ticks. */
  fixedNow?: number;
}

export function OpenIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <path className="icon-line" d="M4.5 2.5 H9.5 V7.5 M9.5 2.5 L2.5 9.5" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <path className="icon-line" d="M3 3 L9 9 M9 3 L3 9" />
    </svg>
  );
}

export function SessionCard(props: SessionCardProps) {
  const { state, card, renames, opened, onToggle, onOpenMain, onHide, onCommand, now } = props;
  const { session, root, status, stale, need } = card;
  // Who this session is (F2): its title (nickname, session title, else the project folder), model, worktree and topic.
  const identity = selectSessionIdentity(state, session.rootKey, now, { renames });
  const name = identity?.label ?? displayName(session.root, renames);
  const nameTip = identity
    ? `${identity.projectPath ?? 'folder unknown'}\n${startedWords(identity.startedAgo)}`
    : undefined;
  const look = lookFor(status, stale);
  const needsYou = need !== null;
  const mood = faceMood(status, { stale, needsYou });
  // The session's type (a lead when it runs subagents or teammates) as a small prop on its face.
  const type =
    root !== null ? typeOf({ ...root, hasChildren: root.childKeys.length > 0 }, state.settings?.roleKinds) : null;
  const running = root !== null && root.status !== 'idle' && !isTerminal(root.status) && !stale;
  // The task in progress (TaskUpdate in_progress), shown on the progress line and marked in the list.
  const currentTask = root ? selectCurrentTask(root) : null;
  const progress = running
    ? cardProgress(selectProgress(state, root.key, now, { priors: state.priors ?? null }), root, currentTask)
    : null;
  const tasks = root?.tasks ?? [];
  const expandable = session.agentCount > 1 || tasks.length > 0;
  const expanded = expandable && isExpanded(session.root, session, opened, true);
  const rows = expanded ? buildRows([session], { toggled: opened, rootsCollapsed: true }).slice(1) : [];
  const doing = !stale && !isTerminal(status) ? (root?.currentActivity ?? null) : null;
  // The current task subject is often the activity too; the progress line already says it.
  const activity = doing !== null && doing === progress?.text ? null : doing;
  const askerName =
    need !== null && need.agentKey !== session.rootKey
      ? (() => {
          const asker = Object.hasOwn(state.agents, need.agentKey) ? state.agents[need.agentKey] : undefined;
          return asker ? displayName(asker, renames) : null;
        })()
      : null;
  const m = props.sessionMeters;
  const hidden = session.agentCount - 1;
  const tone = needsYou ? 'needs-you' : look.tone;

  return (
    <article
      className={`scard tone-${tone}${needsYou ? ' needs-you' : ''}${stale || session.ended ? ' is-dimmed' : ''}${onHide !== null ? ' can-hide' : ''}`}
      aria-label={`${name}, ${need !== null ? need.words : look.label}`}
      data-session={session.sessionId}
    >
      <div className="scard-top">
        <button
          type="button"
          className="scard-main"
          aria-expanded={expandable ? expanded : undefined}
          title={expandable ? undefined : 'Show in the main window'}
          onClick={() => {
            if (expandable) onToggle(session.rootKey);
            else onOpenMain(session.rootKey);
          }}
        >
          <span className="scard-face">
            <Face
              mood={mood}
              hue={faceHue(session.sessionId)}
              breathing={status === 'working' && !stale && !needsYou}
              type={type}
            />
          </span>
          <span className="scard-text">
            <span className="scard-name-line">
              <span className="scard-name" title={nameTip}>
                {identity?.title ?? name}
              </span>
              {identity !== null && identity.disambiguator !== null && (
                <span
                  className="scard-disambig"
                  title="Another session has the same name: this is when this one started"
                >
                  {identity.disambiguator}
                </span>
              )}
              {identity !== null && (identity.model !== null || identity.worktree) && (
                // Chips that do not fit next to the name drop out whole (they wrap onto a hidden second line).
                <span className="scard-chips">
                  {identity.model !== null && (
                    <span className="scard-chip scard-model" title={session.root.model ?? undefined}>
                      {identity.model}
                    </span>
                  )}
                  {identity.worktree && (
                    <span className="scard-chip scard-worktree" title="Runs in its own git worktree">
                      worktree
                    </span>
                  )}
                </span>
              )}
              {hidden > 0 && (
                <span className="scard-count" title={`${String(hidden)} more agent${hidden === 1 ? '' : 's'}`}>
                  +{hidden}
                </span>
              )}
            </span>
            {identity !== null && identity.topic !== null && (
              <span className="scard-line scard-topic" title={identity.topic}>
                {identity.topic}
              </span>
            )}
            {need !== null ? (
              <span className="scard-line scard-need">
                <span className="glyph tone-needs-you" aria-hidden="true">
                  ▲
                </span>
                <span className="scard-need-words">{need.words}</span>
                {askerName !== null && <span className="scard-who">{askerName}</span>}
              </span>
            ) : (
              <span className="scard-line" title={activity ?? undefined}>
                <StatusGlyph status={status} stale={stale} />
                <span className={`scard-status tone-${look.tone}`}>{look.label}</span>
                {activity !== null && <span className="scard-activity">{activity}</span>}
              </span>
            )}
            <span className="scard-line scard-meta">
              {progress !== null ? (
                <span className="scard-progress" title={progress.title}>
                  {progress.lead !== null && <span className="scard-lead">{progress.lead}</span>}
                  <span className="scard-progress-text">{progress.text}</span>
                </span>
              ) : (
                // No progress to show (not running, or nothing to measure by): where the session works, or, when the
                // title already is the folder, when it started.
                <span className="scard-progress scard-folder" title={identity?.projectPath ?? session.cwd ?? undefined}>
                  {identity === null
                    ? orUnknown(null)
                    : identity.titleFrom === 'project'
                      ? startedWords(identity.startedAgo)
                      : orUnknown(identity.project)}
                </span>
              )}
              {m !== null && m.contextHighPct !== null && (
                <span className="scard-ctx" title={`Context ${String(Math.round(m.contextHighPct))}% full`}>
                  ctx {Math.round(m.contextHighPct)}%
                </span>
              )}
              {root !== null && <BudgetChip state={state} rootKey={root.key} now={now} />}
              <span className="scard-usage" title={m?.usageTitle ?? 'session usage unknown'}>
                {m?.usage ?? approxUsd(null)}
              </span>
            </span>
          </span>
        </button>
        {running && (
          // Outside the button, so assistive tech reads it as a progress bar. Unknown is a hatched track, never 0.
          <Bar
            className="scard-pbar"
            thin
            tone={tone}
            fraction={progress?.fraction ?? null}
            label={`${name}: progress`}
            valueText={progress === null ? 'unknown: no tasks or subagents to measure by' : progress.title}
          />
        )}
        <span className="scard-actions">
          <button
            type="button"
            className="icon-button"
            title="Open in the main window"
            aria-label={`Open ${name} in the main window`}
            onClick={() => {
              onOpenMain(need?.agentKey ?? session.rootKey);
            }}
          >
            <OpenIcon />
          </button>
          {onHide !== null && (
            <button
              type="button"
              className="icon-button"
              title={HIDE_HINT}
              aria-label={`Hide ${name} until it does something new`}
              onClick={onHide}
            >
              <CloseIcon />
            </button>
          )}
        </span>
      </div>

      {need?.item && (
        <div className="scard-request">
          <InboxCard
            key={need.item.id}
            state={state}
            item={need.item}
            renames={renames}
            onCommand={onCommand}
            onAgent={onOpenMain}
            compact
            inline
            now={props.fixedNow}
            armKey={props.slot === undefined ? undefined : `${need.item.id}@${String(props.slot)}`}
          />
          {card.moreNeeds > 0 && (
            <button
              type="button"
              className="link-button scard-more"
              onClick={() => {
                onOpenMain(need.agentKey);
              }}
            >
              {card.moreNeeds} more waiting in this session · open the inbox
            </button>
          )}
        </div>
      )}

      {expanded && (
        <div className="scard-open">
          {tasks.length > 0 && (
            <ul className="scard-tasks" aria-label="Tasks">
              {tasks.map((t) => {
                // Shape and words for each state, never colour alone: ✓ done, ◐ in progress, ○ to do.
                const mark = t.status === 'completed' ? 'done' : t.id === currentTask?.id ? 'current' : 'todo';
                return (
                  <li key={t.id} className={mark === 'done' ? 'is-done' : mark === 'current' ? 'is-current' : ''}>
                    <span className="task-mark" aria-hidden="true">
                      {mark === 'done' ? '✓' : mark === 'current' ? '◐' : '○'}
                    </span>
                    <span className="task-subject">{t.subject}</span>
                    {mark === 'current' ? (
                      <span className="task-state">in progress</span>
                    ) : (
                      <span className="visually-hidden">{mark === 'done' ? ', done' : ', to do'}</span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {rows.length > 0 && (
            <TeamTree
              roleKinds={state.settings?.roleKinds}
              rows={rows}
              renames={renames}
              selectedKey={null}
              onActivate={(row) => {
                onOpenMain(row.key);
              }}
              onToggle={onToggle}
              mode="widget"
              rowHeight={28}
              meters={props.meters}
              label={`Agents in ${name}`}
            />
          )}
        </div>
      )}
    </article>
  );
}
