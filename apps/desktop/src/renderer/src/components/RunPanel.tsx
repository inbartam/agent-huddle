/**
 * The run panel in the agent detail (M4: F13 stop, F16 launch, F20 git safety net), for the main agent of a run the
 * Huddle launched (`node.run`). What the run is (template, permission mode, agents), how it stands or ended, the latest
 * turn's result, Stop and End, and the worktree: path, branch, what changed, and Open / Keep / Discard.
 *
 * Every button state comes from the shared `selectRunControls` (capabilities and the run's state), with the reason as
 * the tooltip. Discard asks for confirmation inline, in the panel; never `window.confirm`. Paths, branch names, file
 * names and errors are rendered as text.
 */
import { useState } from 'react';
import {
  isRunAlive,
  selectRunControls,
  type AgentNode,
  type CommandResult,
  type HuddleCommand,
  type HuddleState,
  type RunWorktree,
  type WorktreeFile,
} from '@huddle/shared';
import { count, orUnknown, plural, UNKNOWN } from '../view/format.js';
import { modeOption, LAUNCH_WORDS } from '../view/launch.js';
import {
  fileStatus,
  groupWorktreeFiles,
  resultFacts,
  runCommand,
  runStateWords,
  worktreeStateWords,
} from '../view/runs.js';
import { ControlButton } from './ControlButton.js';
import { Section } from './Meters.js';

type Send = (cmd: HuddleCommand) => Promise<CommandResult>;

export const RUN_WORDS = {
  stopHint: "Stops the run's process now.",
  endHint: "Closes the run's input, so it exits when its current turn ends.",
  openHint:
    'Sends the worktree folder to VS Code (VS Code may ask you to confirm), or opens it in File Explorer when VS Code is not installed.',
  toolState: 'tool state',
  toolStateNote:
    'Tool state: files that tools such as Claude Code or plugin hooks write while they run, usually not the work of the agents. They are part of the worktree and go with it on Discard.',
  keepHint: 'Keeps the branch so you can merge it; Huddle stops offering to discard it.',
  discardHint: 'Removes the worktree folder and its branch.',
  discardAsk: 'Discard removes the worktree folder and the branch',
  discardLost: 'Changes that were not merged are lost.',
  noSummary: 'No diff summary yet: Huddle summarizes the worktree when the run ends.',
} as const;

function useSend(send: Send) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const press = (cmd: HuddleCommand, after?: (detail: string | null) => void) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    void send(cmd).then((r) => {
      setBusy(false);
      if (!r.ok) setError(r.message);
      else after?.(r.detail ?? null);
    });
  };
  return { error, busy, press };
}

function templateName(state: HuddleState, templateId: string | null): string {
  if (templateId === null) return 'none: set up in the launch dialog';
  const t = (state.templates ?? []).find((x) => x.id === templateId);
  return t ? t.name : `${templateId} (no longer saved)`;
}

export interface RunPanelProps {
  state: HuddleState;
  agent: AgentNode;
  onCommand: Send;
  /** Start with the discard confirmation open (tests). */
  initialConfirmDiscard?: boolean;
}

export function RunPanel({ state, agent, onCommand, initialConfirmDiscard = false }: RunPanelProps) {
  const run = agent.run;
  const { error, busy, press } = useSend(onCommand);
  if (!run) return null;
  const controls = selectRunControls(agent);
  const alive = isRunAlive(run);
  const facts = resultFacts(run);
  const mode = modeOption(run.permissionMode);

  return (
    <>
      <Section title="Run" note="launched by Huddle">
        <dl className="facts">
          <dt>State</dt>
          <dd title={run.exited?.error ?? undefined}>
            {run.exited?.error ? `${runStateWords(run)}: ${run.exited.error}` : runStateWords(run)}
          </dd>
          <dt>Template</dt>
          <dd>{templateName(state, run.templateId)}</dd>
          <dt>Permission mode</dt>
          <dd className="code">{run.permissionMode}</dd>
          <dt>Runs as</dt>
          <dd className="code">{run.mainAgent ?? "Claude Code's main agent"}</dd>
          <dt>Agents defined</dt>
          <dd className="code">{run.agentNames.length > 0 ? run.agentNames.join(', ') : 'none'}</dd>
          {facts && (
            <>
              <dt>Last turn</dt>
              <dd className="tabular">
                {facts.isError ? 'ended with an error, ' : ''}
                {facts.duration}, {facts.turns} turns, {facts.cost}
                {Number(facts.denials) > 0 ? `, ${plural(Number(facts.denials), 'tool call')} denied` : ''}
              </dd>
            </>
          )}
        </dl>
        {mode?.bypassesHuddle && <p className="form-note form-warning">{LAUNCH_WORDS.modeBypasses}</p>}
        <div className="run-actions">
          <ControlButton
            control={controls.stop}
            hint={RUN_WORDS.stopHint}
            busy={busy}
            onPress={() => {
              press(runCommand.stop(run.runId));
            }}
          >
            Stop
          </ControlButton>
          <ControlButton
            control={controls.end}
            hint={RUN_WORDS.endHint}
            variant="quiet"
            busy={busy}
            onPress={() => {
              press(runCommand.end(run.runId));
            }}
          >
            End after this turn
          </ControlButton>
        </div>
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
      </Section>
      {run.worktree && (
        <WorktreePanel
          runId={run.runId}
          worktree={run.worktree}
          alive={alive}
          controls={controls}
          onCommand={onCommand}
          initialConfirm={initialConfirmDiscard}
        />
      )}
    </>
  );
}

function FileRow({ file }: { file: WorktreeFile }) {
  const st = fileStatus(file.status);
  return (
    <li>
      <span className="wt-mark code" title={st.word} aria-hidden="true">
        {st.mark}
      </span>
      <span className="visually-hidden">{st.word}: </span>
      <span className="code wt-file">{file.path}</span>
    </li>
  );
}

export interface WorktreePanelProps {
  runId: string;
  worktree: RunWorktree;
  alive: boolean;
  controls: ReturnType<typeof selectRunControls>;
  onCommand: Send;
  initialConfirm?: boolean;
}

export function WorktreePanel({
  runId,
  worktree,
  alive,
  controls,
  onCommand,
  initialConfirm = false,
}: WorktreePanelProps) {
  const [confirming, setConfirming] = useState(initialConfirm && controls.discard.enabled);
  const { error, busy, press } = useSend(onCommand);
  /** What main did on Open (VS Code, or File Explorer and why). Words from main, not from an agent. */
  const [opened, setOpened] = useState<string | null>(null);
  const s = worktree.summary;
  const shown = s?.files ?? [];
  const more = s ? Math.max(0, s.filesChanged - shown.length) : 0;
  const grouped = groupWorktreeFiles(shown);

  return (
    <Section title="Worktree" note={worktreeStateWords(worktree, alive)}>
      <dl className="facts">
        <dt>Folder</dt>
        <dd className="code wt-path" title={worktree.path}>
          {worktree.path}
        </dd>
        <dt>Branch</dt>
        <dd className="code">{worktree.branch}</dd>
        <dt>Base commit</dt>
        <dd className="code">{worktree.baseCommit ? worktree.baseCommit.slice(0, 12) : UNKNOWN}</dd>
        <dt>Changes</dt>
        <dd className="tabular">
          {s ? (
            // One span: .facts dd is a flex box, which would drop the spaces between the parts.
            <span>
              {plural(s.filesChanged, 'file')} changed, <span className="diff-add">+{count(s.insertions)}</span>{' '}
              <span className="diff-del">−{count(s.deletions)}</span>, {count(s.untracked)} untracked
              {grouped.toolStateCount > 0 && ` (${count(grouped.toolStateCount)} in tool-state folders)`}
            </span>
          ) : (
            <span className="muted">{RUN_WORDS.noSummary}</span>
          )}
        </dd>
      </dl>
      {grouped.changed.length > 0 && (
        <ul className="wt-files" aria-label="Changed files">
          {grouped.changed.map((f, i) => (
            <FileRow key={`${String(i)}:${f.path}`} file={f} />
          ))}
        </ul>
      )}
      {grouped.untracked.map((g) =>
        g.folder === null ? (
          <ul key="(root)" className="wt-files" aria-label="Untracked files">
            {g.files.map((f, i) => (
              <FileRow key={`${String(i)}:${f.path}`} file={f} />
            ))}
          </ul>
        ) : (
          // Tool state starts collapsed; other folders open. Nothing is hidden: the files are one click away.
          <details key={g.folder} className="wt-group" open={!g.toolState}>
            <summary>
              <span className="code">{g.folder}/</span> {plural(g.files.length, 'untracked file')}
              {g.toolState && <span className="wt-tool-state muted"> · {RUN_WORDS.toolState}</span>}
            </summary>
            <ul className="wt-files" aria-label={`Untracked files in ${g.folder}`}>
              {g.files.map((f, i) => (
                <FileRow key={`${String(i)}:${f.path}`} file={f} />
              ))}
            </ul>
          </details>
        ),
      )}
      {grouped.toolStateCount > 0 && <p className="form-note">{RUN_WORDS.toolStateNote}</p>}
      {more > 0 && <p className="muted">and {plural(more, 'more file')}</p>}
      {worktree.closeError && (
        <p className="inline-error" role="alert">
          {orUnknown(worktree.closeError)}
        </p>
      )}
      {confirming ? (
        <div className="confirm-inline" role="group" aria-label="Confirm discard">
          <p className="confirm-words">
            {RUN_WORDS.discardAsk} <span className="code">{worktree.branch}</span>. {RUN_WORDS.discardLost}
          </p>
          <div className="run-actions">
            <ControlButton
              control={controls.discard}
              className="control-danger"
              busy={busy}
              onPress={() => {
                press(runCommand.discard(runId), () => {
                  setConfirming(false);
                });
              }}
            >
              Discard
            </ControlButton>
            <ControlButton
              control={{ enabled: true, reason: null }}
              variant="quiet"
              onPress={() => {
                setConfirming(false);
              }}
            >
              Back
            </ControlButton>
          </div>
        </div>
      ) : (
        <div className="run-actions">
          <ControlButton
            control={controls.open}
            hint={RUN_WORDS.openHint}
            onPress={() => {
              setOpened(null);
              press(runCommand.open(runId), setOpened);
            }}
          >
            Open in VS Code
          </ControlButton>
          <ControlButton
            control={controls.keep}
            hint={RUN_WORDS.keepHint}
            busy={busy}
            onPress={() => {
              press(runCommand.keep(runId));
            }}
          >
            Keep
          </ControlButton>
          <ControlButton
            control={controls.discard}
            hint={RUN_WORDS.discardHint}
            variant="quiet"
            onPress={() => {
              setConfirming(true);
            }}
          >
            Discard…
          </ControlButton>
        </div>
      )}
      {opened && (
        <p className="form-sent" role="status">
          {opened}
        </p>
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
    </Section>
  );
}
