/**
 * Library › Tasks (F29): the Huddle as orchestrator. A task is a title, details, a known project folder and an
 * optional template; Launch starts a run through the normal launch path (`huddle_task.launch`) and links it, and the
 * status follows the run (`selectHuddleTasks`). The list and the status come from the state the core sends
 * (`huddle_task.*` events), never from a copy kept here. Task text is the user's own but is still rendered as text.
 */
import { useViewMode } from '../viewMode.js';
import { useId, useState } from 'react';
import {
  selectHuddleTasks,
  selectKnownProjects,
  selectLaunchControl,
  MAX_KNOWN_PROJECTS,
  TASK_STATUS_WORDS,
  type AgentKey,
  type CommandResult,
  type HuddleCommand,
  type HuddleState,
  type HuddleTaskStatus,
  type HuddleTaskView,
  type KnownProject,
  type TeamTemplate,
} from '@huddle/shared';
import {
  EMPTY_TASK_DRAFT,
  ORCH_WORDS as W,
  draftFromTask,
  taskCreateCommand,
  taskDraftErrors,
  taskLaunchControl,
  taskUpdateCommand,
  type TaskDraft,
} from '../view/orch.js';
import { ControlButton } from './ControlButton.js';
import { MessageText } from './MessageText.js';
import { Field } from './LaunchForm.js';

type Send = (cmd: HuddleCommand) => Promise<CommandResult>;
const ON = { enabled: true, reason: null };

/** aria-invalid and the error line's id for a field that has an error (the Field draws the line). */
function invalidProps(fieldId: string, error: string | undefined) {
  return error ? { 'aria-invalid': true as const, 'aria-describedby': `${fieldId}-error` } : {};
}

/** Shape and word for each status, so it reads without color. */
const GLYPH: Record<HuddleTaskStatus, string> = { todo: '○', running: '◐', done: '✓', failed: '✕' };

export function TaskStatus({ status }: { status: HuddleTaskStatus }) {
  return (
    <span className={`task-status is-${status}`}>
      <span aria-hidden="true">{GLYPH[status]}</span> {TASK_STATUS_WORDS[status]}
    </span>
  );
}

export interface TaskEditorProps {
  /** The task being edited, or null for a new one. */
  task: HuddleTaskView | null;
  projects: readonly KnownProject[];
  templates: readonly TeamTemplate[];
  onCommand: Send;
  onDone: () => void;
  initialDraft?: TaskDraft;
}

export function TaskEditor({ task, projects, templates, onCommand, onDone, initialDraft }: TaskEditorProps) {
  const base = useId();
  const id = (f: string) => `${base}-${f}`;
  const [draft, setDraft] = useState<TaskDraft>(initialDraft ?? (task ? draftFromTask(task) : EMPTY_TASK_DRAFT));
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errors = checked ? taskDraftErrors(draft) : {};
  const set = <K extends keyof TaskDraft>(key: K, value: TaskDraft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
  };
  // A folder the task names that is not known any more still shows, so the select does not silently change it.
  const folderKnown = draft.projectPath === '' || projects.some((p) => p.path === draft.projectPath);
  // The picker lists at most MAX_KNOWN_PROJECTS folders; a chosen one past the cap is still listed, so it stays picked.
  const capped = projects.slice(0, MAX_KNOWN_PROJECTS);
  const chosenPastCap =
    draft.projectPath === '' || capped.some((p) => p.path === draft.projectPath)
      ? undefined
      : projects.find((p) => p.path === draft.projectPath);
  const shown = chosenPastCap === undefined ? capped : [...capped, chosenPastCap];

  const save = () => {
    setChecked(true);
    setError(null);
    if (Object.keys(taskDraftErrors(draft)).length > 0) return;
    setBusy(true);
    void onCommand(task ? taskUpdateCommand(task.taskId, draft) : taskCreateCommand(draft)).then((r) => {
      setBusy(false);
      if (r.ok) onDone();
      else setError(r.message);
    });
  };

  return (
    <section className="orch-editor" aria-label={task ? W.editTask : W.newTask}>
      <h2 className="section-title">{task ? W.editTask : W.newTask}</h2>
      <Field id={id('title')} label={W.titleLabel} error={errors.title}>
        <input
          id={id('title')}
          {...invalidProps(id('title'), errors.title)}
          className="text-input"
          maxLength={200}
          value={draft.title}
          onChange={(e) => {
            set('title', e.target.value);
          }}
        />
      </Field>
      <Field id={id('details')} label={W.detailsLabel}>
        <textarea
          id={id('details')}
          className="text-input"
          rows={5}
          maxLength={4000}
          value={draft.details}
          onChange={(e) => {
            set('details', e.target.value);
          }}
        />
      </Field>
      <Field id={id('project')} label={W.projectLabel} error={errors.where}>
        <select
          id={id('project')}
          {...invalidProps(id('project'), errors.where)}
          className="text-input select-input"
          value={draft.projectPath}
          onChange={(e) => {
            set('projectPath', e.target.value);
          }}
        >
          <option value="">{draft.templateId === '' ? '—' : W.templateFolder}</option>
          {!folderKnown && <option value={draft.projectPath}>{draft.projectPath}</option>}
          {shown.map((p) => (
            <option key={p.key} value={p.path} title={p.path}>
              {p.name}
            </option>
          ))}
        </select>
      </Field>
      <Field id={id('template')} label={W.templateLabel}>
        <select
          id={id('template')}
          className="text-input select-input"
          value={draft.templateId}
          onChange={(e) => {
            set('templateId', e.target.value);
          }}
        >
          <option value="">{W.noTemplate}</option>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </Field>
      {projects.length === 0 && templates.length === 0 && <p className="form-note">{W.noProjects}</p>}
      <div className="form-actions">
        <ControlButton control={ON} variant="primary" busy={busy} onPress={save}>
          {W.saveTask}
        </ControlButton>
        <ControlButton control={ON} variant="quiet" onPress={onDone}>
          Cancel
        </ControlButton>
      </div>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function TaskRow({
  task,
  launch,
  projects,
  templates,
  onCommand,
  onEdit,
  onOpenRun,
}: {
  task: HuddleTaskView;
  launch: { enabled: boolean; reason: string | null };
  projects: readonly KnownProject[];
  templates: readonly TeamTemplate[];
  onCommand: Send;
  onEdit: () => void;
  onOpenRun?: ((key: AgentKey) => void) | undefined;
}) {
  const [confirm, setConfirm] = useState(false);
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);
  const send = (cmd: HuddleCommand, okText: string | null) => {
    setNote(null);
    void onCommand(cmd).then((r) => {
      if (!r.ok) setNote({ text: r.message, ok: false });
      else if (okText) setNote({ text: okText, ok: true });
    });
  };
  const project = projects.find((p) => p.path === task.projectPath);
  const template = templates.find((t) => t.id === task.templateId);
  const where = [
    task.projectPath === null ? null : (project?.name ?? task.projectPath),
    task.templateId === null ? null : `template ${template?.name ?? '(not saved)'}`,
  ]
    .filter((s): s is string => s !== null)
    .join(' · ');
  // A second Launch while the first is on its way would start a second paid run: the button stays off until it answers.
  const [launching, setLaunching] = useState(false);
  const pressLaunch = () => {
    setNote(null);
    setLaunching(true);
    onCommand({ type: 'huddle_task.launch', taskId: task.taskId })
      .then((r) => {
        setNote(r.ok ? { text: W.launched, ok: true } : { text: r.message, ok: false });
      })
      .catch(() => {
        setNote({ text: "Huddle couldn't send the launch.", ok: false });
      })
      .finally(() => {
        setLaunching(false);
      });
  };
  const launchControl = taskLaunchControl(task, launch, templates, projects);
  return (
    <li className="manage-row orch-row">
      <div className="manage-row-main">
        <span className="manage-name">{task.title}</span>
        <TaskStatus status={task.status} />
        {where !== '' && (
          <span className="manage-meta" title={task.projectPath ?? undefined}>
            {where}
          </span>
        )}
        {/* Details are often an Ask answer (Make a task from this): drawn from their Markdown, text children only. */}
        {task.details !== '' && (
          <div className="manage-desc orch-details">
            <MessageText text={task.details} />
          </div>
        )}
      </div>
      {confirm ? (
        <div className="manage-actions" role="group" aria-label={`Confirm deleting ${task.title}`}>
          <span className="confirm-words">{W.deleteAsk}</span>
          <ControlButton
            control={ON}
            className="control-danger"
            onPress={() => {
              setConfirm(false);
              send({ type: 'huddle_task.delete', taskId: task.taskId }, null);
            }}
          >
            Delete
          </ControlButton>
          <ControlButton
            control={ON}
            variant="quiet"
            onPress={() => {
              setConfirm(false);
            }}
          >
            Back
          </ControlButton>
        </div>
      ) : (
        <div className="manage-actions">
          {!launchControl.enabled && launchControl.reason !== null && (
            // An off Launch says why in words, not only in its tooltip (owner review 2026-11-17).
            <span className="control-reason orch-reason">{launchControl.reason}</span>
          )}
          <ControlButton
            control={launchControl}
            variant="primary"
            hint="Start a run for this task"
            busy={launching}
            onPress={pressLaunch}
          >
            {launching ? W.launching : W.launch}
          </ControlButton>
          {task.runRootKey !== null && onOpenRun && (
            <ControlButton
              control={ON}
              onPress={() => {
                if (task.runRootKey !== null) onOpenRun(task.runRootKey);
              }}
            >
              {W.openRun}
            </ControlButton>
          )}
          {task.status !== 'running' && (
            <ControlButton
              control={ON}
              variant="quiet"
              onPress={() => {
                send(
                  { type: 'huddle_task.update', taskId: task.taskId, status: task.status === 'done' ? 'todo' : 'done' },
                  null,
                );
              }}
            >
              {task.status === 'done' ? W.reopen : W.markDone}
            </ControlButton>
          )}
          <ControlButton control={ON} variant="quiet" onPress={onEdit}>
            Edit
          </ControlButton>
          <ControlButton
            control={ON}
            variant="quiet"
            onPress={() => {
              setConfirm(true);
            }}
          >
            Delete…
          </ControlButton>
        </div>
      )}
      {note && (
        <p className={note.ok ? 'form-sent' : 'inline-error'} role={note.ok ? 'status' : 'alert'}>
          {note.text}
        </p>
      )}
    </li>
  );
}

export interface TasksPanelProps {
  state: HuddleState;
  onCommand: Send;
  /** Open a task's run in its session view. */
  onOpenRun?: (key: AgentKey) => void;
  /** "Make a task from this" (Ask): the new-task form opens filled in. Never sent until Save. */
  prefill?: TaskDraft | null;
}

export function TasksPanel({ state, onCommand, onOpenRun, prefill = null }: TasksPanelProps) {
  const { simple } = useViewMode();
  // The Ask prefill is used once: after its form closes (Save or Cancel), a later New task starts empty.
  const [draft, setDraft] = useState<TaskDraft | null>(prefill);
  const [editing, setEditing] = useState<string | null>(prefill !== null ? 'new' : null);
  const [gone, setGone] = useState<string | null>(null);
  const tasks = selectHuddleTasks(state);
  const projects = selectKnownProjects(state);
  const templates = state.templates ?? [];
  const launch = selectLaunchControl(state.connection);
  const current = editing === null || editing === 'new' ? null : (tasks.find((t) => t.taskId === editing) ?? null);
  // The task being edited was deleted meanwhile (another window, the phone): close the editor rather than let its Save
  // turn into a create that brings the task back.
  if (editing !== null && editing !== 'new' && current === null) {
    setEditing(null);
    setGone(W.taskDeleted);
  }
  const open = (id: string) => {
    setGone(null);
    setEditing(id);
  };

  return (
    <article className="detail manage orch" aria-label={W.tasksTitle}>
      <header className="detail-head">
        <div className="name-block">
          <h1 className="visually-hidden">{W.tasksTitle}</h1>
        </div>
        {!simple && <p className="muted">{W.tasksIntro}</p>}
      </header>
      <div className="panel">
        {editing !== null && (editing === 'new' || current !== null) ? (
          <TaskEditor
            key={editing}
            task={current}
            projects={projects}
            templates={templates}
            onCommand={onCommand}
            {...(editing === 'new' && draft !== null ? { initialDraft: draft } : {})}
            onDone={() => {
              setEditing(null);
              setDraft(null);
            }}
          />
        ) : (
          <>
            <div className="form-actions">
              <ControlButton
                control={ON}
                onPress={() => {
                  open('new');
                }}
              >
                {W.newTask}
              </ControlButton>
              {gone !== null && (
                <span className="form-sent" role="status">
                  {gone}
                </span>
              )}
            </div>
            {tasks.length === 0 && <p className="empty-line">{W.noTasks}</p>}
            {tasks.length > 0 && (
              <ul className="manage-list" aria-label={W.tasksTitle}>
                {tasks.map((t) => (
                  <TaskRow
                    key={t.taskId}
                    task={t}
                    launch={launch}
                    projects={projects}
                    templates={templates}
                    onCommand={onCommand}
                    onOpenRun={onOpenRun}
                    onEdit={() => {
                      open(t.taskId);
                    }}
                  />
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </article>
  );
}
