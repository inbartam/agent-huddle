/**
 * The team tree, shared by the main window and the widget (DESIGN.md: "the widget is a layout,
 * not a second app"). Rows come from view/tree.ts; this file only draws them and handles the keyboard.
 *
 * Keyboard (WAI-ARIA tree pattern): Up/Down move, Right expands or enters, Left collapses or goes to
 * the parent, Home/End jump, Enter or Space selects. One row is tabbable at a time (roving tabindex).
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import {
  LEAD_AGENT,
  ROLE_PROFILES,
  type AgentKey,
  type AgentStatus,
  type RoleKindOverrides,
  type SessionIdentity,
} from '@huddle/shared';
import { displayName } from '../store.js';
import { folderName, plural } from '../view/format.js';
import { doneWords, typeOf } from '../view/roles.js';
import { statusLook } from '../view/status.js';
import { agentLook, leadWords, TEAMMATE_WORDS, teammateCount } from '../view/teammates.js';
import { agentRows, sessionStatus, type Row, type TreeRow } from '../view/tree.js';
import { StatusGlyph } from './Status.js';

const INDENT = 16;

export interface TeamTreeProps {
  /** The user's agent types by role (settings.roleKinds), for the type word on subagent rows. */
  roleKinds?: RoleKindOverrides;
  rows: readonly Row[];
  renames: ReadonlyMap<AgentKey, string>;
  selectedKey: AgentKey | null;
  /** Click, Enter or Space on a row. */
  onActivate: (row: TreeRow) => void;
  onToggle: (key: AgentKey) => void;
  /**
   * main: every row is an agent. widget: root rows summarise their session. replay (M5): a past moment, so rows can be
   * expanded and selected and nothing else, nothing breathes and nothing animates in.
   */
  mode: 'main' | 'widget' | 'replay';
  label: string;
  rowHeight?: number;
  /** Compact meters per row (the widget, F4–F6); none when absent or null. */
  meters?: (row: TreeRow) => RowMeters | null;
  /**
   * Who a session is (F2), for its main agent's row: the same title, project and topic as the widget card. Absent or
   * null: the agent's own name and the session folder.
   */
  identity?: (rootKey: AgentKey) => SessionIdentity | null;
  /**
   * A session row's second words, from its identity (the main window's sidebar: model · age, since the project is
   * already its group). Absent: the project when the title is not already it, the worktree tag and the topic.
   */
  sessionMeta?: (who: SessionIdentity) => string;
  /**
   * Inside one session's view, where the header already names the session: its main agent's row reads "Lead agent"
   * with its model, not the session's name again.
   */
  leadLabel?: boolean;
}

/** What one row shows of its meters. Every field is optional: unknown draws nothing (never a 0 bar). */
export interface RowMeters {
  /** 0..1: a thin bar along the bottom of the row. Null: no bar. */
  fraction: number | null;
  /** Short usage, e.g. "~$0.42"; with `usageTitle` saying it is an estimate. */
  usage: string | null;
  usageTitle: string;
  /** Context percent, only when it is high. */
  contextHighPct: number | null;
}

/** A session row's second words: the project when the title is not already it, the worktree tag, the topic. */
function rootMeta(who: SessionIdentity): string {
  const parts: string[] = [];
  if (who.titleFrom !== 'project' && who.project !== null) parts.push(who.project);
  if (who.worktree) parts.push('worktree');
  if (who.topic !== null) parts.push(who.topic);
  return parts.join(' · ');
}

/** A session row's tooltip: the full project path, the whole topic, what it is doing. */
function rootTip(who: SessionIdentity, activity: string | null): string {
  return [who.projectPath ?? 'folder unknown', who.topic, activity].filter((p) => p !== null && p !== '').join('\n');
}

/** The row meters in words, for the row's accessible name. */
function meterWords(m: RowMeters | null): string {
  if (m === null) return '';
  const parts: string[] = [];
  if (m.fraction !== null) parts.push(`about ${String(Math.round(m.fraction * 100))}% done, estimated`);
  if (m.usage !== null) parts.push(m.usageTitle);
  if (m.contextHighPct !== null) parts.push(`context ${String(Math.round(m.contextHighPct))}% full`);
  return parts.map((p) => `, ${p}`).join('');
}

function railTone(status: AgentStatus | null): string {
  return status ? `rail tone-${statusLook(status).tone}` : 'rail';
}

/** The connector lines at the left of one row. Pure SVG, no text. */
export function Rails({ row, height }: { row: TreeRow; height: number }) {
  const width = (row.depth + 1) * INDENT;
  const mid = height / 2;
  const x = (col: number) => col * INDENT + INDENT / 2;
  const glyphGap = 5;
  const parts: ReactNode[] = [];

  row.pass.forEach((status, col) => {
    if (status)
      parts.push(
        <line key={`p${String(col)}`} className={railTone(status)} x1={x(col)} y1={0} x2={x(col)} y2={height} />,
      );
  });

  if (row.elbow) {
    const col = row.depth - 1;
    const cx = x(col);
    if (row.elbow.continues) {
      parts.push(<line key="cont" className={railTone(row.elbow.continues)} x1={cx} y1={mid} x2={cx} y2={height} />);
    }
    const end = x(row.depth) - glyphGap;
    const d = `M ${String(cx)} 0 V ${String(mid - 4)} Q ${String(cx)} ${String(mid)} ${String(cx + 4)} ${String(mid)} H ${String(end)}`;
    const exact = row.elbow.link === 'exact';
    // Two overlaid paths so "dashed turns solid" can cross-fade (200 ms) instead of jumping.
    parts.push(
      <path
        key="dash"
        className={`${railTone(row.elbow.status)} rail-dashed`}
        d={d}
        data-on={exact ? 'false' : 'true'}
      />,
      <path
        key="solid"
        className={`${railTone(row.elbow.status)} rail-solid`}
        d={d}
        data-on={exact ? 'true' : 'false'}
      />,
    );
  }

  if (row.stub) {
    const sx = x(row.depth);
    parts.push(<line key="stub" className={railTone(row.stub)} x1={sx} y1={mid + glyphGap + 1} x2={sx} y2={height} />);
  }

  return (
    <svg
      className="rails"
      width={width}
      height={height}
      viewBox={`0 0 ${String(width)} ${String(height)}`}
      aria-hidden="true"
      data-link={row.elbow?.link ?? 'none'}
    >
      {parts}
    </svg>
  );
}

export function TeamTree(props: TeamTreeProps) {
  const { rows, renames, selectedKey, onActivate, onToggle, mode, label } = props;
  const rowHeight = props.rowHeight ?? 28;
  const items = agentRows(rows);
  const [focusKey, setFocusKey] = useState<AgentKey | null>(null);
  const refs = useRef(new Map<AgentKey, HTMLDivElement>());
  const wantFocus = useRef(false);

  // Motion that answers a change: new rows grow in, changed glyphs cross-fade. Nothing on first paint.
  const seenKeys = useRef<Set<AgentKey> | null>(null);
  const lastStatus = useRef(new Map<AgentKey, AgentStatus>());
  const still = mode === 'replay';
  const isNew = (key: AgentKey) => !still && seenKeys.current !== null && !seenKeys.current.has(key);
  useEffect(() => {
    seenKeys.current = new Set(items.map((r) => r.key));
    lastStatus.current = new Map(items.map((r) => [r.key, r.node.status]));
  });

  const tabbable =
    items.find((r) => r.key === focusKey)?.key ?? items.find((r) => r.key === selectedKey)?.key ?? items[0]?.key;

  useLayoutEffect(() => {
    if (wantFocus.current && focusKey) {
      wantFocus.current = false;
      refs.current.get(focusKey)?.focus();
    }
  }, [focusKey, rows]);

  // A selection made from outside the tree (the widget, "reports to") may be off screen: bring it into view.
  useEffect(() => {
    if (selectedKey === null) return;
    const el = refs.current.get(selectedKey);
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
  }, [selectedKey]);

  /** The nearest row above at a lower depth is the parent (rows are in tree order). */
  const parentOf = (key: AgentKey): AgentKey | undefined => {
    const i = items.findIndex((r) => r.key === key);
    const depth = items[i]?.depth ?? 0;
    for (let j = i - 1; j >= 0; j -= 1) {
      const r = items[j];
      if (r && !r.finished && r.depth < depth) return r.key;
    }
    return undefined;
  };

  const moveTo = (key: AgentKey | undefined) => {
    if (!key) return;
    wantFocus.current = true;
    setFocusKey(key);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>, row: TreeRow) => {
    const i = items.findIndex((r) => r.key === row.key);
    switch (e.key) {
      case 'ArrowDown':
        moveTo(items[i + 1]?.key);
        break;
      case 'ArrowUp':
        moveTo(items[i - 1]?.key);
        break;
      case 'Home':
        moveTo(items[0]?.key);
        break;
      case 'End':
        moveTo(items[items.length - 1]?.key);
        break;
      case 'ArrowRight':
        if (row.hasChildren && !row.expanded) onToggle(row.key);
        else if (row.hasChildren) moveTo(items[i + 1]?.key);
        break;
      case 'ArrowLeft':
        if (row.hasChildren && row.expanded) onToggle(row.key);
        else moveTo(row.finished || row.depth === 0 ? row.session.rootKey : parentOf(row.key));
        break;
      case 'Enter':
      case ' ':
        onActivate(row);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  return (
    <div className={`tree tree-${mode}`} role="tree" aria-label={label}>
      {rows.map((row) => {
        if (row.kind === 'finished-label') {
          return (
            <div key={row.key} className="tree-group" aria-hidden="true">
              Finished
              <span className="tree-group-count">{row.count}</span>
            </div>
          );
        }
        const { node, session } = row;
        const lead = props.leadLabel === true && node.kind === 'main';
        const who = node.kind === 'main' && !lead ? (props.identity?.(node.key) ?? null) : null;
        const name = lead ? LEAD_AGENT : (who?.label ?? displayName(node, renames));
        const isRootSummary = mode === 'widget' && row.depth === 0 && !row.finished && node.kind === 'main';
        const shownStatus = isRootSummary ? sessionStatus(session) : node.status;
        // A stale session (not heard from since Huddle restarted) shows that instead of its last status.
        const stale = node.stale === true;
        const look = agentLook(isRootSummary ? 'main' : node.kind, shownStatus, stale);
        // Agent teams (M6, S20): a teammate says so in a word and its lead says it leads a team, not colour alone.
        const isTeammate = node.kind === 'teammate';
        const teammates = node.kind === 'main' && !row.finished ? teammateCount(node.children) : 0;
        const kindBadge = isTeammate
          ? { text: TEAMMATE_WORDS.badge, title: TEAMMATE_WORDS.badgeTitle, spoken: TEAMMATE_WORDS.badge }
          : teammates > 0
            ? { text: TEAMMATE_WORDS.lead, title: leadWords(teammates), spoken: `team lead, ${leadWords(teammates)}` }
            : null;
        const meta = lead
          ? (props.identity?.(node.key)?.model ?? '')
          : who !== null
            ? (props.sessionMeta ?? rootMeta)(who)
            : node.kind === 'main' && !row.finished
              ? folderName(session.cwd)
              : node.role !== name
                ? node.role
                : '';
        const prev = lastStatus.current.get(node.key);
        const changed = !still && prev !== undefined && prev !== shownStatus && !isRootSummary && !stale;
        const style = { '--depth': row.depth, '--row-h': `${String(rowHeight)}px` } as CSSProperties;
        // Collapsed rows say how many agents they hide (in the widget: the whole session).
        const m = row.finished ? null : (props.meters?.(row) ?? null);
        // Agent types (2026-11-18): a subagent row names its type ("Reviewer") before its role; a finished one says
        // its finish line ("review ready") instead of plain "done". Root rows already say lead or session.
        const type = node.kind !== 'main' && !isRootSummary ? typeOf(node, props.roleKinds) : null;
        const stateWords = shownStatus === 'done' && !stale ? (doneWords(type) ?? look.label) : look.label;
        // Plain work shows no word on the row (see the state span below).
        const wordless = shownStatus === 'working' && !stale && !isTeammate;
        const hiddenKids = row.expanded
          ? 0
          : isRootSummary
            ? session.agentCount - 1
            : row.hasChildren
              ? node.children.length
              : 0;
        return (
          <div
            key={row.key}
            ref={(el) => {
              if (el) refs.current.set(row.key, el);
              else refs.current.delete(row.key);
            }}
            role="treeitem"
            aria-level={row.depth + 1}
            aria-expanded={row.hasChildren ? row.expanded : undefined}
            aria-selected={selectedKey === row.key}
            aria-label={`${name}${kindBadge ? `, ${kindBadge.spoken}` : ''}${type !== null ? `, ${ROLE_PROFILES[type].label.toLowerCase()}` : ''}, ${stateWords}${meta ? `, ${meta}` : ''}${hiddenKids > 0 ? `, ${plural(hiddenKids, 'more agent')}` : ''}${row.finished ? ', finished' : ''}${meterWords(m)}`}
            tabIndex={row.key === tabbable ? 0 : -1}
            className={[
              'tree-row',
              row.depth === 0 && !row.finished ? 'is-root' : '',
              row.finished ? 'is-finished' : '',
              (node.dimmed || stale) && !row.finished ? 'is-dimmed' : '',
              stale ? 'is-stale' : '',
              isTeammate ? 'is-teammate' : '',
              selectedKey === row.key ? 'is-selected' : '',
              isNew(row.key) ? 'is-new' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            style={style}
            onClick={() => {
              setFocusKey(row.key);
              onActivate(row);
            }}
            onDoubleClick={() => {
              if (mode !== 'widget' && row.hasChildren) onToggle(row.key);
            }}
            onFocus={() => {
              setFocusKey(row.key);
            }}
            onKeyDown={(e) => {
              onKeyDown(e, row);
            }}
            title={
              who !== null
                ? wordless
                  ? `${look.label}
${rootTip(who, node.currentActivity)}`
                  : rootTip(who, node.currentActivity)
                : wordless
                  ? `${look.label}${node.currentActivity ? `: ${node.currentActivity}` : ''}`
                  : (node.currentActivity ?? undefined)
            }
          >
            {!row.finished && <Rails row={row} height={rowHeight} />}
            <span className="tree-glyph">
              <StatusGlyph status={shownStatus} changed={changed} stale={stale} still={still} />
            </span>
            <span className="tree-text">
              <span className="tree-name" title={props.sessionMeta && who !== null ? name : undefined}>
                {name}
              </span>
              {hiddenKids > 0 && (
                <span className="tree-more" title={plural(hiddenKids, 'more agent')}>
                  +{hiddenKids}
                </span>
              )}
              {kindBadge && (
                <span className="tree-kind" title={kindBadge.title} aria-hidden="true">
                  {kindBadge.text}
                </span>
              )}
              {type !== null && (
                <span className={`tree-type type-${type}`} title={ROLE_PROFILES[type].about} aria-hidden="true">
                  {ROLE_PROFILES[type].label}
                </span>
              )}
              {meta && <span className="tree-meta">{meta}</span>}
            </span>
            {m !== null && m.contextHighPct !== null && (
              <span className="tree-ctx" title={`Context ${String(Math.round(m.contextHighPct))}% full`}>
                ctx {Math.round(m.contextHighPct)}%
              </span>
            )}
            {m !== null && m.usage !== null && (
              <span className="tree-usage" title={m.usageTitle}>
                {m.usage}
              </span>
            )}
            {m !== null && m.fraction !== null && (
              <span className="tree-bar" aria-hidden="true">
                <span className="tree-bar-fill" style={{ width: `${String(Math.round(m.fraction * 100))}%` }} />
              </span>
            )}
            {/*
              Only states that differ from plain work carry a word on the row (2026-11-18 design pass, owner-approved
              change to the "shape and label" rule): eight identical "working" words drowned the one "needs approval".
              Working keeps its shape (● breathing) and colour; the word is in the row's accessible name and tooltip.
            */}
            {!wordless && (
              <span
                className={`tree-state tone-${look.tone}`}
                aria-hidden="true"
                title={stale || isTeammate ? look.label : undefined}
              >
                {stateWords}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
