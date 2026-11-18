/**
 * Number and text formatting. Unknown is `—`, never 0 (CONTRIBUTING.md, DESIGN.md "Words").
 */
export const UNKNOWN = '—';

export function orUnknown(value: string | null | undefined): string {
  return value === null || value === undefined || value.trim() === '' ? UNKNOWN : value;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Local wall-clock time, HH:MM. */
export function clockTime(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Local wall-clock time with seconds, for tooltips. */
export function clockTimeFull(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return UNKNOWN;
  if (ms < 1000) return `${String(Math.round(ms))} ms`;
  const total = Math.round(ms / 1000);
  if (total < 60) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  // Whole seconds first, so 119.7 s is 2 min, not 1 min 60 s.
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m < 60) return s ? `${String(m)} min ${String(s)} s` : `${String(m)} min`;
  const h = Math.floor(m / 60);
  return `${String(h)} h ${String(m % 60)} min`;
}

/** "claude-sonnet-5" -> "Sonnet 5", the casing the rest of the app uses; anything unrecognised is shown as given. */
export function shortModel(model: string | null): string {
  if (!model) return UNKNOWN;
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?(?:-\d{8})?/.exec(model);
  if (!m?.[1] || !m[2]) {
    // A bare alias the Agent call asked for ("haiku") reads like the full names: "Haiku".
    return /^(opus|sonnet|haiku|fable)$/i.test(model)
      ? `${model.charAt(0).toUpperCase()}${model.slice(1).toLowerCase()}`
      : model;
  }
  return `${m[1].charAt(0).toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}`;
}

/** Last folder name of a path, Windows or POSIX. */
export function folderName(path: string | null): string {
  if (!path) return UNKNOWN;
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

/**
 * How sure Huddle is about who an agent reports to, in plain words (DESIGN.md "Words": never the raw enum).
 * exact: the spawning call was matched by its id. Anything else is a guess from the order agents started in.
 */
export function linkQuality(link: 'exact' | 'heuristic' | 'unknown' | null | undefined): string {
  return link === 'exact' ? 'confirmed' : 'best guess — matched by order';
}

/** Whole number with thousands separators ("172,000"); `—` when unknown. Fixed locale so screenshots and tests match. */
export function count(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return UNKNOWN;
  return Math.round(n).toLocaleString('en-US');
}

/** Short token count for dense rows: 950, 4.2k, 12k, 1.2M. */
export function shortCount(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return UNKNOWN;
  if (n < 1000) return String(Math.round(n));
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 999_500) return `${String(Math.round(n / 1000))}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Dollars with a leading `~` (a sub-cent amount shows as "<$0.01"): always Claude Code's client-side estimate (ADR-013). */
export function approxUsd(usd: number | null | undefined): string {
  if (usd === null || usd === undefined || !Number.isFinite(usd)) return UNKNOWN;
  if (usd > 0 && usd < 0.01) return '<$0.01';
  return `~$${usd.toFixed(2)}`;
}

/** Whole percent, e.g. "86%"; `—` when unknown. */
export function percent(pct: number | null | undefined): string {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return UNKNOWN;
  return `${String(Math.round(pct))}%`;
}

/**
 * An ETA range in words: "about 4–7 min left", "about 1–2 h left", "under a minute left".
 * Null when either end is unknown. The caller labels it as an estimate.
 */
export function etaRange(lowMs: number | null, highMs: number | null): string | null {
  if (lowMs === null || highMs === null || !Number.isFinite(lowMs) || !Number.isFinite(highMs)) return null;
  if (highMs < 60_000) return 'under a minute left';
  const lowMin = Math.max(1, Math.floor(lowMs / 60_000));
  const highMin = Math.max(lowMin, Math.ceil(highMs / 60_000));
  if (highMin >= 120) {
    const lowH = Math.max(1, Math.floor(lowMin / 60));
    const highH = Math.max(lowH, Math.ceil(highMin / 60));
    return lowH === highH ? `about ${String(lowH)} h left` : `about ${String(lowH)}–${String(highH)} h left`;
  }
  return lowMin === highMin
    ? `about ${String(lowMin)} min left`
    : `about ${String(lowMin)}–${String(highMin)} min left`;
}
