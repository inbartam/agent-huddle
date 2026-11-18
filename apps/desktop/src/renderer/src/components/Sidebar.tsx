/**
 * The main window's sidebar (main window redesign, WP2): Needs you (only when something waits), then Projects. Each
 * project is collapsible (chevron, folder name, `● n` working and `▲ n` needs-you counts) and holds its live sessions,
 * drawn by the shared TeamTree with its rails (session row: glyph, readable title, model · age; agents below it).
 * "Earlier · N ended sessions" opens History; "+ New run" opens Launch; "Show all" brings back hidden test and empty
 * runs. Projects and their order come from the shared `selectProjects` (ADR-016); this file only draws them.
 *
 * Every project name, path and session title may come from an agent or a path on disk: text nodes only.
 */
import { useId, useMemo } from 'react';
import { type AgentKey, type HuddleState, type ProjectView, type SessionIdentity } from '@huddle/shared';
import type { HuddleStore } from '../store.js';
import {
  earlierCount,
  earlierWords,
  isProjectOpen,
  projectCountWords,
  sessionMeta,
  sessionMetaSimple,
  showAllWords,
} from '../view/shell.js';
import { buildRows, type TreeRow } from '../view/tree.js';
import { useViewMode } from '../viewMode.js';
import { EmptyState } from './Chrome.js';
import { NeedsYou } from './NeedsYou.js';
import { TeamTree } from './TeamTree.js';

export interface SidebarProps {
  store: HuddleStore;
  state: HuddleState;
  renames: ReadonlyMap<AgentKey, string>;
  /** The agent shown in the main area, highlighted in its tree; null when the main area shows something else. */
  selectedKey: AgentKey | null;
  /** Rows the user flipped away from their default expansion (shared with reveal). */
  toggled: ReadonlySet<AgentKey>;
  onToggle: (key: AgentKey) => void;
  /** What the user chose per project id (open or closed); a project without a choice is open while it has a live session. */
  projectChoices: ReadonlyMap<string, boolean>;
  onProjectOpen: (projectId: string, open: boolean) => void;
  /** A session or agent row picked: show it in the main area. */
  onPick: (key: AgentKey) => void;
  /** Show an agent from Needs you (opens its session too). */
  onAgent: (key: AgentKey) => void;
  linkedItemId: string | null;
  identity: (rootKey: AgentKey) => SessionIdentity | null;
  /** `selectProjects(state, { huddleStartedAt, showAll })`, computed once by the window. */
  projects: readonly ProjectView[];
  /** `selectHiddenSessionCount` without showAll: what "Show all" adds. */
  hidden: number;
  showAll: boolean;
  onShowAll: (on: boolean) => void;
  onNewRun: () => void;
  onEarlier: () => void;
  now?: number;
}

/** One project: its header button and, when open, its sessions' tree. */
function ProjectGroup({
  project,
  open,
  onOpen,
  props,
}: {
  project: ProjectView;
  open: boolean;
  onOpen: (open: boolean) => void;
  props: SidebarProps;
}) {
  const rows = useMemo(
    () => buildRows(project.sessions, { toggled: props.toggled }),
    [project.sessions, props.toggled],
  );
  const bodyId = useId();
  const { simple } = useViewMode();
  return (
    <div className="project">
      <button
        type="button"
        className="project-head"
        aria-expanded={open}
        aria-controls={bodyId}
        aria-label={`${project.name}, ${projectCountWords(project)}`}
        title={project.path ?? 'Folder unknown'}
        onClick={() => {
          onOpen(!open);
        }}
      >
        <span className="project-chev" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        <span className="project-name">{project.name}</span>
        <span className="project-counts" aria-hidden="true">
          {project.workingCount > 0 && <span className="tone-working">● {String(project.workingCount)}</span>}
          {project.needsYouCount > 0 && <span className="tone-needs-you">▲ {String(project.needsYouCount)}</span>}
        </span>
      </button>
      {open && (
        <div id={bodyId} className="project-body">
          {project.sessions.length > 0 ? (
            <TeamTree
              roleKinds={props.state.settings?.roleKinds}
              rows={rows}
              renames={props.renames}
              selectedKey={props.selectedKey}
              onActivate={(row: TreeRow) => {
                props.onPick(row.key);
              }}
              onToggle={props.onToggle}
              mode="main"
              label={`${project.name}: sessions and their agents`}
              identity={props.identity}
              sessionMeta={simple ? sessionMetaSimple : sessionMeta}
            />
          ) : (
            <p className="project-empty">
              No live sessions.{project.earlier.length > 0 ? ' Ended ones are in History.' : ''}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export function Sidebar(props: SidebarProps) {
  const { store, state, renames, showAll, projects, hidden } = props;
  const earlier = earlierCount(projects);

  return (
    <nav className="sidebar" aria-label="Projects and sessions">
      <NeedsYou
        store={store}
        state={state}
        renames={renames}
        onAgent={props.onAgent}
        selectedId={props.linkedItemId}
        identity={props.identity}
        {...(props.now !== undefined ? { now: props.now } : {})}
      />
      <section className="projects" aria-label="Projects">
        <div className="side-head">
          <h2 className="side-title">Projects</h2>
          <button type="button" className="control control-plain side-new" onClick={props.onNewRun}>
            + New run
          </button>
        </div>
        {projects.length === 0 && (hidden === 0 || showAll) && <EmptyState />}
        {projects.length === 0 && hidden > 0 && !showAll && (
          <p className="empty">Only test and empty runs so far. Show all to see them.</p>
        )}
        {projects.map((p) => (
          <ProjectGroup
            key={p.id}
            project={p}
            open={isProjectOpen(props.projectChoices, p)}
            onOpen={(to) => {
              props.onProjectOpen(p.id, to);
            }}
            props={props}
          />
        ))}
        <div className="side-foot">
          {earlier > 0 && (
            <button type="button" className="side-earlier" onClick={props.onEarlier} title="Open History">
              <span>{earlierWords(earlier)}</span>
              <span aria-hidden="true">▸</span>
            </button>
          )}
          {(hidden > 0 || showAll) && (
            <button
              type="button"
              className="quiet-button side-showall"
              aria-pressed={showAll}
              title="Test runs from the developer exit-check scripts, and sessions opened and closed without a prompt"
              onClick={() => {
                props.onShowAll(!showAll);
              }}
            >
              {showAllWords(showAll, hidden)}
            </button>
          )}
        </div>
      </section>
    </nav>
  );
}
