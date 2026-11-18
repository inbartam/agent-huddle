/**
 * The launch dialog (M4, F16) and the form it shares with the template editor (F17). One set of fields: folder (typed
 * or picked with the `pick.folder` query), first prompt, main agent, model, permission mode, worktree, budget, and in
 * the template editor a name, a description and up to MAX_TEMPLATE_AGENTS agents. Checks run in view/launch.ts and are
 * shown under the field they concern; main validates the command again.
 *
 * Launch sends `run.launch` with an inline template built from the fields. It is off, with the reason, while Huddle is
 * not attached (ADR-020 §1: the run's hooks report through the user's own settings).
 */
import { useId, useRef, useState, type ReactNode } from 'react';
import { selectLaunchControl, type CommandResult, type HuddleCommand, type HuddleState } from '@huddle/shared';
import { pickFolder, QUERY_UNAVAILABLE, type QueryFn } from '../query.js';
import {
  EMPTY_AGENT,
  EMPTY_DRAFT,
  LAUNCH_WORDS,
  MAX_TEMPLATE_AGENTS,
  modeOption,
  NAME_MAX,
  PERMISSION_MODE_OPTIONS,
  PROMPT_MAX,
  SECRET_WORDS,
  draftFromTemplate,
  saveOutcome,
  showsMask,
  hasOwnRules,
  launchCommandFor,
  TEMPLATE_RULES_REASON,
  templateLaunchControl,
  newTemplateId,
  validateDraft,
  type AgentDraft,
  type DraftErrors,
  type LaunchDraft,
} from '../view/launch.js';
import { selfReportEnabled } from '../view/self-report.js';
import { ControlButton } from './ControlButton.js';

type Send = (cmd: HuddleCommand) => Promise<CommandResult>;

export function FieldError({ id, error }: { id: string; error: string | undefined }) {
  if (!error) return null;
  return (
    <p className="inline-error field-error" id={`${id}-error`} role="alert">
      {error}
    </p>
  );
}

export function Field({
  id,
  label,
  error,
  note,
  children,
}: {
  id: string;
  label: string;
  error?: string | undefined;
  note?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={`form-field${error ? ' has-error' : ''}`}>
      <label className="form-label" htmlFor={id}>
        {label}
      </label>
      {children}
      {note && <p className="form-note">{note}</p>}
      <FieldError id={id} error={error} />
    </div>
  );
}

/** Props for an input that may carry an error. */
function invalid(id: string, error: string | undefined) {
  return error ? { 'aria-invalid': true as const, 'aria-describedby': `${id}-error` } : {};
}

export interface TemplateFieldsProps {
  draft: LaunchDraft;
  errors: DraftErrors;
  onChange: (next: LaunchDraft) => void;
  query: QueryFn | null;
  /** The template editor: name, description and agents. The launch dialog shows a short agents line instead. */
  editor: boolean;
  /** A note from the last save, shown under the first prompt (M5: the prompt looks like it holds a secret). */
  promptWarning?: string | null;
  /** The global Self-reported progress setting is off (F27): the checkbox says it has no effect now. */
  selfReportOff?: boolean;
}

/** Under a prompt that shows the mark where Huddle hid a secret (M5, F17): the masked part is marked, in words. */
function maskNote(text: string) {
  return showsMask(text) ? <span className="form-warning mask-note">{SECRET_WORDS.masked}</span> : undefined;
}

export function TemplateFields({
  draft,
  errors,
  onChange,
  query,
  editor,
  promptWarning = null,
  selfReportOff = false,
}: TemplateFieldsProps) {
  const base = useId();
  const id = (f: string) => `${base}-${f}`;
  const [pickError, setPickError] = useState<string | null>(null);
  const set = <K extends keyof LaunchDraft>(key: K, value: LaunchDraft[K]) => {
    onChange({ ...draft, [key]: value });
  };
  const mode = modeOption(draft.permissionMode);
  const choose = () => {
    setPickError(null);
    void pickFolder(query, draft.cwd.trim() || undefined).then((r) => {
      if (!r.ok) setPickError(r.message);
      else if (r.path !== null) set('cwd', r.path);
    });
  };

  return (
    <div className="form">
      {editor && (
        <>
          <Field id={id('name')} label="Name" error={errors['name']}>
            <input
              id={id('name')}
              className="text-input"
              value={draft.name}
              maxLength={NAME_MAX}
              onChange={(e) => {
                set('name', e.target.value);
              }}
              {...invalid(id('name'), errors['name'])}
            />
          </Field>
          <Field id={id('description')} label="Description (optional)">
            <input
              id={id('description')}
              className="text-input"
              value={draft.description}
              maxLength={2000}
              onChange={(e) => {
                set('description', e.target.value);
              }}
            />
          </Field>
        </>
      )}

      <Field
        id={id('cwd')}
        label="Folder"
        error={errors['cwd'] ?? pickError ?? undefined}
        note={LAUNCH_WORDS.hooksNote}
      >
        <span className="field-with-button">
          <input
            id={id('cwd')}
            className="text-input code"
            value={draft.cwd}
            spellCheck={false}
            placeholder="C:\projects\example"
            onChange={(e) => {
              set('cwd', e.target.value);
            }}
            {...invalid(id('cwd'), errors['cwd'] ?? pickError ?? undefined)}
          />
          <ControlButton
            control={query === null ? { enabled: false, reason: QUERY_UNAVAILABLE } : { enabled: true, reason: null }}
            hint="Pick the folder in Windows"
            onPress={choose}
          >
            Choose…
          </ControlButton>
        </span>
      </Field>

      <Field id={id('prompt')} label="First prompt" error={errors['prompt']} note={maskNote(draft.prompt)}>
        <textarea
          id={id('prompt')}
          className={`text-input form-prompt${showsMask(draft.prompt) ? ' has-mask' : ''}`}
          rows={5}
          value={draft.prompt}
          maxLength={PROMPT_MAX}
          onChange={(e) => {
            set('prompt', e.target.value);
          }}
          {...invalid(id('prompt'), errors['prompt'])}
        />
        {promptWarning !== null && (
          <p className="form-warning prompt-warning" role="status">
            {promptWarning}
          </p>
        )}
      </Field>

      <div className="form-pair">
        <Field
          id={id('mainAgent')}
          label="Main agent (optional)"
          error={errors['mainAgent']}
          note="Runs the whole session as this agent; empty uses Claude Code's own."
        >
          <input
            id={id('mainAgent')}
            className="text-input code"
            value={draft.mainAgent}
            spellCheck={false}
            onChange={(e) => {
              set('mainAgent', e.target.value);
            }}
            {...invalid(id('mainAgent'), errors['mainAgent'])}
          />
        </Field>
        <Field id={id('model')} label="Model (optional)" error={errors['model']} note="Empty uses your default model.">
          <input
            id={id('model')}
            className="text-input code"
            value={draft.model}
            spellCheck={false}
            placeholder="sonnet"
            onChange={(e) => {
              set('model', e.target.value);
            }}
            {...invalid(id('model'), errors['model'])}
          />
        </Field>
      </div>

      <Field
        id={id('mode')}
        label="Permission mode"
        error={errors['permissionMode']}
        note={
          <>
            {mode?.hint}
            {mode?.bypassesHuddle && <span className="form-warning"> {LAUNCH_WORDS.modeBypasses}</span>}
          </>
        }
      >
        <select
          id={id('mode')}
          className="text-input select-input"
          value={draft.permissionMode}
          onChange={(e) => {
            set('permissionMode', e.target.value);
          }}
        >
          {PERMISSION_MODE_OPTIONS.map((o) => (
            <option key={o.mode} value={o.mode}>
              {o.label}
            </option>
          ))}
        </select>
      </Field>

      <div className="form-field">
        <span className="switch-row">
          <input
            id={id('worktree')}
            type="checkbox"
            role="switch"
            className="switch"
            checked={draft.worktree}
            onChange={(e) => {
              set('worktree', e.target.checked);
            }}
          />
          <label htmlFor={id('worktree')}>Run in its own git worktree</label>
        </span>
        <p className="form-note">{LAUNCH_WORDS.worktreeNote}</p>
      </div>

      <div className="form-field">
        <span className="switch-row">
          <input
            id={id('selfReport')}
            type="checkbox"
            className="checkbox"
            checked={draft.selfReport}
            aria-describedby={id('selfReport-note')}
            onChange={(e) => {
              set('selfReport', e.target.checked);
            }}
          />
          <label htmlFor={id('selfReport')}>{LAUNCH_WORDS.selfReportLabel}</label>
        </span>
        <p className="form-note" id={id('selfReport-note')}>
          {LAUNCH_WORDS.selfReportNote}
          {selfReportOff && <> {LAUNCH_WORDS.selfReportGlobalOff}</>}
        </p>
      </div>

      <fieldset className="form-group">
        <legend className="form-label">Budget for the session (optional)</legend>
        <div className="form-trio">
          <Field id={id('tokens')} label="Tokens" error={errors['maxTokens']}>
            <input
              id={id('tokens')}
              className="text-input number-input"
              inputMode="numeric"
              value={draft.maxTokens}
              placeholder="—"
              onChange={(e) => {
                set('maxTokens', e.target.value);
              }}
              {...invalid(id('tokens'), errors['maxTokens'])}
            />
          </Field>
          <Field id={id('cost')} label="Cost, $ est." error={errors['maxCostUsd']}>
            <input
              id={id('cost')}
              className="text-input number-input"
              inputMode="decimal"
              value={draft.maxCostUsd}
              placeholder="—"
              onChange={(e) => {
                set('maxCostUsd', e.target.value);
              }}
              {...invalid(id('cost'), errors['maxCostUsd'])}
            />
          </Field>
          <Field id={id('minutes')} label="Minutes" error={errors['maxMinutes']}>
            <input
              id={id('minutes')}
              className="text-input number-input"
              inputMode="numeric"
              value={draft.maxMinutes}
              placeholder="—"
              onChange={(e) => {
                set('maxMinutes', e.target.value);
              }}
              {...invalid(id('minutes'), errors['maxMinutes'])}
            />
          </Field>
          <Field id={id('exceed')} label="At the cap">
            <select
              id={id('exceed')}
              className="text-input select-input"
              value={draft.onExceed}
              onChange={(e) => {
                const v = e.target.value;
                if (v === 'notify' || v === 'pause' || v === 'stop') set('onExceed', v);
              }}
            >
              <option value="notify">tell me</option>
              <option value="pause">pause the run</option>
              <option value="stop">stop the run</option>
            </select>
          </Field>
        </div>
        <p className="form-note">Cache reads do not count. {LAUNCH_WORDS.budgetNote}</p>
      </fieldset>

      {editor ? (
        <AgentsEditor
          agents={draft.agents}
          errors={errors}
          onChange={(agents) => {
            set('agents', agents);
          }}
        />
      ) : (
        draft.agents.length > 0 && (
          <p className="form-note">
            Agents from the template: <span className="code">{draft.agents.map((a) => a.name).join(', ')}</span>
          </p>
        )
      )}
    </div>
  );
}

function agentIds(
  agents: AgentDraft[],
  before: { agents: AgentDraft[]; ids: number[] },
  nextId: { current: number },
): number[] {
  const sameLength = agents.length === before.agents.length;
  return agents.map((a, i) => {
    const same = before.agents.indexOf(a);
    if (same >= 0) return before.ids[same] ?? nextId.current++;
    if (sameLength) return before.ids[i] ?? nextId.current++;
    return nextId.current++;
  });
}

export function AgentsEditor({
  agents,
  errors,
  onChange,
}: {
  agents: AgentDraft[];
  errors: DraftErrors;
  onChange: (agents: AgentDraft[]) => void;
}) {
  const base = useId();
  const full = agents.length >= MAX_TEMPLATE_AGENTS;
  // One stable id per draft, so removing a middle draft does not hand its DOM node, focus or element ids to the next
  // one. Worked out in render from the previous list: a draft that is the same object keeps its id; an edited one
  // (a new object at the same position, same length) keeps the id of that position; anything else is new. A counter,
  // not Math.random.
  const nextId = useRef(0);
  const prev = useRef<{ agents: AgentDraft[]; ids: number[] }>({ agents: [], ids: [] });
  const ids = prev.current.agents === agents ? prev.current.ids : agentIds(agents, prev.current, nextId);
  prev.current = { agents, ids };
  const update = (i: number, patch: Partial<AgentDraft>) => {
    onChange(agents.map((a, j) => (j === i ? { ...a, ...patch } : a)));
  };
  return (
    <fieldset className="form-group agents-editor">
      <legend className="form-label">Agents for this run (optional)</legend>
      <p className="form-note">
        Passed to Claude Code with --agents for this run only; nothing is written to the folder.
      </p>
      {agents.map((a, i) => {
        const uid = ids[i] ?? i;
        const id = (f: string) => `${base}-${String(uid)}-${f}`;
        const err = (f: string) => errors[`agents.${String(i)}.${f}`];
        return (
          <div key={uid} className="agent-draft" role="group" aria-label={`Agent ${String(i + 1)}`}>
            <div className="form-pair">
              <Field id={id('name')} label="Name" error={err('name')}>
                <input
                  id={id('name')}
                  className="text-input code"
                  value={a.name}
                  spellCheck={false}
                  onChange={(e) => {
                    update(i, { name: e.target.value });
                  }}
                  {...invalid(id('name'), err('name'))}
                />
              </Field>
              <Field id={id('model')} label="Model (optional)" error={err('model')}>
                <input
                  id={id('model')}
                  className="text-input code"
                  value={a.model}
                  spellCheck={false}
                  placeholder="inherit"
                  onChange={(e) => {
                    update(i, { model: e.target.value });
                  }}
                  {...invalid(id('model'), err('model'))}
                />
              </Field>
            </div>
            <Field id={id('description')} label="When to use it" error={err('description')}>
              <input
                id={id('description')}
                className="text-input"
                value={a.description}
                onChange={(e) => {
                  update(i, { description: e.target.value });
                }}
                {...invalid(id('description'), err('description'))}
              />
            </Field>
            <Field id={id('prompt')} label="Instructions" error={err('prompt')} note={maskNote(a.prompt)}>
              <textarea
                id={id('prompt')}
                className={`text-input${showsMask(a.prompt) ? ' has-mask' : ''}`}
                rows={3}
                value={a.prompt}
                maxLength={PROMPT_MAX}
                onChange={(e) => {
                  update(i, { prompt: e.target.value });
                }}
                {...invalid(id('prompt'), err('prompt'))}
              />
            </Field>
            <Field
              id={id('tools')}
              label="Tools (optional, comma separated)"
              error={err('tools')}
              note="Empty: every tool."
            >
              <input
                id={id('tools')}
                className="text-input code"
                value={a.tools}
                spellCheck={false}
                placeholder="Read, Grep, Glob"
                onChange={(e) => {
                  update(i, { tools: e.target.value });
                }}
                {...invalid(id('tools'), err('tools'))}
              />
            </Field>
            <ControlButton
              control={{ enabled: true, reason: null }}
              variant="quiet"
              onPress={() => {
                onChange(agents.filter((_, j) => j !== i));
              }}
            >
              Remove agent
            </ControlButton>
          </div>
        );
      })}
      <FieldError id={`${base}-agents`} error={errors['agents']} />
      <ControlButton
        control={
          full
            ? { enabled: false, reason: `A template can define up to ${String(MAX_TEMPLATE_AGENTS)} agents.` }
            : { enabled: true, reason: null }
        }
        onPress={() => {
          onChange([...agents, { ...EMPTY_AGENT }]);
        }}
      >
        Add agent
      </ControlButton>
    </fieldset>
  );
}

export interface LaunchPanelProps {
  state: HuddleState;
  onCommand: Send;
  query: QueryFn | null;
  onClose: () => void;
  /** Start with these fields (a template, or tests). */
  initialDraft?: LaunchDraft;
  /** Show the checks at once (tests). */
  initialChecked?: boolean;
  /** Start from this stored template, as if picked in the list (tests). */
  initialTemplateId?: string;
}

export function LaunchPanel({
  state,
  onCommand,
  query,
  onClose,
  initialDraft,
  initialChecked = false,
  initialTemplateId,
}: LaunchPanelProps) {
  const startFrom = state.templates?.find((t) => t.id === initialTemplateId) ?? null;
  const [draft, setDraft] = useState<LaunchDraft>(
    initialDraft ?? (startFrom ? draftFromTemplate(startFrom) : EMPTY_DRAFT),
  );
  /** The stored template the fields came from, if any (launch sends its id when only the prompt changed). */
  const [baseId, setBaseId] = useState<string | null>(startFrom?.id ?? null);
  const [checked, setChecked] = useState(initialChecked);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const errors = checked ? validateDraft(draft, false) : {};
  const templates = state.templates ?? [];
  const picked = baseId === null ? null : (templates.find((t) => t.id === baseId) ?? null);
  // A template with rules of its own cannot be launched in this build (the core refuses it): Launch is off, with why.
  const control = templateLaunchControl(picked, selectLaunchControl(state.connection));
  const pickId = useId();

  const launch = () => {
    setChecked(true);
    setSent(null);
    setError(null);
    if (Object.keys(validateDraft(draft, false)).length > 0) return;
    setBusy(true);
    // Read the template again by id: it may have been edited or removed since it was picked.
    const base = baseId === null ? null : (templates.find((t) => t.id === baseId) ?? null);
    void onCommand(launchCommandFor(draft, base, newTemplateId('inline'))).then((r) => {
      setBusy(false);
      if (r.ok) setSent('Launch sent. The run shows up in the team when Claude Code starts.');
      else {
        const o = saveOutcome(r, draft);
        setError(o.kind === 'error' ? o.error : r.message);
      }
    });
  };

  return (
    <article className="detail manage" aria-label="Launch a run">
      <header className="detail-head">
        <div className="name-block">
          <h1 className="agent-name">Launch a run</h1>
          <button type="button" className="quiet-button" onClick={onClose}>
            Back to Home
          </button>
        </div>
        <p className="muted">
          Starts claude in the folder with your existing login. The prompt is sent over its input.
        </p>
      </header>
      <div className="panel">
        {templates.length > 0 && (
          <div className="form-field">
            <label className="form-label" htmlFor={pickId}>
              Start from a template
            </label>
            <select
              id={pickId}
              className="text-input select-input"
              value={baseId ?? ''}
              onChange={(e) => {
                const t = templates.find((x) => x.id === e.target.value);
                setBaseId(t ? t.id : null);
                if (t) setDraft(draftFromTemplate(t));
              }}
            >
              <option value="">none</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
        )}
        {hasOwnRules(picked) && <p className="form-warning">{TEMPLATE_RULES_REASON}</p>}
        <TemplateFields
          draft={draft}
          errors={errors}
          onChange={setDraft}
          query={query}
          editor={false}
          selfReportOff={!selfReportEnabled(state)}
        />
        <div className="form-actions">
          <ControlButton control={control} variant="primary" busy={busy} onPress={launch} hint="Start the run">
            Launch
          </ControlButton>
          {checked && Object.keys(errors).length > 0 && (
            <span className="inline-error" role="status">
              Fix the fields marked above.
            </span>
          )}
        </div>
        {sent && (
          <p className="form-sent" role="status">
            {sent}
          </p>
        )}
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </article>
  );
}
