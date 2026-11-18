/**
 * Library › Skills (F28): the Claude Code skills in the projects Huddle knows (`skills.list`), plus the user's own
 * skills, shown read-only. New skill and Edit write `<project>/.claude/skills/<name>/SKILL.md` through `skill.save`;
 * the folder is picked from the known projects, never typed. An existing file is replaced only after the user presses
 * "Replace it" (the core answers `exists` first). Everything read from a file is rendered as text.
 */
import { useViewMode } from '../viewMode.js';
import { useCallback, useEffect, useId, useState } from 'react';
import {
  skillDraftErrors,
  type CommandResult,
  type HuddleCommand,
  type KnownProject,
  type SkillDraft,
  type SkillInfo,
  type SkillsAnswer,
} from '@huddle/shared';
import type { QueryFn } from '../query.js';
import { QUERY_UNAVAILABLE } from '../query.js';
import { EMPTY_SKILL_DRAFT, ORCH_WORDS as W, skillSaveCommand, skillSaveOutcome } from '../view/orch.js';
import { ControlButton } from './ControlButton.js';
import { plainLine } from '../view/markdown.js';
import { Field } from './LaunchForm.js';

type Send = (cmd: HuddleCommand) => Promise<CommandResult>;
const ON = { enabled: true, reason: null };

/** aria-invalid and the error line's id for a field that has an error (the Field draws the line). */
function invalidProps(fieldId: string, error: string | undefined) {
  return error ? { 'aria-invalid': true as const, 'aria-describedby': `${fieldId}-error` } : {};
}

export type SkillsLoad =
  { kind: 'loading' } | { kind: 'ready'; answer: SkillsAnswer } | { kind: 'failed'; text: string };

async function loadSkills(query: QueryFn | null): Promise<SkillsLoad> {
  if (query === null) return { kind: 'failed', text: QUERY_UNAVAILABLE };
  try {
    const r = await query({ type: 'skills.list' });
    if (r.ok && r.type === 'skills.list') return { kind: 'ready', answer: r.answer };
    return { kind: 'failed', text: r.ok ? 'Unexpected answer.' : r.message };
  } catch {
    return { kind: 'failed', text: "Huddle couldn't read the skills." };
  }
}

export interface SkillEditorProps {
  projects: readonly KnownProject[];
  onCommand: Send;
  onDone: (saved: boolean) => void;
  /** Editing: the project and name are fixed. */
  fixed?: { projectPath: string; name: string } | null;
  initialDraft?: SkillDraft;
  initialProject?: string;
}

export function SkillEditor({
  projects,
  onCommand,
  onDone,
  fixed = null,
  initialDraft = EMPTY_SKILL_DRAFT,
  initialProject,
}: SkillEditorProps) {
  const base = useId();
  const id = (f: string) => `${base}-${f}`;
  const [draft, setDraft] = useState<SkillDraft>(initialDraft);
  const [project, setProject] = useState(fixed?.projectPath ?? initialProject ?? projects[0]?.path ?? '');
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [askReplace, setAskReplace] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errors = checked ? skillDraftErrors(draft, project === '' ? null : project) : {};
  const set = <K extends keyof SkillDraft>(key: K, value: SkillDraft[K]) => {
    setAskReplace(false);
    setDraft((d) => ({ ...d, [key]: value }));
  };

  const save = (overwrite: boolean) => {
    setChecked(true);
    setError(null);
    if (Object.keys(skillDraftErrors(draft, project === '' ? null : project)).length > 0) return;
    setBusy(true);
    void onCommand(skillSaveCommand(project, draft, overwrite)).then((r) => {
      setBusy(false);
      const outcome = skillSaveOutcome(r);
      if (outcome.kind === 'done') onDone(true);
      else if (outcome.kind === 'exists') setAskReplace(true);
      else setError(outcome.text);
    });
  };

  return (
    <section className="orch-editor" aria-label={fixed ? W.editSkill : W.newSkill}>
      <h2 className="section-title">{fixed ? W.editSkill : W.newSkill}</h2>
      <Field id={id('project')} label={W.projectLabel} error={errors.project}>
        <select
          id={id('project')}
          {...invalidProps(id('project'), errors.project)}
          className="text-input select-input"
          value={project}
          disabled={fixed !== null}
          onChange={(e) => {
            setAskReplace(false);
            setProject(e.target.value);
          }}
        >
          {projects.length === 0 && <option value="">—</option>}
          {projects.map((p) => (
            <option key={p.key} value={p.path} title={p.path}>
              {p.name}
            </option>
          ))}
        </select>
      </Field>
      <Field id={id('name')} label={W.nameLabel} error={errors.name} note={W.nameNote}>
        <input
          id={id('name')}
          {...invalidProps(id('name'), errors.name)}
          className="text-input code"
          maxLength={64}
          value={draft.name}
          readOnly={fixed !== null}
          spellCheck={false}
          onChange={(e) => {
            set('name', e.target.value);
          }}
        />
      </Field>
      <Field id={id('desc')} label={W.descriptionLabel} error={errors.description}>
        <input
          id={id('desc')}
          {...invalidProps(id('desc'), errors.description)}
          className="text-input"
          maxLength={1024}
          value={draft.description}
          onChange={(e) => {
            set('description', e.target.value);
          }}
        />
      </Field>
      <Field id={id('body')} label={W.instructionsLabel} error={errors.instructions}>
        <textarea
          id={id('body')}
          {...invalidProps(id('body'), errors.instructions)}
          className="text-input orch-body"
          rows={12}
          maxLength={20_000}
          value={draft.instructions}
          onChange={(e) => {
            set('instructions', e.target.value);
          }}
        />
      </Field>
      {askReplace ? (
        <div className="form-actions" role="group" aria-label={W.replaceAsk}>
          <span className="confirm-words">{W.replaceAsk}</span>
          <ControlButton
            control={ON}
            className="control-danger"
            busy={busy}
            onPress={() => {
              save(true);
            }}
          >
            {W.replace}
          </ControlButton>
          <ControlButton
            control={ON}
            variant="quiet"
            onPress={() => {
              setAskReplace(false);
            }}
          >
            Back
          </ControlButton>
        </div>
      ) : (
        <div className="form-actions">
          <ControlButton
            control={ON}
            variant="primary"
            busy={busy}
            onPress={() => {
              save(false);
            }}
          >
            {W.saveSkill}
          </ControlButton>
          <ControlButton
            control={ON}
            variant="quiet"
            onPress={() => {
              onDone(false);
            }}
          >
            Cancel
          </ControlButton>
        </div>
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function SkillRow({ skill, projectName, onEdit }: { skill: SkillInfo; projectName: string; onEdit?: () => void }) {
  return (
    <li className="manage-row orch-row">
      <div className="manage-row-main">
        <span className="manage-name code">{skill.name ?? skill.dirName}</span>
        <span className="manage-meta" title={skill.file}>
          {skill.scope === 'user' ? W.userSkill : projectName}
        </span>
        {skill.description !== null && <span className="manage-desc">{plainLine(skill.description)}</span>}
        {skill.problem !== null && <span className="form-warning">{skill.problem}</span>}
      </div>
      <div className="manage-actions">
        {skill.editable && onEdit ? (
          <ControlButton control={ON} onPress={onEdit}>
            Edit
          </ControlButton>
        ) : (
          skill.scope === 'user' && (
            <>
              <span className="control-reason orch-reason">{W.userSkillHint}</span>
              <ControlButton control={{ enabled: false, reason: W.userSkillHint }} onPress={() => undefined}>
                Edit
              </ControlButton>
            </>
          )
        )}
      </div>
    </li>
  );
}

type Editing =
  | null
  | { mode: 'new'; draft: SkillDraft }
  | { mode: 'edit'; projectPath: string; name: string; draft: SkillDraft | null; error: string | null };

export interface SkillsPanelProps {
  query: QueryFn | null;
  onCommand: Send;
  /** "Create skill from this" (Ask): the new-skill form opens filled in. Never sent until Save. */
  prefill?: SkillDraft | null;
  /** Tests: what the list shows without asking the core. */
  initialLoad?: SkillsLoad;
}

export function SkillsPanel({ query, onCommand, prefill = null, initialLoad }: SkillsPanelProps) {
  const { simple } = useViewMode();
  const [load, setLoad] = useState<SkillsLoad>(initialLoad ?? { kind: 'loading' });
  const [editing, setEditing] = useState<Editing>(prefill !== null ? { mode: 'new', draft: prefill } : null);
  const [note, setNote] = useState<string | null>(null);
  const reload = useCallback(() => {
    void loadSkills(query).then(setLoad);
  }, [query]);
  useEffect(() => {
    if (initialLoad === undefined) reload();
  }, [reload, initialLoad]);

  const answer = load.kind === 'ready' ? load.answer : null;
  const projects = answer?.projects ?? [];
  const nameOf = (path: string | null) => projects.find((p) => p.path === path)?.name ?? path ?? '';

  const startEdit = (skill: SkillInfo) => {
    if (skill.projectPath === null || query === null) return;
    const projectPath = skill.projectPath;
    setEditing({ mode: 'edit', projectPath, name: skill.dirName, draft: null, error: null });
    void query({ type: 'skill.read', projectPath, name: skill.dirName }).then(
      (r) => {
        setEditing((cur) =>
          cur?.mode !== 'edit' || cur.projectPath !== projectPath || cur.name !== skill.dirName
            ? cur
            : r.ok && r.type === 'skill.read'
              ? {
                  ...cur,
                  draft: { name: r.skill.name, description: r.skill.description, instructions: r.skill.instructions },
                }
              : { ...cur, error: r.ok ? 'Unexpected answer.' : r.message },
        );
      },
      () => {
        setEditing((cur) =>
          cur?.mode === 'edit' && cur.projectPath === projectPath && cur.name === skill.dirName
            ? { ...cur, error: "Huddle couldn't read the skill." }
            : cur,
        );
      },
    );
  };
  const done = (saved: boolean) => {
    setEditing(null);
    setNote(saved ? W.saved : null);
    if (saved) reload();
  };

  return (
    <article className="detail manage orch" aria-label={W.skillsTitle}>
      <header className="detail-head">
        <div className="name-block">
          <h1 className="visually-hidden">{W.skillsTitle}</h1>
        </div>
        {!simple && <p className="muted">{W.skillsIntro}</p>}
      </header>
      <div className="panel">
        {editing?.mode === 'new' && (
          <SkillEditor projects={projects} onCommand={onCommand} onDone={done} initialDraft={editing.draft} />
        )}
        {editing?.mode === 'edit' &&
          (editing.draft !== null ? (
            <SkillEditor
              projects={projects}
              onCommand={onCommand}
              onDone={done}
              fixed={{ projectPath: editing.projectPath, name: editing.name }}
              initialDraft={editing.draft}
            />
          ) : (
            <p className={editing.error ? 'inline-error' : 'muted'} role={editing.error ? 'alert' : 'status'}>
              {editing.error ?? W.loading}
            </p>
          ))}
        {(editing === null || (editing.mode === 'edit' && editing.error !== null)) && (
          <>
            <div className="form-actions">
              <ControlButton
                control={projects.length > 0 ? ON : { enabled: false, reason: W.noProjects }}
                onPress={() => {
                  setNote(null);
                  setEditing({ mode: 'new', draft: EMPTY_SKILL_DRAFT });
                }}
              >
                {W.newSkill}
              </ControlButton>
              {note && (
                <span className="form-sent" role="status">
                  {note}
                </span>
              )}
            </div>
            {load.kind === 'loading' && <p className="muted">{W.loading}</p>}
            {load.kind === 'failed' && (
              <p className="inline-error" role="alert">
                {load.text}
              </p>
            )}
            {answer !== null && answer.projects.length === 0 && <p className="empty-line">{W.noProjects}</p>}
            {answer !== null && answer.skills.length === 0 && answer.projects.length > 0 && (
              <p className="empty-line">{W.noSkills}</p>
            )}
            {answer !== null && answer.skills.length > 0 && (
              <ul className="manage-list" aria-label={W.skillsTitle}>
                {answer.skills.map((s) => (
                  <SkillRow
                    key={`${s.scope}:${s.projectPath ?? ''}:${s.dirName}`}
                    skill={s}
                    projectName={nameOf(s.projectPath)}
                    onEdit={() => {
                      startEdit(s);
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
