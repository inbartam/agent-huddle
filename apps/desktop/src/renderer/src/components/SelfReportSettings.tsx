/**
 * Settings → Self-reported progress (M6, F27, ADR-025). A switch for runs Huddle launches (`selfReport.enabled`), and
 * an opt-in block for sessions the user starts in a terminal: it checks what is registered (`setup.selfReportPreview`,
 * read-only) when the section opens; Preview shows the exact command, the `.claude.json` diff, the notes and any refusal;
 * Register sends `setup.selfReport.register` with that preview's fingerprint. Registered: Remove… shows its own preview
 * and an inline confirmation (never a browser dialog). `expired` reads the preview again and says why.
 *
 * Every string in a preview came from disk or PATH and is drawn as a text node; long ones are clipped with Show all.
 */
import { useEffect, useRef, useState } from 'react';
import type {
  CommandResult,
  HuddleCommand,
  HuddleState,
  SelfReportRegistrationMode,
  SelfReportRegistrationPreview,
} from '@huddle/shared';
import type { QueryFn } from '../query.js';
import { loadSelfReportPreview } from '../self-report-query.js';
import {
  applyControl,
  applyOutcome,
  clipChars,
  clipLines,
  registrationCommand,
  registrationStatus,
  selfReportEnabled,
  selfReportEnabledCommand,
  SELF_REPORT_WORDS as W,
  STATUS_LOOK,
  type Clipped,
} from '../view/self-report.js';
import { ControlButton } from './ControlButton.js';
import { DiffView, InlineCodeText } from './Connection.js';

export type StatusState =
  { kind: 'loading' } | { kind: 'loaded'; preview: SelfReportRegistrationPreview } | { kind: 'error'; message: string };

export type PanelState =
  | { kind: 'loading'; mode: SelfReportRegistrationMode }
  | { kind: 'shown'; preview: SelfReportRegistrationPreview; notice: string | null }
  | { kind: 'error'; mode: SelfReportRegistrationMode; message: string };

export interface SelfReportSettingsProps {
  state: HuddleState;
  onCommand: (cmd: HuddleCommand) => Promise<CommandResult>;
  query: QueryFn | null;
  /** Starting state (tests: render-to-string runs no effect). */
  initial?: { status?: StatusState; panel?: PanelState | null };
}

/** A long string, clipped, with Show all / Show less. Text nodes only. */
function ClipToggle({ clip, open, onToggle }: { clip: Clipped; open: boolean; onToggle: () => void }) {
  if (!clip.clipped) return null;
  return (
    <button type="button" className="control control-quiet sr-clip" aria-expanded={open} onClick={onToggle}>
      {open ? W.showLess : `${W.showAll} (${clip.total})`}
    </button>
  );
}

function ClippedCode({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const clip = clipChars(text);
  return (
    <li className="sr-command">
      <code className="code sr-command-text">{open ? text : clip.text}</code>
      <ClipToggle
        clip={clip}
        open={open}
        onToggle={() => {
          setOpen(!open);
        }}
      />
    </li>
  );
}

function ClippedNote({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const clip = clipChars(text);
  return (
    <li>
      <span>{open ? text : clip.text}</span>
      <ClipToggle
        clip={clip}
        open={open}
        onToggle={() => {
          setOpen(!open);
        }}
      />
    </li>
  );
}

function ClippedDiff({ diffText }: { diffText: string }) {
  const [open, setOpen] = useState(false);
  const clip = clipLines(diffText);
  return (
    <>
      <DiffView diffText={open ? diffText : clip.text} label="Change to .claude.json" />
      <ClipToggle
        clip={clip}
        open={open}
        onToggle={() => {
          setOpen(!open);
        }}
      />
    </>
  );
}

/** The preview itself: file, commands, diff, notes, refusal. */
function PreviewBody({ preview }: { preview: SelfReportRegistrationPreview }) {
  const refusal = preview.refusal === null ? null : clipChars(preview.refusal);
  const [refusalOpen, setRefusalOpen] = useState(false);
  return (
    <>
      <dl className="consent-file sr-file">
        <dt>{W.fileLabel}</dt>
        <dd className="code" title={preview.claudeJsonPath}>
          {preview.claudeJsonPath}
        </dd>
      </dl>
      {preview.commands.length > 0 ? (
        <>
          <p className="setting-help sr-lead">{W.commandsLead}</p>
          <ul className="sr-commands" aria-label={W.commandsLead}>
            {preview.commands.map((c, i) => (
              <ClippedCode key={i} text={c} />
            ))}
          </ul>
        </>
      ) : (
        <p className="setting-help sr-lead">{W.noCommand}</p>
      )}
      {preview.diffText !== '' && <ClippedDiff diffText={preview.diffText} />}
      {preview.notes.length > 0 && (
        <ul className="consent-warnings sr-notes" aria-label={W.notesLabel}>
          {preview.notes.map((n, i) => (
            <ClippedNote key={i} text={n} />
          ))}
        </ul>
      )}
      {refusal !== null && preview.refusal !== null && (
        <p className="sr-refusal" role="status" aria-label={W.refusalLabel}>
          <span className="glyph tone-failed" aria-hidden="true">
            ✕
          </span>{' '}
          <span>{refusalOpen ? preview.refusal : refusal.text}</span>
          <ClipToggle
            clip={refusal}
            open={refusalOpen}
            onToggle={() => {
              setRefusalOpen(!refusalOpen);
            }}
          />
        </p>
      )}
    </>
  );
}

export function SelfReportSettings({ state, onCommand, query, initial }: SelfReportSettingsProps) {
  const enabled = selfReportEnabled(state);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusState>(initial?.status ?? { kind: 'loading' });
  const [panel, setPanel] = useState<PanelState | null>(initial?.panel ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const trigger = useRef<HTMLDivElement>(null);

  const checkSeq = useRef(0);
  const check = () => {
    const n = ++checkSeq.current;
    void loadSelfReportPreview(query, 'register').then((r) => {
      if (n !== checkSeq.current) return; // a newer check, or a preview that already said it, wins
      setStatus(r.ok ? { kind: 'loaded', preview: r.preview } : { kind: 'error', message: r.message });
    });
  };
  useEffect(() => {
    if (initial?.status === undefined) check();
    // Once, on open: the preview reads `.claude.json` and PATH and runs nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount only: `check` is a new function every render and `initial` is a test seed
  }, []);

  const open = (mode: SelfReportRegistrationMode, noticeAfter: string | null = null) => {
    setPanel({ kind: 'loading', mode });
    setError(null);
    setNotice(null);
    void loadSelfReportPreview(query, mode).then((r) => {
      if (!r.ok) {
        setPanel({ kind: 'error', mode, message: r.message });
        return;
      }
      setPanel({ kind: 'shown', preview: r.preview, notice: noticeAfter });
      // A preview is a fresh read: it also says what is registered now.
      checkSeq.current += 1;
      setStatus({ kind: 'loaded', preview: r.preview });
    });
  };

  // Back to the button that opened the preview, once it is drawn again.
  const [refocus, setRefocus] = useState(false);
  useEffect(() => {
    if (!refocus || panel !== null) return;
    trigger.current?.querySelector<HTMLButtonElement>('button')?.focus();
    setRefocus(false);
  }, [refocus, panel]);

  const close = () => {
    setPanel(null);
    setRefocus(true);
  };

  const apply = (preview: SelfReportRegistrationPreview) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    void onCommand(registrationCommand(preview)).then((r) => {
      setBusy(false);
      const outcome = applyOutcome(preview.mode, r);
      if (outcome.kind === 'expired') {
        open(preview.mode, W.expired);
      } else if (outcome.kind === 'error') {
        setError(outcome.message);
      } else {
        setPanel(null);
        setNotice(outcome.notice);
        check();
      }
    });
  };

  const current = status.kind === 'loaded' ? registrationStatus(status.preview) : null;
  const look = current === null ? null : STATUS_LOOK[current];
  const shown = panel?.kind === 'shown' ? panel.preview : null;

  return (
    <div className="phone-settings self-report-settings">
      <ul className="switches">
        <li className="switch-row">
          <input
            id="self-report-enabled"
            type="checkbox"
            role="switch"
            className="switch"
            checked={enabled}
            aria-describedby="self-report-enabled-help"
            onChange={(e) => {
              setSwitchError(null);
              void onCommand(selfReportEnabledCommand(e.target.checked)).then((r) => {
                if (!r.ok) setSwitchError(r.message);
              });
            }}
          />
          <label htmlFor="self-report-enabled">{W.label}</label>
        </li>
      </ul>
      <p id="self-report-enabled-help" className="setting-help">
        {W.help}
      </p>
      {switchError !== null && (
        <p className="inline-error" role="alert">
          {switchError}
        </p>
      )}

      <div className="sr-attached">
        <h3 id="self-report-attached-title" className="phone-devices-title">
          {W.attachedTitle}
        </h3>
        <p className="setting-help">
          <InlineCodeText text={W.attachedWhat} />
        </p>
        <p className="setting-help">{W.attachedLess}</p>

        <p className={`phone-state ${look?.tone ?? 'tone-idle'}`} role="status" id="self-report-status">
          {status.kind === 'loading' && W.checking}
          {status.kind === 'error' && (
            <>
              <span className="glyph" aria-hidden="true">
                ?
              </span>{' '}
              {W.unknownStatus}
              <span className="phone-reason"> · {status.message}</span>
            </>
          )}
          {look !== null && (
            <>
              <span className="glyph" aria-hidden="true">
                {look.glyph}
              </span>{' '}
              {look.words}
            </>
          )}
        </p>

        {panel === null && (
          <div className="phone-actions" ref={trigger}>
            {current === 'registered' ? (
              <button
                type="button"
                className="control control-plain"
                onClick={() => {
                  open('unregister');
                }}
              >
                {W.remove}
              </button>
            ) : (
              <button
                type="button"
                className="control control-plain"
                onClick={() => {
                  open('register');
                }}
              >
                {W.preview}
              </button>
            )}
          </div>
        )}

        {panel?.kind === 'loading' && (
          <p className="setting-help" role="status">
            {W.previewing}
          </p>
        )}
        {panel?.kind === 'error' && (
          <div className="phone-actions">
            <p className="inline-error" role="alert">
              {panel.message}
            </p>
            <button type="button" className="control control-quiet" onClick={close}>
              {W.close}
            </button>
          </div>
        )}

        {panel?.kind === 'shown' && shown !== null && (
          <div
            className="sr-preview"
            role="group"
            aria-label={shown.mode === 'register' ? 'Register preview' : 'Remove preview'}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && !busy) {
                e.preventDefault();
                close();
              }
            }}
          >
            {panel.notice !== null && (
              <p className="consent-notice tone-needs-you" role="status">
                <span className="glyph tone-needs-you" aria-hidden="true">
                  ▲
                </span>
                <span>{panel.notice}</span>
              </p>
            )}
            <PreviewBody preview={shown} />
            {shown.mode === 'unregister' && applyControl(shown, false).enabled && (
              <p className="sr-question">
                {W.removeQuestion} <span className="muted">{W.removeAfter}</span>
              </p>
            )}
            <div className="phone-actions">
              {shown.mode === 'register' ? (
                <ControlButton
                  control={applyControl(shown, busy)}
                  onPress={() => {
                    apply(shown);
                  }}
                  variant="primary"
                  busy={busy}
                >
                  {busy ? W.registering : W.register}
                </ControlButton>
              ) : (
                <ControlButton
                  control={applyControl(shown, busy)}
                  onPress={() => {
                    apply(shown);
                  }}
                  className="control-danger"
                  busy={busy}
                >
                  {busy ? W.removing : W.removeConfirm}
                </ControlButton>
              )}
              <button type="button" className="control control-plain" onClick={close} disabled={busy}>
                {shown.mode === 'register' ? W.close : W.back}
              </button>
            </div>
          </div>
        )}

        {error !== null && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        {notice !== null && (
          <p className="setting-help" role="status">
            {notice}
          </p>
        )}
      </div>
    </div>
  );
}
