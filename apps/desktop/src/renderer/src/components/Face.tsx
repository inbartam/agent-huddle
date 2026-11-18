/**
 * A session's face (Widget v2): a blocky mascot drawn as React SVG elements, no markup strings and no files.
 * Decorative (`aria-hidden`): the card always says the status in a glyph and words as well. Colour comes from
 * `--face-<n>` (tokens.css), the expression from view/face.ts. Each mood has its own small motion in main.css (owner,
 * 2026-11-18: working steps, needs-you hops, done jumps once, failed shakes once, idle dozes, open eyes blink); the
 * reduced-motion rule there switches all of it off.
 */
import type { ReactNode } from 'react';
import type { RoleKind } from '@huddle/shared';
import type { FaceMood } from '../view/face.js';

const W = 36;
const H = 40;

function eyes(mood: FaceMood): ReactNode {
  switch (mood) {
    case 'alert':
      return (
        <>
          <rect className="face-ink" x={8} y={9} width={7} height={8} rx={1.5} />
          <rect className="face-ink" x={21} y={9} width={7} height={8} rx={1.5} />
          <rect className="face-glint" x={9.5} y={10.5} width={2.5} height={2.5} rx={0.5} />
          <rect className="face-glint" x={22.5} y={10.5} width={2.5} height={2.5} rx={0.5} />
        </>
      );
    case 'sleepy':
      return (
        <>
          <path className="face-line" d="M9 13.5 q3 3 6 0" />
          <path className="face-line" d="M21 13.5 q3 3 6 0" />
        </>
      );
    case 'failed':
      return (
        <>
          <path className="face-line" d="M9.5 10 l5 5 M14.5 10 l-5 5" />
          <path className="face-line" d="M21.5 10 l5 5 M26.5 10 l-5 5" />
        </>
      );
    case 'flat':
      return (
        <>
          <rect className="face-ink" x={9} y={12.5} width={6} height={2.5} rx={1} />
          <rect className="face-ink" x={21} y={12.5} width={6} height={2.5} rx={1} />
        </>
      );
    case 'off':
      return (
        <>
          <rect className="face-ink" x={10.5} y={11.5} width={4} height={4} rx={1} />
          <rect className="face-ink" x={21.5} y={11.5} width={4} height={4} rx={1} />
        </>
      );
    case 'focused':
    case 'happy':
      return (
        <>
          <rect className="face-ink" x={10} y={10.5} width={5} height={5} rx={1} />
          <rect className="face-ink" x={21} y={10.5} width={5} height={5} rx={1} />
        </>
      );
  }
}

function mouth(mood: FaceMood): ReactNode {
  switch (mood) {
    case 'alert':
      return <rect className="face-ink" x={15} y={20} width={6} height={4.5} rx={1.5} />;
    case 'happy':
      return <path className="face-line" d="M13 20.5 q5 4.5 10 0" />;
    case 'failed':
      return <path className="face-line" d="M13.5 23.5 q4.5 -3.5 9 0" />;
    case 'sleepy':
      return <rect className="face-ink" x={15.5} y={21.5} width={5} height={2} rx={1} />;
    case 'focused':
    case 'flat':
    case 'off':
      return <rect className="face-ink" x={14} y={21} width={8} height={2} rx={1} />;
  }
}

/**
 * A hat per agent type (owner, 2026-11-18: "make the difference by a hat"). Small, in its own colours, perched on the
 * head with a shaded brim or band like the legs, so the type reads from the silhouette at a glance. General agents go
 * bareheaded. Decorative like the rest of the face; the type is in words on the row and in the detail.
 */
function hat(type: RoleKind | null): ReactNode {
  switch (type) {
    case 'lead': // gold crown with a red jewel
      return (
        <g className="hat hat-lead">
          <path className="hat-main" d="M9.5 1 V-6 L13.8 -2.6 L18 -8.5 L22.2 -2.6 L26.5 -6 V1 Z" />
          <rect className="hat-shade" x={9.5} y={-1} width={17} height={3.2} rx={1} />
          <circle className="hat-gem" cx={18} cy={0.6} r={1.2} />
        </g>
      );
    case 'planner': // mortarboard with a gold tassel
      return (
        <g className="hat hat-planner">
          <rect className="hat-shade" x={11.5} y={-2} width={13} height={5} rx={1.5} />
          <path className="hat-main" d="M3.5 -3 L18 -7.5 L32.5 -3 L18 1.5 Z" />
          <path className="hat-tassel-line" d="M18 -3 L29.5 -1.2 V3.5" />
          <rect className="hat-tassel" x={28.3} y={3} width={2.4} height={3.4} rx={1} />
        </g>
      );
    case 'builder': // yellow hard hat
      return (
        <g className="hat hat-builder">
          <path className="hat-main" d="M8.5 2.5 V0.5 A9.5 8 0 0 1 27.5 0.5 V2.5 Z" />
          <rect className="hat-shade" x={16.8} y={-7.2} width={2.4} height={8} rx={1.2} />
          <rect className="hat-shade" x={5} y={1.2} width={26} height={3} rx={1.5} />
        </g>
      );
    case 'designer': // red beret, tilted
      return (
        <g className="hat hat-designer">
          <path
            className="hat-main"
            d="M6.5 3.2 C5 -2.2 11 -5.6 18.5 -5.6 C26 -5.6 31.2 -2.8 29.8 1.8 C23.5 3.8 13 4.2 6.5 3.2 Z"
          />
          <path className="hat-shade" d="M6.5 3.2 C13 4.2 23.5 3.8 29.8 1.8 L29.6 3 C23.5 5 13 5.4 6.6 4.4 Z" />
          <rect className="hat-shade" x={18.6} y={-8.2} width={2} height={3} rx={1} />
        </g>
      );
    case 'reviewer': // top hat with a band
      return (
        <g className="hat hat-reviewer">
          <rect className="hat-main" x={11} y={-9} width={14} height={11} rx={1.5} />
          <rect className="hat-band" x={11} y={-1.6} width={14} height={2.4} />
          <rect className="hat-shade" x={6.5} y={1.2} width={23} height={3} rx={1.5} />
        </g>
      );
    case 'tester': // propeller beanie
      return (
        <g className="hat hat-tester">
          <path className="hat-main" d="M7.5 3.5 A10.5 9 0 0 1 28.5 3.5 Z" />
          <path className="hat-stripe" d="M15.6 3.5 C15.6 -1.5 16.6 -4.5 18 -5.5 C19.4 -4.5 20.4 -1.5 20.4 3.5 Z" />
          <rect className="hat-shade" x={17.2} y={-8.6} width={1.6} height={3.4} rx={0.8} />
          <ellipse className="hat-blade-a" cx={14.6} cy={-8.8} rx={3.4} ry={1.1} />
          <ellipse className="hat-blade-b" cx={21.4} cy={-8.8} rx={3.4} ry={1.1} />
        </g>
      );
    case 'researcher': // explorer's pith helmet
      return (
        <g className="hat hat-researcher">
          <path className="hat-main" d="M9.5 1.5 A8.5 7.5 0 0 1 26.5 1.5 Z" />
          <rect className="hat-shade" x={9.5} y={-0.8} width={17} height={1.8} />
          <rect className="hat-main" x={4.5} y={1} width={27} height={3} rx={1.5} />
          <circle className="hat-shade" cx={18} cy={-6} r={1.1} />
        </g>
      );
    case 'writer': // knit beanie with a pompom
      return (
        <g className="hat hat-writer">
          <path className="hat-main" d="M7.5 2.5 C7.5 -5 28.5 -5 28.5 2.5 Z" />
          <rect className="hat-shade" x={6.5} y={0.5} width={23} height={4.2} rx={2} />
          <path className="hat-rib" d="M10.5 1.4 V3.8 M14.5 1.4 V3.8 M18.5 1.4 V3.8 M22.5 1.4 V3.8 M26.5 1.4 V3.8" />
          <circle className="hat-pom" cx={18} cy={-5.2} r={2.8} />
        </g>
      );
    case 'general':
    case null:
      return null;
  }
}

export function Face({
  mood,
  hue,
  breathing = false,
  type = null,
}: {
  mood: FaceMood;
  hue: number;
  breathing?: boolean;
  /** The agent's type: the hat it wears (2026-11-18). */
  type?: RoleKind | null;
}) {
  const colour = mood === 'off' ? 'face-off' : `face-hue-${String(hue)}`;
  return (
    <svg
      className={`face ${colour}${breathing ? ' is-breathing' : ''}`}
      width={W}
      height={H}
      viewBox={`0 0 ${String(W)} ${String(H)}`}
      aria-hidden="true"
      data-mood={mood}
      data-type={type ?? undefined}
      focusable="false"
    >
      <rect className="face-leg face-leg-l" x={9} y={28} width={6} height={9} rx={2} />
      <rect className="face-leg face-leg-r" x={21} y={28} width={6} height={9} rx={2} />
      <g className="face-head">
        <rect className="face-body" x={3} y={2} width={30} height={29} rx={8} />
        <g className="face-eyes">{eyes(mood)}</g>
        {mouth(mood)}
        <g className="face-hat-group">{hat(type)}</g>
      </g>
    </svg>
  );
}
