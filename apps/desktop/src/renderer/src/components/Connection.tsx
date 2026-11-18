/**
 * Setup status (ADR-017): the first-run consent screen, the banner both windows show while Huddle is not
 * connected, and the widget's one-line version. Everything here is rendered as React text nodes: the diff,
 * the path and the warnings come from files on disk and are treated as untrusted text (docs/SECURITY.md).
 * The ingest token never reaches the renderer; the diff shows it as `<token>`.
 */
import { useEffect, useRef } from 'react';
import type { ConnectionPreview, ConnectionStatus } from '@huddle/shared';

export const CONSENT_TITLE = 'Connect Huddle to Claude Code';
export const CONSENT_WHAT =
  'Huddle adds hooks to your Claude Code settings so it can see your agents. It removes them when you quit.';
export const CONSENT_DETAIL =
  'Nothing is written until you choose Connect, and your other settings stay as they are. ' +
  'The telemetry settings stay after you quit; they are silent while Huddle is closed.';
export const WIDGET_NOT_CONNECTED = 'Not connected — open Huddle to connect';
export const NOT_CONNECTED = "Huddle isn't connected to Claude Code yet. Review the change it makes to your settings.";

/**
 * Shows `backticked` parts of a message (DESIGN.md writes commands that way) in the code face, as text
 * nodes. A message with unpaired backticks is shown as typed.
 */
export function InlineCodeText({ text }: { text: string }) {
  const parts = text.split('`');
  if (parts.length < 3 || parts.length % 2 === 0) return <>{text}</>;
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <code key={i} className="code">
            {part}
          </code>
        ) : (
          part
        ),
      )}
    </>
  );
}

export type DiffOp = '+' | '-' | ' ' | 'gap';
export interface DiffRow {
  op: DiffOp;
  text: string;
}

/** Split the core's unified-style diff ("+ x", "- x", "  x", "  ...") into rows. Plain strings only. */
export function diffRows(diffText: string): DiffRow[] {
  if (diffText === '') return [];
  return diffText.split(/\r?\n/).map((line): DiffRow => {
    if (line === '  ...') return { op: 'gap', text: '' };
    const head = line.charAt(0);
    const op: DiffOp = head === '+' || head === '-' ? head : ' ';
    return { op, text: line.slice(2) };
  });
}

function changeSummary(rows: readonly DiffRow[]): string {
  const added = rows.filter((r) => r.op === '+').length;
  const removed = rows.filter((r) => r.op === '-').length;
  const plural = (n: number) => (n === 1 ? 'line' : 'lines');
  if (added === 0 && removed === 0) return 'No lines change.';
  if (removed === 0) return `${String(added)} ${plural(added)} added`;
  if (added === 0) return `${String(removed)} ${plural(removed)} removed`;
  return `${String(added)} ${plural(added)} added, ${String(removed)} removed`;
}

const SIGN: Record<DiffOp, string> = { '+': '+', '-': '−', ' ': '', gap: '⋯' };
const OP_LABEL: Record<DiffOp, string> = { '+': 'added', '-': 'removed', ' ': '', gap: 'unchanged lines hidden' };

export function DiffView({ diffText, label = 'Change to settings.json' }: { diffText: string; label?: string }) {
  const rows = diffRows(diffText);
  return (
    <figure className="diff">
      <figcaption className="diff-summary">{changeSummary(rows)}</figcaption>
      <div className="diff-scroll" tabIndex={0} role="region" aria-label={label}>
        <pre className="diff-lines">
          {rows.map((row, i) => (
            <span
              key={i}
              className={`diff-row op-${row.op === ' ' ? 'same' : row.op === 'gap' ? 'gap' : row.op === '+' ? 'add' : 'del'}`}
            >
              <span className="diff-sign" aria-hidden="true">
                {SIGN[row.op]}
              </span>
              {OP_LABEL[row.op] && <span className="visually-hidden">{OP_LABEL[row.op]}: </span>}
              <span className="diff-text">{row.text}</span>
              {'\n'}
            </span>
          ))}
        </pre>
      </div>
    </figure>
  );
}

export interface ConsentScreenProps {
  preview: ConnectionPreview;
  /** Shown above the change, e.g. "Your Claude Code settings changed since this was shown…". */
  notice: string | null;
  /** The last Connect failed: what happened and what to do. */
  error: string | null;
  busy: boolean;
  onConnect: () => void;
  onLater: () => void;
}

export function ConsentScreen({ preview, notice, error, busy, onConnect, onLater }: ConsentScreenProps) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  return (
    <section className="consent" aria-labelledby="consent-title">
      <div className="consent-intro">
        <h1 id="consent-title" className="consent-title" tabIndex={-1} ref={heading}>
          {CONSENT_TITLE}
        </h1>
        <p className="consent-what">{CONSENT_WHAT}</p>
        <p className="consent-detail">{CONSENT_DETAIL}</p>
      </div>

      <dl className="consent-file">
        <dt>File</dt>
        <dd className="code" title={preview.settingsPath}>
          {preview.settingsPath}
        </dd>
      </dl>

      {notice && (
        <p className="consent-notice tone-needs-you" role="status">
          <span className="glyph tone-needs-you" aria-hidden="true">
            ▲
          </span>
          <span>{notice}</span>
        </p>
      )}

      <DiffView diffText={preview.diffText} />

      {preview.warnings.length > 0 && (
        <ul className="consent-warnings" aria-label="Before you connect">
          {preview.warnings.map((w, i) => (
            <li key={i}>
              <span className="glyph tone-needs-you" aria-hidden="true">
                ▲
              </span>
              <span>{w}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="consent-actions">
        <button type="button" className="primary-button" onClick={onConnect} disabled={busy} aria-busy={busy}>
          {busy ? 'Connecting…' : 'Connect'}
        </button>
        <button type="button" className="quiet-button" onClick={onLater} disabled={busy}>
          Not now
        </button>
        {error && (
          <p className="consent-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}

/**
 * A calm strip under the title bar. `needs_consent` (after "Not now") offers to review the change again;
 * `port_in_use` and `error` say what happened and what to do, in the core's words.
 */
export function ConnectionBanner({ connection, onReview }: { connection: ConnectionStatus; onReview?: () => void }) {
  if (connection.status === 'attached') return null;
  const consent = connection.status === 'needs_consent';
  const message = consent ? NOT_CONNECTED : (connection.message ?? 'Huddle is not connected to Claude Code.');
  const tone = consent ? 'tone-needs-you' : 'tone-failed';
  return (
    <div className={`conn-banner ${tone}`} role={consent ? 'status' : 'alert'}>
      <span className={`glyph ${tone}`} aria-hidden="true">
        {consent ? '▲' : '✕'}
      </span>
      <span className="conn-text">
        <InlineCodeText text={message} />
      </span>
      {consent && onReview && (
        <button type="button" className="quiet-button conn-action" onClick={onReview}>
          Review changes
        </button>
      )}
    </div>
  );
}

/** The widget's single row: it cannot show a diff, so it sends the user to the main window. */
export function WidgetConnectionRow({
  connection,
  onOpenMain,
}: {
  connection: ConnectionStatus;
  onOpenMain: () => void;
}) {
  if (connection.status === 'attached') return null;
  const consent = connection.status === 'needs_consent';
  const tone = consent ? 'tone-needs-you' : 'tone-failed';
  const text = consent ? WIDGET_NOT_CONNECTED : (connection.message ?? 'Huddle is not connected to Claude Code.');
  return (
    <button type="button" className={`widget-conn ${tone}`} onClick={onOpenMain} title="Open the main window">
      <span className={`glyph ${tone}`} aria-hidden="true">
        {consent ? '▲' : '✕'}
      </span>
      <span className="widget-conn-text">
        <InlineCodeText text={text} />
      </span>
    </button>
  );
}
