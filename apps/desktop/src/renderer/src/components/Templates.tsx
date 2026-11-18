/**
 * Team templates (M4, F17): the saved launch setups from `HuddleState.templates`, each with Launch, Edit, Duplicate
 * and Delete (inline confirmation), and the editor (the launch form's fields plus name, description and agents).
 * Saving sends `template.upsert`, deleting `template.remove`, launching `run.launch` with the template's id.
 * Template text is the user's own but is still rendered as text.
 */
import { useState } from 'react';
import {
  ROLE_PROFILES,
  selectLaunchControl,
  type CommandResult,
  type HuddleCommand,
  type HuddleState,
  type TeamTemplate,
} from '@huddle/shared';
import type { QueryFn } from '../query.js';
import {
  EMPTY_DRAFT,
  draftFromTemplate,
  duplicateTemplate,
  hasOwnRules,
  launchTemplateCommand,
  newTemplateId,
  saveOutcome,
  SECRET_WORDS,
  TEMPLATE_RULES_REASON,
  templateFromDraft,
  templateLaunchControl,
  templateSummary,
  validateDraft,
  type LaunchDraft,
} from '../view/launch.js';
import { templateBudgetWords } from '../view/runs.js';
import { selfReportEnabled } from '../view/self-report.js';
import { MEMBER_KINDS, TEAM_PRESETS, typedTeamDraft, type MemberKind } from '../view/team-presets.js';
import { ControlButton } from './ControlButton.js';
import { TemplateFields } from './LaunchForm.js';

type Send = (cmd: HuddleCommand) => Promise<CommandResult>;

const ON = { enabled: true, reason: null };

export interface TemplateEditorProps {
  /** The template being edited, or null for a new one. */
  template: TeamTemplate | null;
  onCommand: Send;
  query: QueryFn | null;
  onDone: () => void;
  initialDraft?: LaunchDraft;
  initialChecked?: boolean;
  /** Tests: the editor as it is after a save that came back with a warning, or a refusal. */
  initialWarning?: string | null;
  initialError?: string | null;
  /** The global Self-reported progress setting is off (F27). */
  selfReportOff?: boolean;
}

export function TemplateEditor({
  template,
  onCommand,
  query,
  onDone,
  initialDraft,
  initialChecked = false,
  initialWarning = null,
  initialError = null,
  selfReportOff = false,
}: TemplateEditorProps) {
  const [draft, setDraft] = useState<LaunchDraft>(
    initialDraft ?? (template ? draftFromTemplate(template) : EMPTY_DRAFT),
  );
  const [checked, setChecked] = useState(initialChecked);
  const [error, setError] = useState<string | null>(initialError);
  const [busy, setBusy] = useState(false);
  // A save that came back with a warning keeps the editor open (the note sits under the prompt); a second save must
  // replace that template, not add another, so its id is kept.
  const [savedId, setSavedId] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(initialWarning);
  const errors = checked ? validateDraft(draft, true) : {};

  const save = () => {
    setChecked(true);
    setError(null);
    setWarning(null);
    if (Object.keys(validateDraft(draft, true)).length > 0) return;
    const id = template?.id ?? savedId ?? newTemplateId();
    const sent = draft;
    setBusy(true);
    void onCommand({ type: 'template.upsert', template: templateFromDraft(sent, id, template?.ruleIds) }).then((r) => {
      setBusy(false);
      const outcome = saveOutcome(r, sent);
      if (outcome.kind === 'done') onDone();
      else if (outcome.kind === 'warning') {
        setSavedId(id);
        setWarning(outcome.warning);
      } else setError(outcome.error);
    });
  };

  return (
    <section className="template-editor" aria-label={template ? `Edit ${template.name}` : 'New template'}>
      <h2 className="section-title">{template ? 'Edit template' : 'New template'}</h2>
      <TemplateFields
        draft={draft}
        errors={errors}
        onChange={setDraft}
        query={query}
        editor
        selfReportOff={selfReportOff}
        promptWarning={warning === null ? null : `${SECRET_WORDS.saved} ${warning}`}
      />
      {hasOwnRules(template) && <p className="form-warning">{TEMPLATE_RULES_REASON}</p>}
      <div className="form-actions">
        <ControlButton control={ON} variant="primary" busy={busy} onPress={save}>
          Save template
        </ControlButton>
        <ControlButton control={ON} variant="quiet" onPress={onDone}>
          {warning === null ? 'Cancel' : 'Close'}
        </ControlButton>
        {checked && Object.keys(errors).length > 0 && (
          <span className="inline-error" role="status">
            Fix the fields marked above.
          </span>
        )}
      </div>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function TemplateRow({
  template,
  launch,
  onCommand,
  onEdit,
}: {
  template: TeamTemplate;
  launch: { enabled: boolean; reason: string | null };
  onCommand: Send;
  onEdit: () => void;
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
  const agents = Object.keys(template.agents ?? {});
  // The caps show in the row (M4 runbook: an edited cap was not visible in the list).
  const budgetWords = templateBudgetWords(template.budgets);
  return (
    <li className="manage-row">
      <div className="manage-row-main">
        <span className="manage-name">{template.name}</span>
        <span className="manage-meta">{templateSummary(template)}</span>
        {budgetWords !== null && <span className="manage-meta template-budget">{budgetWords}</span>}
        {template.description && <span className="manage-desc">{template.description}</span>}
        {agents.length > 0 && <span className="manage-meta code">{agents.join(', ')}</span>}
        {hasOwnRules(template) && <span className="form-warning">{TEMPLATE_RULES_REASON}</span>}
      </div>
      {confirm ? (
        <div className="manage-actions" role="group" aria-label={`Confirm deleting ${template.name}`}>
          <span className="confirm-words">Delete this template?</span>
          <ControlButton
            control={ON}
            className="control-danger"
            onPress={() => {
              setConfirm(false);
              send({ type: 'template.remove', templateId: template.id }, null);
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
          <ControlButton
            control={templateLaunchControl(template, launch)}
            variant="primary"
            hint="Start a run from this template"
            onPress={() => {
              send(launchTemplateCommand(template.id), 'Launch sent. The run shows up in the team when it starts.');
            }}
          >
            Launch
          </ControlButton>
          <ControlButton control={ON} onPress={onEdit}>
            Edit
          </ControlButton>
          <ControlButton
            control={ON}
            variant="quiet"
            onPress={() => {
              send({ type: 'template.upsert', template: duplicateTemplate(template, newTemplateId()) }, null);
            }}
          >
            Duplicate
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

export interface TemplatesPanelProps {
  state: HuddleState;
  onCommand: Send;
  query: QueryFn | null;
  /** Open the editor at once: a template id, or 'new' (tests and the palette). */
  initialEditing?: string | null;
}

/**
 * "Start a typed team": preset buttons and a picker of member types. Each opens the editor on a new template draft
 * with that team (`view/team-presets.ts`); the user picks the folder, writes the task and saves as usual.
 */
function TypedTeamStart({ onStart }: { onStart: (draft: LaunchDraft) => void }) {
  const [picking, setPicking] = useState(false);
  const [kinds, setKinds] = useState<MemberKind[]>(['builder', 'reviewer']);
  return (
    <>
      <div className="form-actions" role="group" aria-label="Start a typed team">
        <span className="muted">Start a typed team:</span>
        {TEAM_PRESETS.map((p) => (
          <ControlButton
            key={p.id}
            control={ON}
            variant="quiet"
            hint={`New template. ${typedTeamDraft(p.kinds).description}`}
            onPress={() => {
              onStart(typedTeamDraft(p.kinds));
            }}
          >
            {p.label}
          </ControlButton>
        ))}
        <ControlButton
          control={ON}
          variant="quiet"
          pressed={picking}
          onPress={() => {
            setPicking(!picking);
          }}
        >
          Pick types…
        </ControlButton>
      </div>
      {picking && (
        <fieldset className="form-group">
          <legend className="form-label">Members (the main agent leads them)</legend>
          {MEMBER_KINDS.map((k) => (
            <span key={k} className="switch-row">
              <input
                id={`typed-team-${k}`}
                type="checkbox"
                className="checkbox"
                checked={kinds.includes(k)}
                onChange={(e) => {
                  setKinds(e.target.checked ? [...kinds, k] : kinds.filter((x) => x !== k));
                }}
              />
              <label htmlFor={`typed-team-${k}`} title={ROLE_PROFILES[k].about}>
                {ROLE_PROFILES[k].label}
              </label>
            </span>
          ))}
          <div className="form-actions">
            <ControlButton
              control={kinds.length > 0 ? ON : { enabled: false, reason: 'Pick at least one member type' }}
              onPress={() => {
                onStart(typedTeamDraft(kinds));
              }}
            >
              Start team
            </ControlButton>
          </div>
        </fieldset>
      )}
    </>
  );
}

export function TemplatesPanel({ state, onCommand, query, initialEditing = null }: TemplatesPanelProps) {
  const [editing, setEditing] = useState<string | null>(initialEditing);
  // A typed team's draft for the new-template editor; undefined: a blank one.
  const [startDraft, setStartDraft] = useState<LaunchDraft | undefined>(undefined);
  const templates = state.templates ?? [];
  const launch = selectLaunchControl(state.connection);
  const current = editing === null || editing === 'new' ? null : (templates.find((t) => t.id === editing) ?? null);

  return (
    <article className="detail manage" aria-label="Templates">
      <header className="detail-head">
        <div className="name-block">
          <h1 className="visually-hidden">Templates</h1>
        </div>
        <p className="muted">Saved launch setups: folder, prompt, agents, mode, budget and worktree.</p>
      </header>
      <div className="panel">
        {editing !== null ? (
          <TemplateEditor
            key={editing}
            template={current}
            onCommand={onCommand}
            query={query}
            initialDraft={editing === 'new' ? startDraft : undefined}
            selfReportOff={!selfReportEnabled(state)}
            onDone={() => {
              setEditing(null);
              setStartDraft(undefined);
            }}
          />
        ) : (
          <>
            <div className="form-actions">
              <ControlButton
                control={ON}
                onPress={() => {
                  setStartDraft(undefined);
                  setEditing('new');
                }}
              >
                New template
              </ControlButton>
            </div>
            <TypedTeamStart
              onStart={(draft) => {
                setStartDraft(draft);
                setEditing('new');
              }}
            />
            {state.templates === undefined && <p className="muted">Huddle hasn't sent its templates.</p>}
            {state.templates !== undefined && templates.length === 0 && (
              <p className="empty-line">No templates yet. Make one to launch the same team again with one click.</p>
            )}
            {templates.length > 0 && (
              <ul className="manage-list" aria-label="Templates">
                {templates.map((t) => (
                  <TemplateRow
                    key={t.id}
                    template={t}
                    launch={launch}
                    onCommand={onCommand}
                    onEdit={() => {
                      setEditing(t.id);
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
