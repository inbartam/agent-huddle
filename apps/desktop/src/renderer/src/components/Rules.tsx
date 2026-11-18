/**
 * Approval rules (M4, F18): the list from `HuddleState.policy` with an on/off switch, the action, what the rule
 * matches and a mark on the ones Huddle ships with; the editor with a "What would this have matched?" preview (the
 * read-only `policy.preview` query, approximate); and the decision log of what rules decided on their own.
 *
 * Preview samples and log rows carry agent text (summaries of commands and paths): rendered as text, never markup.
 */
import { Fragment, useEffect, useRef, useState } from 'react';
import {
  isDefaultRule,
  type AgentKey,
  type CommandResult,
  type HuddleCommand,
  type HuddleState,
  type PolicyDecision,
  type PolicyPreview,
  type PolicyRule,
} from '@huddle/shared';
import { previewRule, QUERY_UNAVAILABLE, type QueryFn } from '../query.js';
import { agentLabel } from '../store.js';
import { clockTime, clockTimeFull, UNKNOWN } from '../view/format.js';
import {
  ACTION_WORDS,
  allowsChangingCommands,
  allowsChangingTool,
  MATCH_FIELDS,
  OUTCOME_WORDS,
  RULE_WORDS,
  decisionRule,
  decisionRuleIds,
  draftFromRule,
  emptyRuleDraft,
  filterDecisions,
  matchParts,
  matchWords,
  previewWords,
  removeRuleCommand,
  ruleFromDraft,
  sortedRules,
  toggleRuleCommand,
  upsertRuleCommand,
  validateRule,
  type RuleDraft,
} from '../view/rules.js';
import { currentSettings } from '../view/settings.js';
import { newTemplateId } from '../view/launch.js';
import { ControlButton } from './ControlButton.js';
import { Field } from './LaunchForm.js';
import { Section } from './Meters.js';

type Send = (cmd: HuddleCommand) => Promise<CommandResult>;

const ON = { enabled: true, reason: null };
function agentName(state: HuddleState, key: AgentKey, renames: ReadonlyMap<AgentKey, string>): string {
  const a = Object.hasOwn(state.agents, key) ? state.agents[key] : undefined;
  return a ? agentLabel(state, a, renames) : UNKNOWN;
}

export function ActionBadge({ action }: { action: PolicyRule['action'] }) {
  const w = ACTION_WORDS[action];
  // Shape and word, not colour alone: ✓ allow, ? ask me, ✕ deny.
  const glyph = action === 'allow' ? '✓' : action === 'deny' ? '✕' : '?';
  return (
    <span className={`action-badge action-${action}`} title={w.hint}>
      <span aria-hidden="true">{glyph}</span> {w.label}
    </span>
  );
}

/** "Rules apply only to sessions the Huddle launched" while `policy.applyToAttached` is off. */
export function RulesScopeLine({ state }: { state: HuddleState }) {
  const all = currentSettings(state).policy.applyToAttached;
  return <p className="rules-scope">{all ? RULE_WORDS.appliesToAll : RULE_WORDS.onlyLaunched}</p>;
}

export interface PreviewPanelProps {
  state: HuddleState;
  renames: ReadonlyMap<AgentKey, string>;
  rule: PolicyRule | null;
  query: QueryFn | null;
  /** A preview already fetched (tests). */
  initialPreview?: PolicyPreview | null;
  /** Run the preview once on open, when it can run. */
  autoRun?: boolean;
}

export function PreviewPanel({
  state,
  renames,
  rule,
  query,
  initialPreview = null,
  autoRun = false,
}: PreviewPanelProps) {
  const [preview, setPreview] = useState<PolicyPreview | null>(initialPreview);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const control =
    query === null
      ? { enabled: false, reason: QUERY_UNAVAILABLE }
      : rule === null
        ? { enabled: false, reason: 'Fix the rule first.' }
        : ON;
  const run = () => {
    if (rule === null) return;
    setBusy(true);
    setError(null);
    void previewRule(query, rule).then((r) => {
      setBusy(false);
      if (r.ok) setPreview(r.preview);
      else {
        setPreview(null);
        setError(r.message);
      }
    });
  };
  // A rule filled in from a request shows what it would have matched at once (read-only; changes nothing).
  const autoRan = useRef(false);
  useEffect(() => {
    if (!autoRun || autoRan.current || !control.enabled) return;
    autoRan.current = true;
    run();
  });
  return (
    <div className="rule-preview" aria-live="polite">
      <ControlButton control={control} busy={busy} onPress={run} hint="Checks recent requests; changes nothing">
        What would this have matched?
      </ControlButton>
      {query === null && <p className="form-note">{QUERY_UNAVAILABLE}</p>}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {preview && (
        <div className="preview-result">
          <p className="meter-line">
            {previewWords(preview)} <span className="section-note">approximate</span>
          </p>
          <p className="form-note">{RULE_WORDS.previewApprox}</p>
          {preview.samples.length > 0 && (
            <ul className="decision-list" aria-label="Requests it would have matched">
              {preview.samples.map((s, i) => (
                <li key={`${String(i)}:${String(s.receivedAt)}`} className="decision-row">
                  <span className="decision-time" title={clockTimeFull(s.receivedAt)}>
                    {clockTime(s.receivedAt)}
                  </span>
                  <span className="decision-agent">{agentName(state, s.agentKey, renames)}</span>
                  <span className="decision-what">
                    <span className="code">{s.toolName}</span> <span className="code muted">{s.summary}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export interface RuleEditorProps {
  state: HuddleState;
  renames: ReadonlyMap<AgentKey, string>;
  rule: PolicyRule | null;
  onCommand: Send;
  query: QueryFn | null;
  onDone: () => void;
  initialDraft?: RuleDraft;
  initialPreview?: PolicyPreview | null;
  /** Run the preview once when the editor opens (a rule filled in from a request). */
  autoPreview?: boolean;
}

export function RuleEditor(props: RuleEditorProps) {
  const { rule, onCommand, onDone } = props;
  const [draft, setDraft] = useState<RuleDraft>(
    props.initialDraft ?? (rule ? draftFromRule(rule) : emptyRuleDraft(newTemplateId('rule'))),
  );
  const [error, setError] = useState<string | null>(null);
  const errors = validateRule(draft);
  const valid = Object.keys(errors).length === 0;
  const built = valid ? ruleFromDraft(draft) : null;
  // Preview needs a well-formed match, not a name (M4 runbook): only Save asks for the name, and says so inline.
  const nameMissing = errors['name'] !== undefined && draft.name.trim() === '';
  const previewable = Object.keys(errors).every((k) => k === 'name');
  const previewed = previewable ? ruleFromDraft(draft) : null;
  const saveReason = nameMissing ? RULE_WORDS.saveNeedsName : (errors['name'] ?? 'Fix the fields marked above.');
  const empty = MATCH_FIELDS.every((f) => draft.match[f.key].trim() === '');
  const idp = `rule-${draft.id}`;
  const save = () => {
    if (!valid || built === null) return;
    setError(null);
    void onCommand(upsertRuleCommand(built)).then((r) => {
      if (r.ok) onDone();
      else setError(r.message);
    });
  };
  return (
    <section className="rule-editor" aria-label={rule ? `Edit ${rule.name}` : 'New rule'}>
      <h2 className="section-title">{rule ? 'Edit rule' : 'New rule'}</h2>
      <p className="form-note rule-editor-note">{RULE_WORDS.editorNote}</p>
      <div className="form">
        <Field id={`${idp}-name`} label="Name" error={draft.name === '' ? undefined : errors['name']}>
          <input
            id={`${idp}-name`}
            className="text-input"
            value={draft.name}
            maxLength={200}
            onChange={(e) => {
              setDraft({ ...draft, name: e.target.value });
            }}
          />
        </Field>
        <div className="form-field">
          <span className="form-label" id={`${idp}-action`}>
            Action
          </span>
          <span className="segmented" role="radiogroup" aria-labelledby={`${idp}-action`}>
            {(['allow', 'ask', 'deny'] as const).map((a) => (
              <button
                key={a}
                type="button"
                role="radio"
                className="segment"
                aria-checked={draft.action === a}
                title={ACTION_WORDS[a].hint}
                onClick={() => {
                  setDraft({ ...draft, action: a });
                }}
              >
                {ACTION_WORDS[a].label}
              </button>
            ))}
          </span>
          <p className="form-note">{ACTION_WORDS[draft.action].hint}</p>
        </div>
        <fieldset className="form-group">
          <legend className="form-label">Matches when every filled field matches</legend>
          {MATCH_FIELDS.map((f) => (
            <Field key={f.key} id={`${idp}-${f.key}`} label={f.label} error={errors[f.key]}>
              <input
                id={`${idp}-${f.key}`}
                className={`text-input${f.code ? ' code' : ''}`}
                value={draft.match[f.key]}
                placeholder={f.placeholder}
                spellCheck={false}
                onChange={(e) => {
                  setDraft({ ...draft, match: { ...draft.match, [f.key]: e.target.value } });
                }}
              />
            </Field>
          ))}
          <span className="switch-row">
            <input
              id={`${idp}-exact`}
              type="checkbox"
              className="checkbox"
              checked={draft.commandExact}
              onChange={(e) => {
                setDraft({ ...draft, commandExact: e.target.checked });
              }}
            />
            <label htmlFor={`${idp}-exact`}>{RULE_WORDS.commandExact}</label>
          </span>
          {empty && (
            <p className={draft.action === 'allow' ? 'form-warning' : 'form-note'}>
              {draft.action === 'allow' ? RULE_WORDS.allowEverything : RULE_WORDS.emptyMatch}
            </p>
          )}
          {!empty && allowsChangingCommands(draft) && (
            <p className="form-warning" role="note">
              <span aria-hidden="true">▲</span> {RULE_WORDS.allowChangesFiles}
            </p>
          )}
          {!empty && allowsChangingTool(draft) && (
            <p className="form-warning" role="note">
              <span aria-hidden="true">▲</span> {RULE_WORDS.allowChangesTool}
            </p>
          )}
        </fieldset>
        <Field id={`${idp}-note`} label="Why this rule exists (optional)" error={errors['note']}>
          <input
            id={`${idp}-note`}
            className="text-input"
            value={draft.note}
            onChange={(e) => {
              setDraft({ ...draft, note: e.target.value });
            }}
          />
        </Field>
      </div>
      <PreviewPanel
        state={props.state}
        renames={props.renames}
        rule={previewed}
        query={props.query}
        initialPreview={props.initialPreview}
        autoRun={props.autoPreview === true}
      />
      <div className="form-actions">
        <ControlButton control={valid ? ON : { enabled: false, reason: saveReason }} variant="primary" onPress={save}>
          Save rule
        </ControlButton>
        <ControlButton control={ON} variant="quiet" onPress={onDone}>
          Cancel
        </ControlButton>
      </div>
      {!valid && <p className="form-note save-reason">{saveReason}</p>}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function RuleRow({ rule, onCommand, onEdit }: { rule: PolicyRule; onCommand: Send; onEdit: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const isDefault = isDefaultRule(rule);
  const send = (cmd: HuddleCommand) => {
    setError(null);
    void onCommand(cmd).then((r) => {
      if (!r.ok) setError(r.message);
    });
  };
  const sw = `rule-on-${rule.id}`;
  return (
    <li className={`manage-row rule-row${rule.enabled ? '' : ' is-off'}`}>
      <input
        id={sw}
        type="checkbox"
        role="switch"
        className="switch"
        checked={rule.enabled}
        aria-label={`${rule.name}: ${rule.enabled ? 'on' : 'off'}`}
        onChange={(e) => {
          send(toggleRuleCommand(rule, e.target.checked));
        }}
      />
      <div className="manage-row-main">
        <span className="manage-name">
          <label htmlFor={sw}>{rule.name}</label>
          <ActionBadge action={rule.action} />
          {isDefault && (
            <span className="default-mark" title={RULE_WORDS.defaultHint}>
              {RULE_WORDS.defaultMark}
            </span>
          )}
          {!rule.enabled && <span className="muted">off</span>}
        </span>
        <span className="manage-meta">
          {matchParts(rule).length === 0
            ? matchWords(rule)
            : matchParts(rule).map((m, i) => (
                <Fragment key={m.label}>
                  {i > 0 && ', '}
                  {m.label} <span className="code">{m.value}</span>
                </Fragment>
              ))}
        </span>
        {rule.note && <span className="manage-desc">{rule.note}</span>}
      </div>
      {confirm ? (
        <div className="manage-actions" role="group" aria-label={`Confirm deleting ${rule.name}`}>
          <span className="confirm-words">Delete this rule?</span>
          <ControlButton
            control={ON}
            className="control-danger"
            onPress={() => {
              setConfirm(false);
              send(removeRuleCommand(rule.id));
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
          <ControlButton control={ON} variant="quiet" onPress={onEdit}>
            Edit
          </ControlButton>
          {/* A shipped rule is turned off with its switch, never deleted: no Delete that could only ever be off. */}
          {!isDefault && (
            <ControlButton
              control={ON}
              variant="quiet"
              onPress={() => {
                setConfirm(true);
              }}
            >
              Delete…
            </ControlButton>
          )}
        </div>
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

export interface DecisionLogProps {
  state: HuddleState;
  renames: ReadonlyMap<AgentKey, string>;
  /** Null while loading. */
  decisions: readonly PolicyDecision[] | null;
  initialRule?: string | null;
}

export function DecisionLog({ state, renames, decisions, initialRule = null }: DecisionLogProps) {
  const [ruleId, setRuleId] = useState<string | null>(initialRule);
  const all = decisions ?? [];
  const shown = filterDecisions(all, ruleId);
  const options = decisionRuleIds(all);
  return (
    <Section title="Decision log" note="what rules decided without asking you">
      {options.length > 0 && (
        <div className="form-field form-inline">
          <label className="form-label" htmlFor="decision-filter">
            Rule
          </label>
          <select
            id="decision-filter"
            className="text-input select-input"
            value={ruleId ?? ''}
            onChange={(e) => {
              setRuleId(e.target.value === '' ? null : e.target.value);
            }}
          >
            <option value="">every rule</option>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      )}
      {decisions === null && <p className="muted">Reading the log…</p>}
      {decisions !== null && shown.length === 0 && <p className="empty-line">{RULE_WORDS.noDecisions}</p>}
      {shown.length > 0 && (
        <ul className="decision-list" aria-label="Automatic decisions">
          {shown.map((d) => (
            <li key={d.requestId} className="decision-row">
              <span className="decision-time" title={clockTimeFull(d.at)}>
                {clockTime(d.at)}
              </span>
              <span className={`decision-outcome outcome-${d.outcome}`}>
                <span aria-hidden="true">{d.outcome === 'allowed' ? '✓' : d.outcome === 'denied' ? '✕' : '○'}</span>{' '}
                {OUTCOME_WORDS[d.outcome]}
              </span>
              <span className="decision-what">
                <span className="code">{d.toolName ?? UNKNOWN}</span>{' '}
                <span className="code muted">{d.summary ?? ''}</span>
              </span>
              <span className="decision-agent">{agentName(state, d.agentKey, renames)}</span>
              <span className="decision-rule">by {decisionRule(d)}</span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

export interface RulesPanelProps {
  state: HuddleState;
  renames: ReadonlyMap<AgentKey, string>;
  onCommand: Send;
  query: QueryFn | null;
  decisions: readonly PolicyDecision[] | null;
  /** Open the editor at once: a rule id or 'new' (tests). */
  initialEditing?: string | null;
  /** A rule draft to open the editor with (a new rule; nothing is saved without Save). */
  prefill?: RuleDraft | null;
  /** The prefilled editor closed (Save or Cancel): the window drops the draft so it never opens again. */
  onPrefillDone?: () => void;
}

export function RulesPanel(props: RulesPanelProps) {
  const { state, onCommand } = props;
  // "Make a rule from this…" (session view): the editor opens on a new rule filled in from the request; nothing is saved
  // until its Save. Used once: after Save or Cancel a new rule starts empty again.
  const [prefill, setPrefill] = useState<RuleDraft | null>(props.prefill ?? null);
  const [editing, setEditing] = useState<string | null>(props.prefill ? 'new' : (props.initialEditing ?? null));
  const rules = sortedRules(state.policy ?? []);
  const current = editing === null || editing === 'new' ? null : (rules.find((r) => r.id === editing) ?? null);
  return (
    <article className="detail manage" aria-label="Rules">
      <header className="detail-head">
        <div className="name-block">
          <h1 className="visually-hidden">Rules</h1>
        </div>
        <RulesScopeLine state={state} />
        <p className="muted">
          {RULE_WORDS.huddleClosed} {RULE_WORDS.precedence}
        </p>
        {/* A2-02: the rules file was not used; the core keeps it as .bad-* before the next save. */}
        {(state.policyWarning ?? null) !== null && (
          <p className="form-warning" role="note">
            {state.policyWarning}
          </p>
        )}
      </header>
      <div className="panel">
        {editing !== null ? (
          <RuleEditor
            key={editing}
            state={state}
            renames={props.renames}
            rule={current}
            {...(editing === 'new' && prefill !== null ? { initialDraft: prefill, autoPreview: true } : {})}
            onCommand={onCommand}
            query={props.query}
            onDone={() => {
              setEditing(null);
              if (prefill !== null) props.onPrefillDone?.();
              setPrefill(null);
            }}
          />
        ) : (
          <>
            <div className="form-actions">
              <ControlButton
                control={ON}
                onPress={() => {
                  setEditing('new');
                }}
              >
                New rule
              </ControlButton>
            </div>
            {state.policy === undefined && <p className="muted">Huddle hasn't sent its rules.</p>}
            {state.policy !== undefined && rules.length === 0 && (
              <p className="empty-line">No rules: Claude Code asks you about every request, as without Huddle.</p>
            )}
            {rules.length > 0 && (
              <ul className="manage-list" aria-label="Rules">
                {rules.map((r) => (
                  <RuleRow
                    key={r.id}
                    rule={r}
                    onCommand={onCommand}
                    onEdit={() => {
                      setEditing(r.id);
                    }}
                  />
                ))}
              </ul>
            )}
          </>
        )}
        <DecisionLog state={state} renames={props.renames} decisions={props.decisions} />
      </div>
    </article>
  );
}
