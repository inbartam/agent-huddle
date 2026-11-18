/**
 * Scorecards (M5, F24): History's Scorecards tab (DESIGN.md "Scorecards (F24)"). A plain table grouped by role, one
 * row per model, and an inline "Compare models" block for two models of one role (the M5 exit criterion: the scorecard
 * shows a difference between two models on the same role).
 *
 * Values resting on fewer than MIN_PRIOR_SAMPLES finished runs are muted and the row says "few runs" in words.
 * "Used for estimates" says "yes" exactly when `priorUnitMsFor` would hand that row's median to the ETA. Read-only:
 * nothing here is a command. Role and model names come from the runs, so they are text nodes.
 */
import { useEffect, useId, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import type { Scorecard } from '@huddle/shared';
import type { QueryFn } from '../query.js';
import { loadScorecards, type ScorecardsLoad } from '../report-query.js';
import { count, UNKNOWN } from '../view/format.js';
import {
  compareRows,
  defaultPair,
  groupScorecards,
  isSmall,
  modelCountWords,
  perTaskTime,
  rateWords,
  sampleWords,
  SCORECARD_WORDS,
  scorecardsFailure,
  scorecardsIntro,
  smallSampleTitle,
  soleKnownModel,
  tokensPerTaskWords,
  usedWords,
  type RoleGroup,
  type ScoreRow,
} from '../view/scorecards.js';
import { useDelayed } from './ui-util.js';

const LOADING_DELAY_MS = 300;
const COLUMNS = 10;

/** What tests (and nothing else) hand in instead of asking the core. */
export interface ScorecardsInitial {
  load?: ScorecardsLoad;
  /** The role whose comparison is open, and the picked rows (indexes into its model rows). */
  comparing?: { role: string; a?: number; b?: number } | null;
}

export function Scorecards({
  query,
  now,
  initial,
}: {
  query: QueryFn | null;
  now: number;
  initial?: ScorecardsInitial;
}) {
  const [load, setLoad] = useState<ScorecardsLoad | null>(initial?.load ?? null);
  const [reload, setReload] = useState(0);
  const skipFirst = useRef(initial?.load !== undefined);
  const showLoading = useDelayed(load === null, LOADING_DELAY_MS);

  useEffect(() => {
    if (skipFirst.current) {
      skipFirst.current = false;
      return;
    }
    let live = true;
    void loadScorecards(query).then((a) => {
      if (live) setLoad(a);
    });
    return () => {
      live = false;
    };
  }, [query, reload]);

  if (load === null) {
    return (
      <div className="scorecards" aria-busy="true">
        {showLoading && <p className="muted">{SCORECARD_WORDS.loading}</p>}
      </div>
    );
  }
  if (!load.ok) {
    const retry = load.code === 'failed' || load.code === 'invalid';
    return (
      <div className="scorecards hist-message">
        <p className={retry ? 'inline-error' : 'empty-line'} role="alert">
          {scorecardsFailure(load)}
        </p>
        {retry && (
          <button
            type="button"
            className="quiet-button"
            onClick={() => {
              setLoad(null);
              setReload((n) => n + 1);
            }}
          >
            {SCORECARD_WORDS.tryAgain}
          </button>
        )}
      </div>
    );
  }
  return (
    <ScorecardTable
      cards={load.answer.scorecards}
      retentionDays={load.answer.retentionDays}
      now={now}
      initialComparing={initial?.comparing ?? null}
    />
  );
}

function ScorecardTable({
  cards,
  retentionDays,
  now,
  initialComparing,
}: {
  cards: readonly Scorecard[];
  retentionDays: number;
  now: number;
  initialComparing: ScorecardsInitial['comparing'];
}) {
  const groups = useMemo(() => groupScorecards(cards), [cards]);
  const [comparing, setComparing] = useState<string | null>(initialComparing?.role ?? null);
  const compareButtons = useRef(new Map<string, HTMLButtonElement>());

  const close = (role: string) => {
    setComparing(null);
    compareButtons.current.get(role)?.focus();
  };

  if (cards.length === 0) {
    return (
      <div className="scorecards">
        <p className="muted sc-intro">{scorecardsIntro(retentionDays)}</p>
        <p className="empty-line">{SCORECARD_WORDS.empty}</p>
      </div>
    );
  }

  return (
    <div className="scorecards">
      <p className="muted sc-intro">{scorecardsIntro(retentionDays)}</p>
      <div className="rep-table-wrap">
        <table className="rep-table sc-table">
          <thead>
            <tr>
              <th scope="col">{SCORECARD_WORDS.roleAndModel}</th>
              <th scope="col" className="num">
                {SCORECARD_WORDS.runs}
              </th>
              <th scope="col" className="num">
                {SCORECARD_WORDS.tasks}
              </th>
              <th scope="col">{SCORECARD_WORDS.timePerTask}</th>
              <th scope="col">{SCORECARD_WORDS.tokensPerTask}</th>
              <th scope="col" className="num">
                {SCORECARD_WORDS.failedRuns}
              </th>
              <th scope="col" className="num">
                {SCORECARD_WORDS.failedToolCalls}
              </th>
              <th scope="col" className="num">
                {SCORECARD_WORDS.approvals}
              </th>
              <th scope="col" className="num">
                {SCORECARD_WORDS.stuck}
              </th>
              <th scope="col">{SCORECARD_WORDS.usedForEstimates}</th>
            </tr>
          </thead>
          {groups.map((g) => (
            <RoleRows
              key={g.role}
              group={g}
              now={now}
              open={comparing === g.role}
              initialPair={initialComparing?.role === g.role ? initialComparing : null}
              buttonRef={(el) => {
                if (el) compareButtons.current.set(g.role, el);
                else compareButtons.current.delete(g.role);
              }}
              onOpen={() => {
                setComparing(g.role);
              }}
              onClose={() => {
                close(g.role);
              }}
            />
          ))}
        </table>
      </div>
    </div>
  );
}

function RoleRows({
  group,
  now,
  open,
  initialPair,
  buttonRef,
  onOpen,
  onClose,
}: {
  group: RoleGroup;
  now: number;
  open: boolean;
  initialPair: { a?: number; b?: number } | null;
  buttonRef: (el: HTMLButtonElement | null) => void;
  onOpen: () => void;
  onClose: () => void;
}) {
  const canCompare = group.rows.length >= 2;
  const headId = useId();
  return (
    <tbody aria-labelledby={headId}>
      <tr className="sc-role">
        <th scope="rowgroup" colSpan={COLUMNS - 1} id={headId}>
          <span className="sc-role-name">{group.role}</span>
          <span className="section-note">{modelCountWords(group.rows.length)}</span>
        </th>
        <td className="sc-role-action">
          {canCompare && (
            <button
              ref={buttonRef}
              type="button"
              className="quiet-button"
              aria-expanded={open}
              onClick={open ? onClose : onOpen}
            >
              {SCORECARD_WORDS.compare}
            </button>
          )}
        </td>
      </tr>
      {group.rows.map((row, i) => (
        <ModelRow key={`${row.card.model ?? '\u0000'}:${String(i)}`} row={row} />
      ))}
      {open && canCompare && (
        <tr className="sc-compare-row">
          <td colSpan={COLUMNS}>
            <CompareBlock group={group} now={now} initialPair={initialPair} onClose={onClose} />
          </td>
        </tr>
      )}
    </tbody>
  );
}

function SampledValue({ value, n }: { value: string; n: number }) {
  const small = isSmall(n);
  const title = smallSampleTitle(n);
  return (
    <span className={`sc-value${small ? ' is-small' : ''}`} title={title ?? undefined}>
      {value} <span className="sc-n">{sampleWords(n)}</span>
    </span>
  );
}

function ModelRow({ row }: { row: ScoreRow }) {
  const c = row.card;
  const muted = row.few ? ' is-small' : '';
  return (
    <tr className={`sc-model${row.few ? ' is-few' : ''}`}>
      <th scope="row" className="sc-model-name">
        <span className="code" title={c.model ?? undefined}>
          {row.model}
        </span>
        {row.few && <span className="sc-few">{SCORECARD_WORDS.fewRuns}</span>}
      </th>
      <td className="num">{count(c.runs)}</td>
      <td className="num">{count(c.tasksCompleted)}</td>
      <td>
        <SampledValue value={perTaskTime(c.medianTaskMs)} n={c.sampleSize} />
      </td>
      <td>
        <SampledValue value={tokensPerTaskWords(c.tokensPerTask)} n={c.tokenSampleSize} />
      </td>
      <td className={`num${muted}`}>{rateWords(c.failureRate)}</td>
      <td className={`num${muted}`}>{rateWords(c.toolFailureRate)}</td>
      <td className="num">{count(c.approvalsRequested)}</td>
      <td className="num">{count(c.stuckIncidents)}</td>
      <td title={row.used === 'needs_runs' ? (smallSampleTitle(c.sampleSize) ?? undefined) : undefined}>
        {usedWords(row.used)}
      </td>
    </tr>
  );
}

function CompareBlock({
  group,
  now,
  initialPair,
  onClose,
}: {
  group: RoleGroup;
  now: number;
  initialPair: { a?: number; b?: number } | null;
  onClose: () => void;
}) {
  // With fewer than two known models nothing unknown is picked for the user: the block says "too few" until they
  // choose by hand.
  const pair = defaultPair(group) ?? [soleKnownModel(group), null];
  const n = group.rows.length;
  const pick = (v: number | undefined, fallback: number | null) =>
    v !== undefined && Number.isInteger(v) && v >= 0 && v < n ? v : fallback;
  const [a, setA] = useState(() => pick(initialPair?.a, pair[0]));
  const [b, setB] = useState(() => pick(initialPair?.b, pair[1]));
  const idBase = useId();
  const first = useRef<HTMLSelectElement>(null);

  useEffect(() => {
    first.current?.focus();
  }, []);

  const rowA = a === null ? undefined : group.rows[a];
  const rowB = b === null ? undefined : group.rows[b];
  const rows = rowA && rowB ? compareRows(rowA.card, rowB.card, now) : [];

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };

  const options = (
    <>
      {(a === null || b === null) && (
        <option value="" disabled>
          {UNKNOWN}
        </option>
      )}
      {group.rows.map((r, i) => (
        <option key={i} value={String(i)}>
          {r.model}
        </option>
      ))}
    </>
  );
  const choose = (set: (v: number | null) => void) => (e: ChangeEvent<HTMLSelectElement>) => {
    set(e.target.value === '' ? null : Number(e.target.value));
  };

  return (
    // The block only listens for Esc bubbling up from its own selects and buttons.
    <div className="sc-compare" role="group" aria-label={`${SCORECARD_WORDS.compare}: ${group.role}`} onKeyDown={onKey}>
      <div className="sc-compare-picks">
        <label className="hist-filter" htmlFor={`${idBase}-a`}>
          <span>{SCORECARD_WORDS.modelA}</span>
        </label>
        <select
          ref={first}
          id={`${idBase}-a`}
          className="text-input select-input"
          value={a === null ? '' : String(a)}
          onChange={choose(setA)}
        >
          {options}
        </select>
        <label className="hist-filter" htmlFor={`${idBase}-b`}>
          <span>{SCORECARD_WORDS.modelB}</span>
        </label>
        <select
          id={`${idBase}-b`}
          className="text-input select-input"
          value={b === null ? '' : String(b)}
          onChange={choose(setB)}
        >
          {options}
        </select>
        <button type="button" className="quiet-button sc-close" onClick={onClose}>
          {SCORECARD_WORDS.close}
        </button>
      </div>
      {(!rowA || !rowB) && <p className="muted sc-too-few">{SCORECARD_WORDS.tooFew}</p>}
      {rowA && rowB && (
        <table className="rep-table sc-compare-table">
          <thead>
            <tr>
              <th scope="col">{SCORECARD_WORDS.metric}</th>
              <th scope="col">
                <span className="sc-compare-label">A</span> <span className="code">{rowA.model}</span>
              </th>
              <th scope="col">
                <span className="sc-compare-label">B</span> <span className="code">{rowB.model}</span>
              </th>
              <th scope="col">{SCORECARD_WORDS.difference}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.metric}>
                <th scope="row">{r.metric}</th>
                <td>{r.a}</td>
                <td>{r.b}</td>
                <td className={r.tooFew ? 'muted' : 'sc-diff'}>{r.diff ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="muted sc-caveat">{SCORECARD_WORDS.caveat}</p>
    </div>
  );
}
