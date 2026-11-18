/**
 * Budget meters (M4, F19), shared by the agent detail and the widget's session card. Used / cap per limit, with the
 * scope and what happens at the cap. Every figure is an estimate (telemetry lands 1–3 s late, so a run can overshoot
 * by about one tool call) and says so; a limit with nothing measured shows `—`, never 0. Level is glyph + words, not
 * colour alone.
 *
 * After the M4 runbook: each budget in the detail can be edited after launch ("Edit budget": tokens, cost, minutes,
 * warn percent, what happens at the cap, checked inline, sent as `budget.set`), and a budget that still holds agents
 * paused offers "Resume all" for exactly those agents (`selectBudgetPaused`: the agents whose Huddle pause names this
 * budget's over item). Raising a cap closes the over item (the detector checks the new setting afresh) but does not
 * resume anyone: that stays the user's press.
 */
import { useId, useState } from 'react';
import {
  budgetKeyOf,
  budgetOverItemId,
  selectBudgetPaused,
  selectBudgets,
  type AgentNode,
  type BudgetView,
  type CommandResult,
  type HuddleCommand,
  type HuddleState,
} from '@huddle/shared';
import {
  BUDGET_EDIT_WORDS,
  BUDGET_NOTE,
  budgetDraftOf,
  budgetLine,
  budgetSetCommand,
  EXCEED_WORDS,
  LEVEL_LOOK,
  LIMIT_LABEL,
  limitWords,
  NEW_BUDGET_DRAFT,
  pausedByWords,
  resumeAllCommands,
  SCOPE_WORDS,
  stillOverWith,
  validateBudgetDraft,
  type BudgetDraft,
} from '../view/runs.js';
import { ControlButton } from './ControlButton.js';
import { Bar, Section } from './Meters.js';

type Send = (cmd: HuddleCommand) => Promise<CommandResult>;

function scopeTitle(view: BudgetView): string {
  const scope = SCOPE_WORDS[view.scope];
  return `Budget for ${scope}, ${EXCEED_WORDS[view.budget.onExceed]}`;
}

/** The agents a budget still holds paused. */
export function pausedByBudget(state: HuddleState, view: Pick<BudgetView, 'scope' | 'targetKey'>): AgentNode[] {
  return selectBudgetPaused(state, budgetOverItemId(budgetKeyOf(view)));
}

/**
 * "Resume all": one `agent.resume` per agent, in order. Used by the budget meter, the budget inbox item and the
 * root's pause line. Stops at the first refusal and shows it.
 */
export function ResumeAllButton({
  agents,
  onCommand,
  hint,
  label = 'Resume all',
}: {
  agents: readonly AgentNode[];
  onCommand: Send;
  hint: string;
  label?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const press = () => {
    setBusy(true);
    setError(null);
    void (async () => {
      for (const cmd of resumeAllCommands(agents.map((a) => a.key))) {
        const r = await onCommand(cmd);
        if (!r.ok && r.code !== 'expired') {
          setError(r.message);
          break;
        }
      }
      setBusy(false);
    })();
  };
  return (
    <>
      <ControlButton
        control={agents.length > 0 ? { enabled: true, reason: null } : { enabled: false, reason: 'Nothing is paused.' }}
        onPress={press}
        hint={hint}
        busy={busy}
        className="resume-all"
      >
        {label}
      </ControlButton>
      {error && (
        <span className="inline-error" role="alert">
          {error}
        </span>
      )}
    </>
  );
}

function namesOf(agents: readonly AgentNode[]): string {
  return agents.map((a) => a.name).join(', ');
}

export function BudgetMeter({
  view,
  state,
  onCommand,
  initialEditing = false,
  initialDraft,
}: {
  view: BudgetView;
  /** With `onCommand`: offers Edit budget and Resume all. Without (the widget): the meter only. */
  state?: HuddleState;
  onCommand?: Send;
  /** Start with the editor open (tests). */
  initialEditing?: boolean;
  /** The editor's starting draft (tests); default: the budget as set. */
  initialDraft?: BudgetDraft;
}) {
  const level = LEVEL_LOOK[view.level];
  const [editing, setEditing] = useState(initialEditing && onCommand !== undefined);
  const paused = state ? pausedByBudget(state, view) : [];
  return (
    <div className={`budget level-${view.level}`} data-scope={view.scope}>
      <p className="meter-line budget-head">
        <span>{scopeTitle(view)}</span>
        {(view.level === 'warning' || view.level === 'over') && (
          <span className={`budget-level tone-${level.tone}`}>
            <span aria-hidden="true">{level.glyph}</span> {level.label}
          </span>
        )}
      </p>
      {view.limits.map((l) => {
        const look = LEVEL_LOOK[l.level];
        return (
          <div key={l.kind} className="meter-row budget-row">
            <span className="budget-kind">{LIMIT_LABEL[l.kind]}</span>
            {l.fraction !== null ? (
              <Bar
                fraction={l.fraction}
                label={`${LIMIT_LABEL[l.kind]} budget used, estimated ${String(Math.round(l.fraction * 100))}%`}
                tone={look.tone}
              />
            ) : (
              <span className="bar-none muted">not measured yet</span>
            )}
            <span
              className={`meter-value budget-value${l.level === 'over' || l.level === 'warning' ? ` tone-${look.tone}` : ''}`}
            >
              {limitWords(l)}
            </span>
          </div>
        );
      })}
      {onCommand && paused.length > 0 && (
        <div className="budget-paused">
          <p className="form-note tone-paused">
            {pausedByWords(paused.length)} <span className="muted">({namesOf(paused)})</span>
          </p>
          <ResumeAllButton
            agents={paused}
            onCommand={onCommand}
            hint={`Resume ${String(paused.length)} agent${paused.length === 1 ? '' : 's'} this budget paused`}
          />
        </div>
      )}
      {onCommand &&
        (editing ? (
          <BudgetEditor
            view={view}
            onCommand={onCommand}
            initialDraft={initialDraft}
            onDone={() => {
              setEditing(false);
            }}
          />
        ) : (
          <div className="run-actions">
            <ControlButton
              control={{ enabled: true, reason: null }}
              variant="quiet"
              hint="Raise or change this budget's caps, warning line or what happens at the cap"
              onPress={() => {
                setEditing(true);
              }}
            >
              Edit budget
            </ControlButton>
          </div>
        ))}
    </div>
  );
}

function invalid(id: string, error: string | undefined) {
  return error ? { 'aria-invalid': true as const, 'aria-describedby': `${id}-error` } : {};
}

function FieldErr({ id, error }: { id: string; error: string | undefined }) {
  if (!error) return null;
  return (
    <p className="inline-error field-error" id={`${id}-error`} role="alert">
      {error}
    </p>
  );
}

/**
 * The inline budget editor. `view` null: a new session budget for `targetKey` (a launched run without one). Checks
 * show under their fields as the user types; Save is off, with the reason, until the draft is sendable.
 */
export function BudgetEditor({
  view,
  scope = view?.scope ?? 'session',
  targetKey = view?.targetKey ?? null,
  onCommand,
  onDone,
  initialDraft,
}: {
  view: BudgetView | null;
  scope?: BudgetView['scope'];
  targetKey?: string | null;
  onCommand: Send;
  onDone: () => void;
  initialDraft?: BudgetDraft | undefined;
}) {
  const base = useId();
  const id = (field: string) => `${base}-${field}`;
  const [draft, setDraft] = useState<BudgetDraft>(
    initialDraft ?? (view ? budgetDraftOf(view.budget) : NEW_BUDGET_DRAFT),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errors = validateBudgetDraft(draft);
  const cmd = budgetSetCommand(scope, targetKey, draft);
  const firstError = Object.values(errors)[0];
  const save =
    cmd === null ? { enabled: false, reason: firstError ?? 'Check the fields.' } : { enabled: true, reason: null };
  const over = view ? stillOverWith(view, draft) : [];
  const set = <K extends keyof BudgetDraft>(key: K, value: BudgetDraft[K]) => {
    setDraft({ ...draft, [key]: value });
  };

  return (
    <fieldset className="form-group budget-editor">
      <legend className="form-label">Edit the budget for {SCOPE_WORDS[scope]}</legend>
      <div className="form-trio">
        <div className={`form-field${errors['maxTokens'] ? ' has-error' : ''}`}>
          <label className="form-label" htmlFor={id('tokens')}>
            Tokens
          </label>
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
          <FieldErr id={id('tokens')} error={errors['maxTokens']} />
        </div>
        <div className={`form-field${errors['maxCostUsd'] ? ' has-error' : ''}`}>
          <label className="form-label" htmlFor={id('cost')}>
            Cost, $ est.
          </label>
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
          <FieldErr id={id('cost')} error={errors['maxCostUsd']} />
        </div>
        <div className={`form-field${errors['maxMinutes'] ? ' has-error' : ''}`}>
          <label className="form-label" htmlFor={id('minutes')}>
            Minutes
          </label>
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
          <FieldErr id={id('minutes')} error={errors['maxMinutes']} />
        </div>
        <div className={`form-field${errors['warnPercent'] ? ' has-error' : ''}`}>
          <label className="form-label" htmlFor={id('warn')}>
            Warn at, %
          </label>
          <input
            id={id('warn')}
            className="text-input number-input"
            inputMode="numeric"
            value={draft.warnPercent}
            onChange={(e) => {
              set('warnPercent', e.target.value);
            }}
            {...invalid(id('warn'), errors['warnPercent'])}
          />
          <FieldErr id={id('warn')} error={errors['warnPercent']} />
        </div>
        <div className="form-field">
          <label className="form-label" htmlFor={id('exceed')}>
            At the cap
          </label>
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
        </div>
      </div>
      {errors['limits'] && (
        <p className="inline-error" role="alert">
          {errors['limits']}
        </p>
      )}
      {over.length > 0 && (
        <p className="form-note form-warning">
          {over.map((k) => LIMIT_LABEL[k]).join(', ')}: {BUDGET_EDIT_WORDS.stillOver}
        </p>
      )}
      <p className="form-note">
        Cache reads do not count. {BUDGET_NOTE}. Saving sets the budget again: its items close and the new caps are
        checked from now. {BUDGET_EDIT_WORDS.raised}
      </p>
      <div className="run-actions">
        <ControlButton
          control={save}
          variant="primary"
          busy={busy}
          hint="Set this budget now"
          onPress={() => {
            if (cmd === null) return;
            setBusy(true);
            setError(null);
            void onCommand(cmd).then((r) => {
              setBusy(false);
              if (r.ok) onDone();
              else setError(r.message);
            });
          }}
        >
          Save budget
        </ControlButton>
        <ControlButton control={{ enabled: true, reason: null }} variant="quiet" onPress={onDone}>
          Back
        </ControlButton>
      </div>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
    </fieldset>
  );
}

/**
 * The detail's Budget section: every budget that bears on this agent, each with Edit budget and (when it still holds
 * agents paused) Resume all. A launched run's main agent without a session budget gets "Set a budget". Nothing
 * otherwise when none is set.
 */
export function BudgetSection({
  state,
  agent,
  now,
  onCommand,
  initialEditing = false,
}: {
  state: HuddleState;
  agent: AgentNode;
  now: number;
  onCommand?: Send;
  /** Start with every editor open (tests). */
  initialEditing?: boolean;
}) {
  const views = selectBudgets(state, now, agent.key);
  const [adding, setAdding] = useState(initialEditing);
  const offerNew =
    onCommand !== undefined &&
    agent.parentKey === null &&
    agent.run !== undefined &&
    agent.run !== null &&
    !views.some((v) => v.scope === 'session');
  if (views.length === 0 && !offerNew) return null;
  return (
    <Section title="Budget" note={BUDGET_NOTE}>
      {views.map((v) => (
        <BudgetMeter
          key={`${v.scope}:${v.targetKey ?? ''}`}
          view={v}
          state={state}
          onCommand={onCommand}
          initialEditing={initialEditing}
        />
      ))}
      {offerNew &&
        (adding ? (
          <BudgetEditor
            view={null}
            scope="session"
            targetKey={agent.key}
            onCommand={onCommand}
            onDone={() => {
              setAdding(false);
            }}
          />
        ) : (
          <div className="run-actions">
            <ControlButton
              control={{ enabled: true, reason: null }}
              variant="quiet"
              hint="Set a token, cost or time limit for this run"
              onPress={() => {
                setAdding(true);
              }}
            >
              Set a budget
            </ControlButton>
          </div>
        ))}
    </Section>
  );
}

/**
 * The budgets a session card speaks for: the session's own and any agent budget inside it. The overall budget is left
 * out (it would repeat on every card); it shows in the agent detail.
 */
function sessionBudgets(state: HuddleState, rootKey: string, now: number): BudgetView[] {
  const root = Object.hasOwn(state.agents, rootKey) ? state.agents[rootKey] : undefined;
  if (root === undefined) return [];
  return selectBudgets(state, now).filter((v) => {
    if (v.targetKey === null) return false;
    if (v.scope === 'session') return v.targetKey === rootKey;
    const target = Object.hasOwn(state.agents, v.targetKey) ? state.agents[v.targetKey] : undefined;
    return target?.sessionId === root.sessionId;
  });
}

/**
 * The widget's one budget line for a session, only at warning or over: the worst of its budgets, e.g.
 * "▲ budget 86% est.". The
 * tooltip has the scope, used / cap and the estimate note.
 */
export function BudgetChip({ state, rootKey, now }: { state: HuddleState; rootKey: string; now: number }) {
  const views = sessionBudgets(state, rootKey, now);
  if (views.length === 0) return null;
  const rank = { unknown: 0, ok: 1, warning: 2, over: 3 } as const;
  const worst = views.reduce((a, b) => (rank[b.level] > rank[a.level] ? b : a));
  // Owner decision (M4): the widget shows a budget only when it needs a look, at warning or over. Below that, and while
  // nothing is measured, the card stays quiet; the agent detail always has the full meters.
  if (worst.level !== 'warning' && worst.level !== 'over') return null;
  const line = budgetLine(worst);
  if (line === null) return null;
  const look = LEVEL_LOOK[line.level];
  const title = `${scopeTitle(worst)}: ${worst.limits.map(limitWords).join(', ')} (${BUDGET_NOTE})`;
  return (
    <span className={`scard-budget level-${line.level} tone-${look.tone}`} title={title}>
      <span aria-hidden="true">{look.glyph}</span> {line.text} est.
    </span>
  );
}
