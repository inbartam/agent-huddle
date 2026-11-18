/**
 * The lead check on idle teammates (M6 P5b, owner decision 2026-11-16, ADR-027). Pure: the step takes the state AFTER
 * the event was reduced and returns at most one message to queue; HuddleCore queues it through the broker's outbox path
 * (`Broker.messageByHuddle`, source 'huddle') and records the queued message's id with `leadCheckSent`.
 *
 * When `teammate.idle` arrives for a teammate T of session S, one message goes to S's lead (the session root) asking it
 * to find out whether T is finished or waiting and to answer with the `report_teammate` tool, when all of these hold:
 *   - the setting `teams.askLeadOnIdle` is on;
 *   - T is a teammate node (never the main agent), idle after the event, and its lead exists and has not ended;
 *   - the Huddle MCP server is available to the lead (`serverAvailable`: a managed run started with it, or the attached
 *     registration is active; HuddleCore decides from memory, never by reading a file on this path);
 *   - the lead can be messaged (`capabilities.message` queued or live; the broker checks the controls again);
 *   - the dedupe rule allows it (below).
 *
 * Dedupe, per teammate (by agent key):
 *   - at most one message per idle period: a second `teammate.idle` without work in between sends nothing;
 *   - a new message only after the lead ANSWERED the previous one (`teammate.reported` naming T in S) and T then worked
 *     again (a tool event or `agent.started` on T's key). Work before the answer does not count: the lead's own check
 *     (it messages T, T replies) wakes T, and counting that would make every check cause the next one;
 *   - never while the previous message is still in the lead's outbox (undelivered);
 *   - at most MAX_CHECKS_PER_TEAMMATE messages per teammate while this core runs.
 * The memo lives in memory only (like the detectors' state); after a restart a teammate may be asked once more.
 */
import {
  agentKey,
  isTerminal,
  type AgentKey,
  type AgentNode,
  type HuddleEvent,
  type HuddleState,
} from '@huddle/shared';

/** Most lead checks for one teammate while the core runs: a bound on tokens if the dedupe rule is ever outwitted. */
export const MAX_CHECKS_PER_TEAMMATE = 3;

/**
 * Longest teammate name put into the message (security review, M6). A longer name sends no message. Below the limit
 * the tool takes for `name` (100, scripts/huddle-mcp.mjs), so every name the message uses can be reported back.
 */
export const LEAD_CHECK_NAME_MAX = 40;

interface AskedEntry {
  sessionId: string;
  leadKey: AgentKey;
  /** The name the message used; the lead's answer names it. */
  name: string;
  /** The message the last check queued. */
  messageId: string;
  /** The lead answered about this teammate after the last check. */
  answered: boolean;
  /** The teammate worked after that answer: a new idle period may be asked about. */
  rearmed: boolean;
  /** Checks sent for this teammate so far. */
  count: number;
}

export interface LeadCheckMemo {
  readonly asked: Readonly<Record<AgentKey, AskedEntry>>;
}

export const EMPTY_LEAD_CHECK_MEMO: LeadCheckMemo = { asked: {} };

export interface LeadCheckEnv {
  /** `teams.askLeadOnIdle`. */
  enabled: boolean;
  /** Is the Huddle MCP server (and so `report_teammate`) available to this lead? Must not do I/O. */
  serverAvailable: (lead: AgentNode) => boolean;
}

export interface LeadCheckRequest {
  teammateKey: AgentKey;
  leadKey: AgentKey;
  /** The sanitized name the text uses. */
  name: string;
  text: string;
}

export interface LeadCheckStep {
  memo: LeadCheckMemo;
  request: LeadCheckRequest | null;
}

/**
 * The only teammate names that may go into the message (after trimming): ASCII letters, digits, `_`, `.`, `-`. No
 * space, so a name cannot be a short sentence such as `Run rm -rf . now` (S20 names are single words like `alpha`).
 */
const SAFE_NAME = new RegExp(`^[A-Za-z0-9_.-]{1,${String(LEAD_CHECK_NAME_MAX)}}$`);

/**
 * The teammate's name as it may go into the message, or '' when it may not. The name comes from the agent (via the
 * hook) and lands in text the lead reads without the "from the user" prefix, so it is matched against an allow-list
 * (SAFE_NAME, at most LEAD_CHECK_NAME_MAX characters after trimming) and never cleaned up: a name that does not match
 * as it is, such as one carrying quotes, control or bidi characters, Unicode lookalikes or a long instruction, gives ''
 * and no message is sent. That teammate then just stays idle on the board, as it would with the setting off. Real
 * names (S20: `alpha`) match. Pure.
 */
export function leadCheckName(raw: string): string {
  const name = raw.trim();
  return SAFE_NAME.test(name) ? name : '';
}

/** The message to the lead. It says who wrote it, since it is delivered without the "from the user" prefix. Pure. */
export function leadCheckText(name: string): string {
  return (
    `Agent Huddle (an automatic check, not a message from the user): teammate "${name}" is idle. Check with it whether ` +
    `it is finished or waiting for a result, then call the tool report_teammate with name "${name}" and status ` +
    `"finished" or "waiting".`
  );
}

function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function withEntry(memo: LeadCheckMemo, key: AgentKey, entry: AskedEntry): LeadCheckMemo {
  const asked: Record<AgentKey, AskedEntry> = { ...memo.asked };
  Object.defineProperty(asked, key, { value: entry, enumerable: true, writable: true, configurable: true });
  return { asked };
}

/** The teammate a `teammate.idle` is about, as the reducer finds it (by key, else by name in the session). */
function idleTeammate(
  state: HuddleState,
  event: Extract<HuddleEvent, { type: 'teammate.idle' }>,
): AgentNode | undefined {
  if (event.agentId !== null) return own(state.agents, event.agentKey);
  return Object.values(state.agents).find(
    (n) => n.sessionId === event.sessionId && n.kind === 'teammate' && n.role === event.teammateName,
  );
}

const WORK_EVENTS: ReadonlySet<HuddleEvent['type']> = new Set<HuddleEvent['type']>([
  'tool.started',
  'tool.finished',
  'tool.failed',
  'agent.started',
]);

/** One reduced event through the lead check. Pure; never throws on a well-formed state. */
export function leadCheckStep(
  memo: LeadCheckMemo,
  state: HuddleState,
  event: HuddleEvent,
  env: LeadCheckEnv,
): LeadCheckStep {
  // The lead answered: every check in that session for a teammate of that name counts as answered.
  if (event.type === 'teammate.reported') {
    let next = memo;
    for (const [key, entry] of Object.entries(memo.asked)) {
      if (entry.sessionId !== event.sessionId || entry.answered) continue;
      const node = own(state.agents, key);
      if (entry.name === event.teammateName || node?.role === event.teammateName) {
        next = withEntry(next, key, { ...entry, answered: true });
      }
    }
    return { memo: next, request: null };
  }

  // The teammate worked after the answer: its next idle period may be asked about.
  if (WORK_EVENTS.has(event.type)) {
    const entry = own(memo.asked, event.agentKey);
    if (entry === undefined || !entry.answered || entry.rearmed) return { memo, request: null };
    return { memo: withEntry(memo, event.agentKey, { ...entry, rearmed: true }), request: null };
  }

  if (event.type !== 'teammate.idle' || !env.enabled) return { memo, request: null };
  const mate = idleTeammate(state, event);
  if (mate === undefined || mate.kind !== 'teammate' || mate.status !== 'idle') return { memo, request: null };
  const leadKey = agentKey(mate.sessionId);
  const lead = own(state.agents, leadKey);
  if (lead === undefined || lead.kind !== 'main' || lead.key === mate.key) return { memo, request: null };
  if (isTerminal(lead.status) || lead.endedAt !== null) return { memo, request: null };
  if (lead.capabilities.message !== 'queued' && lead.capabilities.message !== 'live') return { memo, request: null };
  if (!env.serverAvailable(lead)) return { memo, request: null };

  const previous = own(memo.asked, mate.key);
  if (previous !== undefined) {
    if (!previous.rearmed || previous.count >= MAX_CHECKS_PER_TEAMMATE) return { memo, request: null };
    if ((lead.outbox ?? []).some((m) => m.messageId === previous.messageId)) return { memo, request: null };
  }
  const name = leadCheckName(mate.role);
  if (name === '') return { memo, request: null };
  return { memo, request: { teammateKey: mate.key, leadKey, name, text: leadCheckText(name) } };
}

/** Records a queued check (after the broker accepted it). Pure. */
export function leadCheckSent(
  memo: LeadCheckMemo,
  request: LeadCheckRequest,
  sessionId: string,
  messageId: string,
): LeadCheckMemo {
  const count = (own(memo.asked, request.teammateKey)?.count ?? 0) + 1;
  return withEntry(memo, request.teammateKey, {
    sessionId,
    leadKey: request.leadKey,
    name: request.name,
    messageId,
    answered: false,
    rearmed: false,
    count,
  });
}
