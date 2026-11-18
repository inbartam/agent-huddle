/**
 * F27 self-reported progress: the `tool_input` of one `mcp__huddle__report_progress` call -> the fields of a
 * `progress.reported` event, or null when nothing in it is usable. Pure; never throws.
 *
 * The agent passes `{fraction?, minutesLeft?, note?}` exactly as it likes (S19: PostToolUse carries tool_input as the
 * agent passed it). The MCP server's input schema is advice to the model, not a guarantee, so every field is checked
 * here on its own: one bad field drops that field, not the report. Unknown fields are ignored (never copied).
 *   fraction     a number (zod 4 `z.number()` refuses NaN and +-Infinity), clamped to [0, 1]; anything else: null
 *   minutesLeft  a number >= 0, capped at MAX_MINUTES_LEFT; negative or not a number: null
 *   note         a string, masked (maskSecrets), whitespace collapsed, clipped to CLIP_LIMITS.summary; blank: null
 */
import { z } from 'zod';
import { CLIP_LIMITS } from '@huddle/shared';
import type { EventOfType } from '@huddle/shared';
import { MASK_MARGIN, maskSecrets } from '../privacy/redact.js';
import { clip } from '../text.js';

/** 24 hours. A longer estimate is not a plan, it is noise; capping keeps the ETA arithmetic sane. */
export const MAX_MINUTES_LEFT = 24 * 60;

/** Characters kept after masking for the whitespace pass (bounded work on a hostile input), before the clip. */
const NOTE_READ_LIMIT = CLIP_LIMITS.summary * 4;

const FractionSchema = z.number();
const MinutesSchema = z.number().min(0);
const NoteSchema = z.string();

export type ProgressReportFields = Pick<EventOfType<'progress.reported'>, 'fraction' | 'etaMinutes' | 'note'>;

/** Reads one report. Null when none of the three fields is usable (the caller then emits nothing). */
export function readProgressReport(input: unknown): ProgressReportFields | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  const fraction = FractionSchema.safeParse(own(raw, 'fraction'));
  const minutes = MinutesSchema.safeParse(own(raw, 'minutesLeft'));
  const note = NoteSchema.safeParse(own(raw, 'note'));
  const fields: ProgressReportFields = {
    fraction: fraction.success ? Math.min(1, Math.max(0, fraction.data)) : null,
    etaMinutes: minutes.success ? Math.min(MAX_MINUTES_LEFT, minutes.data) : null,
    note: note.success ? cleanNote(note.data) : null,
  };
  return fields.fraction === null && fields.etaMinutes === null && fields.note === null ? null : fields;
}

/** The timeline line for a report call (F8): "reported progress 40%, 2 min left: reading notes". */
export function progressReportSummary(input: unknown): string {
  const report = readProgressReport(input);
  if (report === null) return 'reported progress';
  const parts: string[] = [];
  if (report.fraction !== null) parts.push(`${String(Math.round(report.fraction * 100))}%`);
  if (report.etaMinutes !== null) parts.push(`${formatMinutes(report.etaMinutes)} min left`);
  const head = parts.length === 0 ? 'reported progress' : `reported progress ${parts.join(', ')}`;
  return report.note === null ? head : `${head}: ${report.note}`;
}

function formatMinutes(minutes: number): string {
  return minutes < 10 ? String(Math.round(minutes * 10) / 10) : String(Math.round(minutes));
}

function cleanNote(value: string): string | null {
  // Masked before any cut, so a cut never leaves half a secret that no pattern recognizes.
  const line = maskSecrets(value.slice(0, NOTE_READ_LIMIT + MASK_MARGIN))
    .slice(0, NOTE_READ_LIMIT)
    .replace(/\s+/g, ' ')
    .trim();
  return line === '' ? null : clip(line, CLIP_LIMITS.summary);
}

/** Own property only: a key named like an Object.prototype member never reads the prototype. */
function own(record: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

// --- report_teammate (M6 P5b, ADR-027) --------------------------------------------------------------------------------

/**
 * Longest teammate name the tool takes (`scripts/huddle-mcp.mjs` NAME_MAX). Teammate names are the lead's own short
 * identifiers (S20: `alpha`); a longer one is not a name the Huddle ever sent, so the call is ignored.
 */
export const TEAMMATE_NAME_MAX = 100;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/;

const TeammateNameSchema = z
  .string()
  .transform((s) => s.trim())
  .pipe(z.string().min(1).max(TEAMMATE_NAME_MAX))
  .refine((s) => !CONTROL_CHARS.test(s));
const TeammateStatusSchema = z.enum(['finished', 'waiting']);

export type TeammateReportFields = Pick<EventOfType<'teammate.reported'>, 'teammateName' | 'status' | 'note'>;

/**
 * The `tool_input` of one `mcp__huddle__report_teammate` call -> the fields of a `teammate.reported` event, or null when
 * the call is unusable. Pure; never throws. `name` (a trimmed string of 1..TEAMMATE_NAME_MAX characters without control
 * characters) and `status` (`finished` | `waiting`) are both required: without either the answer means nothing. `note`
 * is optional and checked on its own (masked, whitespace collapsed, clipped; anything but a string: null). Unknown
 * fields are ignored. A name the Huddle does not know is still returned: the reducer decides (it changes nothing then).
 */
export function readTeammateReport(input: unknown): TeammateReportFields | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  const name = TeammateNameSchema.safeParse(own(raw, 'name'));
  const status = TeammateStatusSchema.safeParse(own(raw, 'status'));
  if (!name.success || !status.success) return null;
  const note = NoteSchema.safeParse(own(raw, 'note'));
  return {
    teammateName: name.data,
    status: status.data,
    note: note.success ? cleanNote(note.data) : null,
  };
}

/** The timeline line for a report_teammate call (F8): "reported teammate alpha finished: note". */
export function teammateReportSummary(input: unknown): string {
  const report = readTeammateReport(input);
  if (report === null) return 'reported a teammate';
  const head = `reported teammate ${clip(report.teammateName, CLIP_LIMITS.summary)} ${report.status}`;
  return report.note === null ? head : `${head}: ${report.note}`;
}
