import type { AgentKind, AgentStatus } from '@huddle/shared';
import { lookFor } from '../view/status.js';
import { agentLook } from '../view/teammates.js';

/**
 * The status glyph. Decorative for screen readers: every place that shows it also shows the label.
 * `changed` replays the 150 ms cross-fade (DESIGN.md, Motion) when the status just changed.
 * `stale`: the session has not been heard from since Huddle restarted; the glyph shows that, not the last status.
 * `still`: a replay (M5). The working ● does not breathe, because the breath means live.
 */
export function StatusGlyph({
  status,
  changed = false,
  stale = false,
  still = false,
}: {
  status: AgentStatus;
  changed?: boolean;
  stale?: boolean;
  still?: boolean;
}) {
  const look = lookFor(status, stale);
  const breathes = status === 'working' && !stale && !still;
  return (
    <span
      key={changed ? status : undefined}
      className={`glyph tone-${look.tone}${breathes ? ' is-working' : ''}${changed && !still ? ' is-changed' : ''}`}
      data-status={stale ? 'stale' : status}
      aria-hidden="true"
    >
      {look.glyph}
    </span>
  );
}

/**
 * Glyph and label together: the form used wherever there is room. `kind` (M6): a teammate's idle reads "idle, waiting
 * for the lead"; absent, every agent gets the plain status words.
 */
export function StatusBadge({
  status,
  stale = false,
  still = false,
  kind = 'main',
}: {
  status: AgentStatus;
  stale?: boolean;
  still?: boolean;
  kind?: AgentKind;
}) {
  const look = agentLook(kind, status, stale);
  return (
    <span className={`status tone-${look.tone}${stale ? ' is-stale' : ''}`}>
      <StatusGlyph status={status} stale={stale} still={still} />
      <span className="status-label">{look.label}</span>
    </span>
  );
}
