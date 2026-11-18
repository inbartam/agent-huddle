/**
 * Settings, M5 (F22, F25): the History section (keep history for n days, the stats line, "Delete all history…") and
 * the Ask the Huddle switch. Words and steps are in view/remember-settings.ts; the stats and the retention preview are
 * read with `huddle:query` (settings-query.ts). Both confirmations are inline groups, never `window.confirm`.
 *
 * The folder path in the delete-all text and every core message are rendered as text.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { CommandResult, HistoryStats, HuddleCommand } from '@huddle/shared';
import type { QueryFn } from '../query.js';
import { loadRetentionPreview, loadStats } from '../settings-query.js';
import {
  ASK_SETTINGS_WORDS,
  askEnabledCommand,
  commitRetention,
  deleteAllControl,
  HISTORY_SETTINGS_WORDS as W,
  RETENTION_FIELD,
  retentionPreviewWords,
  retentionStep,
  runDeleteAll,
  saveRetention,
  statsLine,
  type DeleteAllOutcome,
  type RetentionPhase,
} from '../view/remember-settings.js';
import { ControlButton } from './ControlButton.js';

type Send = (cmd: HuddleCommand) => Promise<CommandResult>;

const ON = { enabled: true, reason: null };

/** Starting state, for tests (renderToStaticMarkup runs no effects) and to keep a panel's state across a re-mount. */
export interface HistorySettingsInitial {
  /** Undefined: ask the core on mount. Null: unknown. */
  stats?: HistoryStats | null;
  statsError?: string | null;
  draft?: string | null;
  retention?: RetentionPhase;
  deleteOpen?: boolean;
  typed?: string;
  deleting?: boolean;
  outcome?: DeleteAllOutcome | null;
}

export interface HistorySettingsProps {
  retentionDays: number;
  onCommand: Send;
  query: QueryFn | null;
  now: number;
  initial?: HistorySettingsInitial;
}

export function HistorySettings({ retentionDays, onCommand, query, now, initial = {} }: HistorySettingsProps) {
  const [stats, setStats] = useState<HistoryStats | null>(initial.stats ?? null);
  const [statsError, setStatsError] = useState<string | null>(initial.statsError ?? null);
  const [reload, setReload] = useState(initial.stats === undefined ? 1 : 0);

  useEffect(() => {
    if (reload === 0) return;
    let live = true;
    void loadStats(query).then((r) => {
      if (!live) return;
      if (r.ok) {
        setStats(r.stats);
        setStatsError(null);
      } else setStatsError(r.message);
    });
    return () => {
      live = false;
    };
  }, [query, reload]);

  const refresh = () => {
    setReload((n) => n + 1);
  };

  return (
    <>
      <RetentionField
        value={retentionDays}
        onCommand={onCommand}
        query={query}
        onDeleted={refresh}
        initialDraft={initial.draft ?? null}
        initialPhase={initial.retention ?? { phase: 'idle' }}
      />
      <p className="setting-help">{W.help}</p>
      <p className="setting-help history-stats" aria-label="What is stored">
        {statsLine(stats, now)}
      </p>
      {stats?.migrating === true && (
        <p className="setting-help" role="status">
          {W.migrating}
        </p>
      )}
      {statsError !== null && <p className="setting-help">{statsError}</p>}
      <DeleteAll
        stats={stats}
        onCommand={onCommand}
        onDone={refresh}
        initialOpen={initial.deleteOpen ?? false}
        initialTyped={initial.typed ?? ''}
        initialDeleting={initial.deleting ?? false}
        initialOutcome={initial.outcome ?? null}
      />
    </>
  );
}

function RetentionField({
  value,
  onCommand,
  query,
  onDeleted,
  initialDraft,
  initialPhase,
}: {
  value: number;
  onCommand: Send;
  query: QueryFn | null;
  onDeleted: () => void;
  initialDraft: string | null;
  initialPhase: RetentionPhase;
}) {
  const [draft, setDraft] = useState<string | null>(initialDraft);
  const [phase, setPhase] = useState<RetentionPhase>(initialPhase);
  // The confirmation stays up (busy) while "Delete them" is sent; a raise saves with no confirmation.
  const [confirmed, setConfirmed] = useState<number | null>(initialPhase.phase === 'saving' ? initialPhase.days : null);
  const input = useRef<HTMLInputElement>(null);
  const id = `setting-${RETENTION_FIELD.key}`;
  const error = phase.phase === 'error' ? phase.error : null;
  const asking = phase.phase === 'counting' || phase.phase === 'confirm' || phase.phase === 'saving';
  const preview = (days: number) => loadRetentionPreview(query, days);

  const settle = (p: RetentionPhase) => {
    setPhase(p);
    if (p.phase !== 'saving') setConfirmed(null);
    if (p.phase === 'saved' || p.phase === 'idle') setDraft(null);
    if (p.phase === 'saved' && p.words !== null) onDeleted();
  };

  const commit = () => {
    if (draft === null) return;
    // The confirmation is open for this value already (a blur on the way to "Delete them" or "Back").
    const step = retentionStep(value, draft);
    if (asking && step.kind === 'confirm' && step.days === phase.days) return;
    void commitRetention({ send: onCommand, preview }, value, draft, settle);
  };

  const back = () => {
    setDraft(null);
    setConfirmed(null);
    setPhase({ phase: 'idle' });
    input.current?.focus();
  };

  const onGroupKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      back();
    }
  };

  const shown = draft ?? String(phase.phase === 'saved' ? phase.days : value);

  return (
    <>
      <div className="setting-row">
        <label htmlFor={id} className="setting-label">
          {RETENTION_FIELD.label}
        </label>
        <span className="setting-value">
          <input
            ref={input}
            id={id}
            className="text-input number-input"
            type="number"
            inputMode="numeric"
            min={RETENTION_FIELD.min}
            max={RETENTION_FIELD.max}
            step={1}
            value={shown}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${id}-error` : undefined}
            aria-busy={phase.phase === 'counting' ? true : undefined}
            onChange={(e) => {
              setDraft(e.target.value);
              if (phase.phase === 'error' || phase.phase === 'saved') setPhase({ phase: 'idle' });
            }}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commit();
              } else if (e.key === 'Escape') back();
            }}
          />
          <span className="setting-unit">{RETENTION_FIELD.unit}</span>
        </span>
      </div>
      {(phase.phase === 'confirm' || (phase.phase === 'saving' && confirmed === phase.days)) && (
        <div
          className="manage-actions settings-confirm"
          role="group"
          aria-label="Confirm keeping less history"
          onKeyDown={onGroupKey}
        >
          <span className="confirm-words">
            {retentionPreviewWords(phase.days, phase.phase === 'confirm' ? phase.runs : null)}
          </span>
          <ControlButton
            control={ON}
            className="control-danger"
            busy={phase.phase === 'saving'}
            onPress={() => {
              setConfirmed(phase.days);
              // L4: the count the user just read goes with it; the core refuses if it no longer matches.
              void saveRetention(onCommand, phase.days, settle, phase.phase === 'confirm' ? phase.runs : null);
            }}
          >
            {W.deleteThem}
          </ControlButton>
          <ControlButton control={ON} variant="quiet" onPress={back}>
            {W.back}
          </ControlButton>
        </div>
      )}
      {phase.phase === 'saved' && phase.words !== null && (
        <p className="form-sent" role="status">
          {phase.words}
        </p>
      )}
      {error && (
        <p className="inline-error" id={`${id}-error`} role="alert">
          {error}
        </p>
      )}
    </>
  );
}

function DeleteAll({
  stats,
  onCommand,
  onDone,
  initialOpen,
  initialTyped,
  initialDeleting,
  initialOutcome,
}: {
  stats: HistoryStats | null;
  onCommand: Send;
  onDone: () => void;
  initialOpen: boolean;
  initialTyped: string;
  initialDeleting: boolean;
  initialOutcome: DeleteAllOutcome | null;
}) {
  const [open, setOpen] = useState(initialOpen);
  const [typed, setTyped] = useState(initialTyped);
  const [deleting, setDeleting] = useState(initialDeleting);
  const [outcome, setOutcome] = useState<DeleteAllOutcome | null>(initialOutcome);
  const opener = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const base = useId();
  const control = deleteAllControl(typed, stats?.migrating ?? false);

  useEffect(() => {
    if (open) field.current?.focus();
  }, [open]);

  const close = () => {
    setOpen(false);
    setTyped('');
    opener.current?.focus();
  };

  const press = () => {
    if (!control.enabled || deleting) return;
    setDeleting(true);
    setOutcome(null);
    void runDeleteAll(onCommand, typed).then((o) => {
      setDeleting(false);
      setOutcome(o);
      if (o.ok) {
        setOpen(false);
        setTyped('');
        opener.current?.focus();
      }
      onDone();
    });
  };

  return (
    <div className="delete-all">
      <button
        ref={opener}
        type="button"
        className="control control-plain control-danger"
        aria-expanded={open}
        aria-controls={`${base}-group`}
        onClick={() => {
          setOutcome(null);
          setOpen(true);
        }}
      >
        {W.deleteAllOpen}
      </button>
      {open && (
        <div
          id={`${base}-group`}
          className="delete-all-group"
          role="group"
          aria-labelledby={`${base}-title`}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              close();
            }
          }}
        >
          <p className="delete-all-text">
            <strong id={`${base}-title`}>{W.deleteAllTitle}</strong> {W.deletesLead}
            {stats === null ? (
              W.deletesFolderMaybe
            ) : stats.legacyFolder !== null ? (
              <>
                {W.deletesFolder} (<span className="code">{stats.legacyFolder}</span>).
              </>
            ) : (
              '.'
            )}
          </p>
          <p className="delete-all-text">{W.keeps}</p>
          <div className="setting-row delete-all-confirm">
            <label htmlFor={`${base}-typed`} className="setting-label">
              {W.typeLabel}
            </label>
            <span className="setting-value">
              <input
                ref={field}
                id={`${base}-typed`}
                className="text-input code delete-all-input"
                value={typed}
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => {
                  setTyped(e.target.value);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    press();
                  }
                }}
              />
              <ControlButton control={control} className="control-danger" busy={deleting} onPress={press}>
                {deleting ? W.deleting : W.deleteAllButton}
              </ControlButton>
              <ControlButton control={ON} variant="quiet" onPress={close}>
                {W.back}
              </ControlButton>
            </span>
          </div>
          {!control.enabled && !deleting && <p className="setting-help">{control.reason}</p>}
        </div>
      )}
      {outcome?.ok === true && (
        <p className="form-sent" role="status">
          {outcome.lines.map((line, i) => (
            <span key={i} className="delete-all-line">
              {line}
            </span>
          ))}
        </p>
      )}
      {outcome?.ok === false && (
        <p className="inline-error" role="alert">
          {outcome.error}
        </p>
      )}
    </div>
  );
}

/** The Ask the Huddle switch (`ask.setEnabled`), with DESIGN's help text about what leaves the computer. */
export function AskSettings({ enabled, onCommand }: { enabled: boolean; onCommand: Send }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <ul className="switches">
        <li className="switch-row">
          <input
            id="ask-enabled"
            type="checkbox"
            role="switch"
            className="switch"
            checked={enabled}
            aria-describedby="ask-enabled-help"
            onChange={(e) => {
              setError(null);
              void onCommand(askEnabledCommand(e.target.checked)).then((r) => {
                if (!r.ok) setError(r.message);
              });
            }}
          />
          <label htmlFor="ask-enabled">{ASK_SETTINGS_WORDS.label}</label>
        </li>
      </ul>
      <p id="ask-enabled-help" className="setting-help">
        {ASK_SETTINGS_WORDS.helpBefore}
        <span className="code">{ASK_SETTINGS_WORDS.helpCode}</span>
        {ASK_SETTINGS_WORDS.helpAfter}
      </p>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
