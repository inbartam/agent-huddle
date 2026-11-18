/**
 * Report (M5, F23): the Report tab of a past run (DESIGN.md "Report (F23)"). Summary, Agents, Files changed, Failures
 * and Approvals, drawn from the structured `RunReport` the core built from the stored events, never from the Markdown
 * file. Every string from the run (names, titles, results, errors, summaries, paths, tool and rule names) is a text
 * node; `**`, `#` and `<img>` show as typed.
 *
 * Read-only toward agents. The only commands are the report's own: "Make the report" / "Write it again"
 * (`report.make`), "Open Markdown file" (`report.openFile`) and "Copy path" (`report.copyPath`), all by session id; the
 * renderer never sends a path. "Show in replay" switches to the Replay tab at that row's event.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AgentKey, CommandResult, ReportFileInfo, RunHead, RunReport } from '@huddle/shared';
import type { QueryFn } from '../query.js';
import { loadReport, sendReportCommand, type CommandFn, type ReportLoad } from '../report-query.js';
import { duration, UNKNOWN } from '../view/format.js';
import {
  activityLine,
  agentLines,
  agentNames,
  agentsWords,
  agentTokens,
  approvalEnding,
  canRetryReport,
  costWords,
  endedWords,
  errorHead,
  eventTime,
  failureKindWords,
  fileDetail,
  FILES_SHOWN,
  helperLine,
  makeFailure,
  replayIndexes,
  REPORT_WORDS,
  reportFailure,
  reportOutcome,
  resultHead,
  resultIsLong,
  shownPath,
  tasksCell,
  tasksDoneWords,
  tokensLine,
  toolsCell,
  toolsUsedLine,
  worktreeCutWords,
  worktreeLine,
  type AgentLine,
  type Shown,
} from '../view/report.js';
import { shortModel } from '../view/format.js';
import { OutcomeBadge } from './History.js';
import { useDelayed } from './ui-util.js';
import { useViewMode } from '../viewMode.js';
import { ControlButton } from './ControlButton.js';
import { MessageText } from './MessageText.js';

const LOADING_DELAY_MS = 300;
const COPIED_MS = 2000;
const ON = { enabled: true, reason: null } as const;

/** Text that may be a lower bound: the reason goes in the tooltip and the accessible name. */
function ShownText({ shown, className }: { shown: Shown; className?: string }) {
  return (
    <span className={className} title={shown.label ?? undefined} aria-label={shown.label ?? undefined}>
      {shown.text}
    </span>
  );
}

/** What tests (and nothing else) hand in instead of asking the core. */
export interface ReportInitial {
  load?: ReportLoad;
  /** Agent rows shown expanded. */
  expanded?: AgentKey[];
  allFiles?: boolean;
  /** A file action's result already on screen. */
  note?: FileNote;
}

type FileNote = { kind: 'copied' } | { kind: 'gone' } | { kind: 'error'; text: string };

export interface ReportProps {
  query: QueryFn | null;
  onCommand: CommandFn | null;
  head: RunHead;
  /** Switch to the Replay tab at this event; null opens it at the last event ("Replay so far"). */
  onShowInReplay: (index: number | null) => void;
  initial?: ReportInitial;
}

export function Report({ query, onCommand, head, onShowInReplay, initial }: ReportProps) {
  const sessionId = head.row.sessionId;
  const [load, setLoad] = useState<ReportLoad | null>(initial?.load ?? null);
  const [reload, setReload] = useState(0);
  const [making, setMaking] = useState(false);
  const [makeError, setMakeError] = useState<string | null>(null);
  const skipFirst = useRef(initial?.load !== undefined);
  const showLoading = useDelayed(load === null, LOADING_DELAY_MS);

  useEffect(() => {
    if (skipFirst.current) {
      skipFirst.current = false;
      return;
    }
    let live = true;
    void loadReport(query, sessionId).then((a) => {
      if (live) setLoad(a);
    });
    return () => {
      live = false;
    };
  }, [query, sessionId, reload]);

  /** "Make the report" / "Write it again": build and write it, then ask for it again. */
  const make = useCallback(() => {
    if (making) return;
    setMaking(true);
    setMakeError(null);
    void sendReportCommand(onCommand, 'make', sessionId).then((r) => {
      setMaking(false);
      if (r.ok) setReload((n) => n + 1);
      else setMakeError(makeFailure(r.message));
    });
  }, [making, onCommand, sessionId]);

  const makeLine = (
    <>
      {making && (
        <p className="muted" role="status">
          {REPORT_WORDS.writing}
        </p>
      )}
      {makeError !== null && (
        <div className="hist-message">
          <p className="inline-error" role="alert">
            {makeError}
          </p>
          <button type="button" className="quiet-button" onClick={make}>
            {REPORT_WORDS.tryAgain}
          </button>
        </div>
      )}
    </>
  );

  if (load === null) {
    return <div className="report">{showLoading && <p className="muted">{REPORT_WORDS.loading}</p>}</div>;
  }
  if (!load.ok) {
    return (
      <div className="report hist-message">
        <p className={canRetryReport(load) ? 'inline-error' : 'empty-line'} role="alert">
          {reportFailure(load)}
        </p>
        {canRetryReport(load) && (
          <button
            type="button"
            className="quiet-button"
            onClick={() => {
              setLoad(null);
              setReload((n) => n + 1);
            }}
          >
            {REPORT_WORDS.tryAgain}
          </button>
        )}
      </div>
    );
  }
  const answer = load.answer;
  if (answer.status === 'not_ready') {
    return (
      <div className="report hist-message">
        <p className="empty-line">{REPORT_WORDS.notReady}</p>
        <button
          type="button"
          className="quiet-button"
          onClick={() => {
            onShowInReplay(null);
          }}
        >
          {REPORT_WORDS.replaySoFar}
        </button>
      </div>
    );
  }
  if (answer.status === 'none') {
    return (
      <div className="report">
        <div className="hist-message">
          <p className="empty-line">{REPORT_WORDS.none}</p>
          <ControlButton control={ON} variant="quiet" className="control-dense" busy={making} onPress={make}>
            {REPORT_WORDS.make}
          </ControlButton>
        </div>
        {makeLine}
      </div>
    );
  }
  return (
    <ReportBody
      report={answer.report}
      file={answer.file}
      head={head}
      onCommand={onCommand}
      onShowInReplay={onShowInReplay}
      onMake={make}
      making={making}
      makeLine={makeLine}
      initial={initial}
    />
  );
}

// ---------------------------------------------------------------------------
// The report itself
// ---------------------------------------------------------------------------

function ReportBody({
  report,
  file,
  head,
  onCommand,
  onShowInReplay,
  onMake,
  making,
  makeLine,
  initial,
}: {
  report: RunReport;
  file: ReportFileInfo | null;
  head: RunHead;
  onCommand: CommandFn | null;
  onShowInReplay: (index: number | null) => void;
  onMake: () => void;
  making: boolean;
  makeLine: ReactNode;
  initial?: ReportInitial;
}) {
  const names = useMemo(() => agentNames(report), [report]);
  const nameOf = (key: AgentKey) => names.get(key) ?? UNKNOWN;
  const failureAt = useMemo(() => replayIndexes(report.failures, 'failure', head.markers), [report, head.markers]);
  const approvalAt = useMemo(() => replayIndexes(report.approvals, 'approval', head.markers), [report, head.markers]);
  const s = report.summary;
  const tokens = tokensLine(s.tokens, s.tokensPartial);
  const cost = costWords(s.estimatedCostUsd, s.costPartial);
  const helper = helperLine(s.helperTokens);

  const replayButton = (index: number | null) => (
    <ControlButton
      variant="quiet"
      className="control-dense"
      control={{ enabled: index !== null, reason: index === null ? REPORT_WORDS.noReplayIndex : null }}
      onPress={() => {
        if (index !== null) onShowInReplay(index);
      }}
    >
      {REPORT_WORDS.showInReplay}
    </ControlButton>
  );

  return (
    <div className="report">
      <FileBar
        sessionId={report.sessionId}
        file={file}
        onCommand={onCommand}
        onMake={onMake}
        making={making}
        initialNote={initial?.note}
      />
      {makeLine}

      <ReportSection title={REPORT_WORDS.summary}>
        <p className="rep-line rep-summary-head">
          <OutcomeBadge outcome={reportOutcome(s.outcome)} />
          <span className="sep" aria-hidden="true">
            ·
          </span>
          <span>{duration(s.durationMs)}</span>
          <span className="sep" aria-hidden="true">
            ·
          </span>
          <span className="rep-text">{endedWords(s.endReason)}</span>
          <span className="sep" aria-hidden="true">
            ·
          </span>
          <span>{agentsWords(s.agents)}</span>
          <span className="sep" aria-hidden="true">
            ·
          </span>
          <span>{tasksDoneWords(s.tasksCompleted)}</span>
        </p>
        {s.outcome === 'unknown' && <p className="rep-line muted">{REPORT_WORDS.noEnd}</p>}
        <p className="rep-line">{activityLine(s)}</p>
        <dl className="rep-facts">
          <dt>Tokens</dt>
          <dd>
            <ShownText shown={tokens} />
          </dd>
          {helper !== null && (
            <>
              <dt className="visually-hidden">Helper requests</dt>
              <dd className="rep-helper muted">{helper}</dd>
            </>
          )}
          <dt>Cost</dt>
          <dd>
            <ShownText shown={cost} />
          </dd>
        </dl>
      </ReportSection>

      <ReportSection title={REPORT_WORDS.agents} count={report.agents.length}>
        <AgentsTable report={report} initialExpanded={initial?.expanded} />
      </ReportSection>

      <ReportSection title={REPORT_WORDS.filesChanged} count={report.filesChanged.length}>
        <FilesList report={report} names={names} initialAll={initial?.allFiles ?? false} />
      </ReportSection>

      <ReportSection title={REPORT_WORDS.failures} count={report.failures.length}>
        {report.failures.length === 0 ? (
          <p className="empty-line">{REPORT_WORDS.noFailures}</p>
        ) : (
          <ul className="rep-list">
            {report.failures.map((f, i) => {
              const err = errorHead(f.error);
              return (
                <li key={`${String(f.ts)}-${String(i)}`} className="rep-item">
                  <span className="rep-time">{eventTime(f.ts, report.summary.startedAt)}</span>
                  <span className="rep-agent">{nameOf(f.agentKey)}</span>
                  <span className="rep-kind">{failureKindWords(f.kind)}</span>
                  {f.toolName !== null && <span className="rep-tool">{f.toolName}</span>}
                  <span className="rep-error">
                    {err.more && f.error !== null ? (
                      <details>
                        <summary>{err.first}</summary>
                        <span className="rep-error-full">{f.error}</span>
                      </details>
                    ) : (
                      err.first
                    )}
                    {f.interrupted && <span className="muted"> · {REPORT_WORDS.interrupted}</span>}
                  </span>
                  {replayButton(failureAt[i] ?? null)}
                </li>
              );
            })}
          </ul>
        )}
      </ReportSection>

      <ReportSection title={REPORT_WORDS.approvals} count={report.approvals.length}>
        {report.approvals.length === 0 ? (
          <p className="empty-line">{REPORT_WORDS.noApprovals}</p>
        ) : (
          <ul className="rep-list">
            {report.approvals.map((a, i) => (
              <li key={`${a.requestId}-${String(i)}`} className="rep-item">
                <span className="rep-time">{eventTime(a.ts, report.summary.startedAt)}</span>
                <span className="rep-agent">{nameOf(a.agentKey)}</span>
                <span className="rep-tool">{a.toolName}</span>
                <span className="code rep-summary" title={a.summary}>
                  {a.summary}
                </span>
                <span className="rep-ending">{approvalEnding(a)}</span>
                {a.by === 'policy' && a.policyRuleId !== null && <span className="code muted">{a.policyRuleId}</span>}
                {replayButton(approvalAt[i] ?? null)}
              </li>
            ))}
          </ul>
        )}
      </ReportSection>
    </div>
  );
}

function ReportSection({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  const id = useId();
  return (
    <section className="rep-section" aria-labelledby={id}>
      <h2 className="section-title" id={id}>
        {title}
        {count !== undefined && <span className="section-note">({String(count)})</span>}
      </h2>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------
// The file bar: open, copy, write again
// ---------------------------------------------------------------------------

function FileBar({
  sessionId,
  file,
  onCommand,
  onMake,
  making,
  initialNote,
}: {
  sessionId: string;
  file: ReportFileInfo | null;
  onCommand: CommandFn | null;
  onMake: () => void;
  making: boolean;
  initialNote?: FileNote;
}) {
  const [note, setNote] = useState<FileNote | null>(initialNote ?? null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  const gone = file !== null && (!file.exists || note?.kind === 'gone');
  const offReason = file === null ? REPORT_WORDS.noFile : gone ? REPORT_WORDS.fileGone : null;

  const after = (r: CommandResult, okNote: FileNote | null) => {
    if (r.ok) {
      setNote(okNote);
      if (okNote?.kind === 'copied') {
        if (timer.current !== null) clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          setNote(null);
        }, COPIED_MS);
      }
    } else if (r.code === 'not_found') {
      setNote({ kind: 'gone' });
    } else {
      setNote({ kind: 'error', text: r.message });
    }
  };

  return (
    <div className="rep-filebar">
      <ControlButton
        variant="quiet"
        className="control-dense"
        control={{ enabled: offReason === null, reason: offReason }}
        onPress={() => {
          void sendReportCommand(onCommand, 'openFile', sessionId).then((r) => {
            after(r, null);
          });
        }}
      >
        {REPORT_WORDS.openFile}
      </ControlButton>
      <ControlButton
        variant="quiet"
        className="control-dense"
        control={{ enabled: offReason === null, reason: offReason }}
        onPress={() => {
          void sendReportCommand(onCommand, 'copyPath', sessionId).then((r) => {
            after(r, { kind: 'copied' });
          });
        }}
      >
        {REPORT_WORDS.copyPath}
      </ControlButton>
      {(gone || file === null) && (
        <ControlButton
          variant="quiet"
          className="control-dense"
          control={ON}
          busy={making}
          onPress={() => {
            setNote(null);
            onMake();
          }}
        >
          {file === null ? REPORT_WORDS.make : REPORT_WORDS.writeAgain}
        </ControlButton>
      )}
      {file !== null && (
        <span className="code muted rep-path" title={file.path}>
          {file.path}
        </span>
      )}
      <span className="rep-file-note" role="status">
        {note?.kind === 'copied'
          ? REPORT_WORDS.copied
          : gone
            ? REPORT_WORDS.fileGone
            : file === null
              ? REPORT_WORDS.noFile
              : ''}
      </span>
      {note?.kind === 'error' && (
        <span className="inline-error" role="alert">
          {note.text}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

function AgentsTable({ report, initialExpanded }: { report: RunReport; initialExpanded?: AgentKey[] }) {
  const lines = useMemo(() => agentLines(report.agents), [report.agents]);
  const [open, setOpen] = useState<ReadonlySet<AgentKey>>(new Set(initialExpanded ?? []));
  const toggle = (key: AgentKey) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  return (
    <div className="rep-table-wrap">
      <table className="rep-table rep-agents">
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col" className="rc-narrow-hide">
              Role
            </th>
            <th scope="col">Model</th>
            <th scope="col">Outcome</th>
            <th scope="col">Time</th>
            <th scope="col" className="num">
              Tasks
            </th>
            <th scope="col" className="num">
              Tools
            </th>
            <th scope="col" className="num rc-narrow-hide">
              Approvals
            </th>
            <th scope="col" className="num rc-narrow-hide">
              Stuck
            </th>
            <th scope="col" className="num">
              Tokens
            </th>
            <th scope="col" className="num">
              Cost
            </th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => (
            <AgentRows
              key={line.agent.row.agentKey}
              line={line}
              open={open.has(line.agent.row.agentKey)}
              onToggle={() => {
                toggle(line.agent.row.agentKey);
              }}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

const COLUMNS = 11;

function AgentRows({ line, open, onToggle }: { line: AgentLine; open: boolean; onToggle: () => void }) {
  // Simple names the model in words ("Opus 5.5"); only Advanced uses the code face (DESIGN, Simple and Advanced view).
  const { simple } = useViewMode();
  const a = line.agent;
  const r = a.row;
  const detailId = useId();
  const tools = toolsCell(r);
  const cost = costWords(r.estimatedCostUsd, r.costPartial);
  const [allResult, setAllResult] = useState(false);
  const long = a.result !== null && resultIsLong(a.result);
  return (
    <>
      <tr className={`rep-agent-row${open ? ' is-open' : ''}`} onClick={onToggle}>
        <th scope="row" className="rc-name">
          <button
            type="button"
            className="rep-expand"
            aria-expanded={open}
            aria-controls={detailId}
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
          >
            <span className="rep-elbow" aria-hidden="true">
              {line.prefix}
            </span>
            <span className="rep-name-text">{a.name}</span>
          </button>
        </th>
        <td className="rc-narrow-hide">{r.role}</td>
        <td className={simple ? undefined : 'code'} title={r.model ?? undefined}>
          {shortModel(r.model)}
        </td>
        <td>
          <OutcomeBadge outcome={reportOutcome(r.outcome)} />
        </td>
        <td>{duration(r.durationMs)}</td>
        <td className="num">{tasksCell(r)}</td>
        <td className="num" title={tools.label ?? undefined}>
          {tools.text}
        </td>
        <td className="num rc-narrow-hide">{String(r.approvals.requested)}</td>
        <td className="num rc-narrow-hide">{String(r.stuckIncidents)}</td>
        <td className="num">{agentTokens(r)}</td>
        <td className="num">
          <ShownText shown={cost} />
        </td>
      </tr>
      {open && (
        <tr className="rep-agent-detail" id={detailId}>
          <td colSpan={COLUMNS}>
            <dl className="rep-facts">
              <dt className="rc-narrow-only">Role</dt>
              <dd className="rc-narrow-only">{r.role}</dd>
              <dt className="rc-narrow-only">Approvals</dt>
              <dd className="rc-narrow-only">{String(r.approvals.requested)}</dd>
              <dt className="rc-narrow-only">Stuck</dt>
              <dd className="rc-narrow-only">{String(r.stuckIncidents)}</dd>
              <dt>{REPORT_WORDS.titleFromParent}</dt>
              <dd className="rep-text">{a.title ?? UNKNOWN}</dd>
              <dt>{REPORT_WORDS.result}</dt>
              <dd>
                {a.result === null ? (
                  UNKNOWN
                ) : (
                  <>
                    <div className="rep-result">
                      <MessageText text={long && !allResult ? resultHead(a.result) : a.result} />
                    </div>
                    {long && (
                      <button
                        type="button"
                        className="quiet-button"
                        aria-expanded={allResult}
                        onClick={() => {
                          setAllResult((v) => !v);
                        }}
                      >
                        {allResult ? REPORT_WORDS.showLess : REPORT_WORDS.showAll}
                      </button>
                    )}
                  </>
                )}
              </dd>
              <dt>{REPORT_WORDS.toolsUsed}</dt>
              <dd className="rep-text">{toolsUsedLine(a)}</dd>
            </dl>
          </td>
        </tr>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Files changed
// ---------------------------------------------------------------------------

function FilesList({
  report,
  names,
  initialAll,
}: {
  report: RunReport;
  names: ReadonlyMap<AgentKey, string>;
  initialAll: boolean;
}) {
  const [all, setAll] = useState(initialAll);
  const files = report.filesChanged;
  const cwd = report.summary.cwd;
  const shown = all ? files : files.slice(0, FILES_SHOWN);
  const w = report.worktree;
  const cut = w ? worktreeCutWords(w) : null;
  if (files.length === 0 && w === null) return <p className="empty-line">{REPORT_WORDS.noFiles}</p>;
  return (
    <>
      {w !== null && <p className="rep-line rep-worktree">{worktreeLine(w)}</p>}
      {files.length === 0 ? (
        <p className="empty-line">{REPORT_WORDS.noFiles}</p>
      ) : (
        <ul className="rep-list rep-files">
          {shown.map((f, i) => (
            <li key={`${f.source}:${f.path}:${String(i)}`} className="rep-file">
              <span className="code rep-file-path" title={f.path}>
                {shownPath(f, cwd)}
              </span>
              <span className="muted rep-file-detail">{fileDetail(f, names)}</span>
            </li>
          ))}
        </ul>
      )}
      {files.length > FILES_SHOWN && (
        <p className="rep-line muted">
          {`Showing ${String(shown.length)} of ${String(files.length)}`}{' '}
          <button
            type="button"
            className="quiet-button"
            aria-expanded={all}
            onClick={() => {
              setAll((v) => !v);
            }}
          >
            {all ? REPORT_WORDS.showLess : REPORT_WORDS.showAll}
          </button>
        </p>
      )}
      {cut !== null && <p className="rep-line muted">{cut}</p>}
    </>
  );
}
