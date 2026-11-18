/**
 * Words for the M2 meters (F4 progress and ETA, F5 usage, F6 context). Pure: the numbers come from the shared
 * selectors, this file only decides what to say. Unknown is `—` or "unknown", never 0 (an agent with no
 * recorded request has unknown usage, not zero usage).
 */
import {
  isTerminal,
  type AgentNode,
  type ContextHealth,
  type ProgressView,
  type RateLimits,
  type TaskItem,
  type TokenUsage,
} from '@huddle/shared';
import { etaRange, plural } from './format.js';

/** Usage is known only once at least one request was recorded. */
export function knownUsage(usage: TokenUsage | null | undefined): TokenUsage | null {
  return usage && usage.requests > 0 ? usage : null;
}

/** Every token the recorded requests used: input, output, cache read and cache written. null when nothing is recorded. */
export function totalTokens(usage: TokenUsage | null | undefined): number | null {
  const known = knownUsage(usage);
  if (known === null) return null;
  return known.inputTokens + known.outputTokens + known.cacheReadTokens + known.cacheCreationTokens;
}

/**
 * Input plus output: the tokens of work done, as History counts them (`workTokens`). Cache reads are the context read
 * again on every request; adding them made a long session read "43.8M" next to History's figure for the same run.
 */
export function workTotal(usage: TokenUsage | null | undefined): number | null {
  const known = knownUsage(usage);
  return known === null ? null : known.inputTokens + known.outputTokens;
}

/**
 * The cost Claude Code reported, or null when no recorded request carried one: the reducer counts a missing cost as
 * 0 (flagged in `requestsWithoutCost`), and that 0 means "unknown", not "free". With some requests missing a cost the
 * figure is a lower bound; the Usage section says so in a note.
 */
export function knownCostUsd(usage: TokenUsage | null | undefined): number | null {
  const known = knownUsage(usage);
  if (known === null) return null;
  return (known.requestsWithoutCost ?? 0) >= known.requests ? null : known.estimatedCostUsd;
}

const CONFIDENCE_WORD: Record<ProgressView['confidence'], string> = {
  high: 'high confidence',
  medium: 'medium confidence',
  low: 'low confidence',
};

/** The tooltip on a bar that includes what the agent itself reported (F27): short, and says it is an estimate. */
export const SELF_REPORT_SOURCE = "Includes the agent's own report of its progress. An estimate.";

export interface ProgressWords {
  /** 0..1 for the bar, or null: draw no bar (unknown, or a self-report that gave only minutes left). */
  fraction: number | null;
  /** What the estimate is based on: "3 of 5 subagents finished". Null when there is no basis: show nothing. */
  counted: string | null;
  /** "about 4–7 min left", or null when unknown or the agent has finished. */
  eta: string | null;
  confidence: string | null;
  scopeGrew: boolean;
  /** The agent's own report is part of it (basis self_report or hybrid): SELF_REPORT_SOURCE for a tooltip, else null. */
  source: string | null;
}

export function progressWords(view: ProgressView | null, agent: Pick<AgentNode, 'status'>): ProgressWords {
  const none: ProgressWords = {
    fraction: null,
    counted: null,
    eta: null,
    confidence: null,
    scopeGrew: false,
    source: null,
  };
  if (view === null || view.basis === 'none') return none;
  const live = !isTerminal(agent.status);
  const eta = live && view.etaMs !== 0 ? etaRange(view.etaLowMs, view.etaHighMs) : null;
  const confidence = eta === null ? null : CONFIDENCE_WORD[view.confidence];
  if (view.fraction === null) {
    // F27: a self-report with minutes left and no percent. No bar (the fraction is unknown, never 0): the time left only.
    if (view.basis !== 'self_report' || eta === null) return none;
    return {
      fraction: null,
      counted: "from the agent's own report: time left only",
      eta,
      confidence,
      scopeGrew: false,
      source: SELF_REPORT_SOURCE,
    };
  }
  const fraction = Math.min(1, Math.max(0, view.fraction));
  let counted: string;
  switch (view.basis) {
    case 'subagents': {
      const { finishedSubagents: done, startedSubagents: started } = view;
      counted =
        done === started && !isTerminal(agent.status)
          ? `${plural(started, 'subagent')} finished, wrapping up`
          : `${String(done)} of ${plural(started, 'subagent')} finished`;
      break;
    }
    case 'tasks':
      counted = `${String(view.completedTasks)} of ${plural(view.totalTasks, 'task')} done`;
      break;
    case 'hybrid':
      counted = `${String(view.completedTasks)} of ${plural(view.totalTasks, 'task')} done, with the agent's own report`;
      break;
    case 'self_report':
      counted = "from the agent's own report";
      break;
  }
  return {
    fraction,
    counted,
    eta,
    confidence,
    scopeGrew: view.scopeGrew === true,
    source: view.basis === 'self_report' || view.basis === 'hybrid' ? SELF_REPORT_SOURCE : null,
  };
}

/**
 * The progress line on a widget card (Widget v2). Short, so it fits beside the face at 340 px:
 *  - tasks:      lead "3/5", then the task in progress (shared selectCurrentTask, passed in as current), else the first
 *                task not done yet ("3/5 Drafting"); bar = done / total;
 *  - subagents:  lead "2/3", then "subagents" and the estimated time left ("~2–9 min left, est.");
 *  - others:     the estimate as a percent ("~40% est."), with the time left when known;
 *  - no basis:   nothing at all: no words and no bar (unknown is not 0).
 * `lead` is drawn in the session's status colour; `title` says the whole thing in words for the tooltip.
 */
export interface CardProgress {
  /** "3/5", or null. */
  lead: string | null;
  /** What follows the lead: "Drafting", "subagents · ~2–9 min left, est.". */
  text: string;
  /** 0..1 for the bar, or null: no bar. */
  fraction: number | null;
  title: string;
}

/** "about 2–9 min left" → "~2–9 min left" (the card's short form; still a range, still marked est.). */
function shortEta(eta: string | null): string | null {
  return eta === null ? null : eta.replace(/^about /, '~');
}

export function cardProgress(
  view: ProgressView | null,
  agent: Pick<AgentNode, 'status' | 'tasks'>,
  /** The task in progress (`selectCurrentTask`), or null when none is known to have started. */
  current: TaskItem | null = null,
): CardProgress | null {
  const words = progressWords(view, agent);
  if (view === null || words.counted === null) return null;
  const eta = shortEta(words.eta);
  const etaPart = eta === null ? '' : ` · ${eta}, est.`;
  const etaTitle = words.eta === null ? '' : `, ${words.eta} (estimate, ${words.confidence ?? 'low confidence'})`;
  const sourceTitle = words.source === null ? '' : `. ${words.source}`;
  if (words.fraction === null) {
    // F27: minutes left only (no percent): the time left, no bar, never "0%".
    return {
      lead: null,
      text: `${eta ?? ''}, est.`,
      fraction: null,
      title: `${words.counted}${etaTitle}${sourceTitle}`,
    };
  }
  if (view.basis === 'tasks' && view.totalTasks > 0) {
    const next = current ?? agent.tasks.find((t) => t.status !== 'completed');
    const label = current !== null ? 'in progress' : 'next';
    return {
      lead: `${String(view.completedTasks)}/${String(view.totalTasks)}`,
      text: next?.subject ?? 'all tasks done',
      fraction: Math.min(1, Math.max(0, view.completedTasks / view.totalTasks)),
      title: `${words.counted}${next ? `; ${label}: ${next.subject}` : ''}${etaTitle}`,
    };
  }
  if (view.basis === 'subagents') {
    return {
      lead: `${String(view.finishedSubagents)}/${String(view.startedSubagents)}`,
      text: `subagents done${eta === null ? '' : ` · ${eta}`}, est.`,
      fraction: words.fraction,
      title: `${words.counted}${etaTitle}; the bar is an estimate`,
    };
  }
  return {
    lead: null,
    text: `~${String(Math.round(words.fraction * 100))}% est.${etaPart}`,
    fraction: words.fraction,
    title: `${words.counted}${etaTitle}${words.source === null ? '; the bar is an estimate' : sourceTitle}`,
  };
}

const MEASURED_BY: Record<NonNullable<ContextHealth['measuredBy']>, string> = {
  statusline: 'measured by the status line',
  telemetry: 'measured from telemetry',
  sdk: 'measured by the Agent SDK',
};

export function contextSource(measuredBy: ContextHealth['measuredBy']): string {
  return measuredBy === null ? 'no measurement yet' : MEASURED_BY[measuredBy];
}

/** Rate-limit windows as rows the UI can draw; empty when Claude Code has not reported any. */
export function rateLimitRows(
  limits: RateLimits | null | undefined,
): { label: string; pct: number | null; resetsAt: number | null }[] {
  if (!limits) return [];
  return [
    { label: '5h', pct: limits.fiveHourUsedPct, resetsAt: limits.fiveHourResetsAt },
    { label: '7d', pct: limits.sevenDayUsedPct, resetsAt: limits.sevenDayResetsAt },
  ];
}
