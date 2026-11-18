/**
 * The session view (main window redesign, WP3): its breadcrumb and status line, the session actions (Message, Pause or
 * Resume, Stop) with a reason on every one that is off, the "why it is asking" words on an approval, and the rule
 * draft "Make a rule from this…" opens the editor with. Pure: state and `now` come in.
 *
 * Every title, path, command and summary may come from an agent: the component renders them as text, and the rule
 * draft only fills the editor's fields (nothing is saved without the editor's Save).
 */
import {
  agentKey,
  selectControls,
  selectRunControls,
  selectSessionIdentity,
  selectTree,
  startedWords,
  type AgentKey,
  type AgentNode,
  type AgentStatus,
  type ApprovalRequest,
  type AttentionItem,
  type ControlState,
  type HuddleState,
  type SessionView,
} from '@huddle/shared';
import { clockTime, plural, UNKNOWN } from './format.js';
import { emptyRuleDraft, isReadOnlyCommandPrefix, isVersionPrefix, type RuleDraft } from './rules.js';
import { APPLY_TO_ATTACHED_WORDS, currentSettings } from './settings.js';
import { lookFor, type StatusTone } from './status.js';
import { treeOptions } from './summary.js';
import { sessionStatus } from './tree.js';

export const SESSION_WORDS = {
  home: 'Home',
  tabs: { live: 'Live', team: 'Team talk', replay: 'Replay', report: 'Report' },
  stopAsk: 'Stop this run?',
  whyTitle: 'Why it is asking',
  /** The status line of a session whose Stop can never work from here (RUN_REASONS.notManaged is its tooltip). */
  startedInTerminal: 'started in a terminal',
  whyApproval: 'Claude Code asks before running this; no Huddle rule answered it.',
  whyQuestion: 'The agent asked you this. Huddle never answers a question on its own.',
  makeRule: 'Make a rule from this…',
  makeRuleHint: 'Opens the rule editor filled in from this request; nothing is saved until you press Save.',
  rulesOnlyLaunched: `Rules apply only to runs Huddle started until "${APPLY_TO_ATTACHED_WORDS.label}" is on in Settings.`,
  noSession: 'That session is no longer in the Huddle. Pick one on the left.',
  replayEnded: 'Replay and Report read the stored events of this session.',
} as const;

export type SessionTab = 'live' | 'team' | 'replay' | 'report';

/**
 * The tabs a session offers: Team talk only when it has more than one agent (2026-11-18), Report only once the run has
 * ended (before that it would always be empty).
 */
export function sessionTabs(ended: boolean, team = false): readonly SessionTab[] {
  const tabs: SessionTab[] = team ? ['live', 'team', 'replay'] : ['live', 'replay'];
  return ended ? [...tabs, 'report'] : tabs;
}

export interface SessionHead {
  rootKey: AgentKey;
  sessionId: string;
  /** Project folder name, null when unknown. */
  project: string | null;
  projectPath: string | null;
  /** The sidebar title (nickname → session title → first prompt → "Untitled session"). */
  title: string;
  status: AgentStatus;
  stale: boolean;
  glyph: string;
  tone: StatusTone;
  label: string;
  /** "agent-huddle · Opus 5.5 · started 6m ago · 3 agents": unknown parts are left out, never shown as "—". */
  facts: string;
  /** A session not heard from since Huddle restarted: when it was last heard from ("last heard 18:03"); else null. */
  lastHeard: string | null;
  /** What the main agent is doing, or null. */
  activity: string | null;
  ended: boolean;
}

function getOwn<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/** The session an agent belongs to, as the tree sees it (SessionView), or null. */
export function sessionOf(state: HuddleState, key: AgentKey): SessionView | null {
  const agent = getOwn(state.agents, key);
  if (agent === undefined) return null;
  return selectTree(state, treeOptions(state)).find((v) => v.sessionId === agent.sessionId) ?? null;
}

/** The breadcrumb and status line for the session `key` belongs to; null when the agent is not in state. */
export function sessionHead(
  state: HuddleState,
  key: AgentKey,
  now: number,
  renames: ReadonlyMap<AgentKey, string> = new Map(),
): SessionHead | null {
  const view = sessionOf(state, key);
  if (view === null) return null;
  const who = selectSessionIdentity(state, view.rootKey, now, { renames });
  const main = getOwn(state.agents, view.rootKey);
  const status = sessionStatus(view);
  const stale = view.stale === true;
  const look = lookFor(status, stale);
  return {
    rootKey: view.rootKey,
    sessionId: view.sessionId,
    project: who?.project ?? null,
    projectPath: who?.projectPath ?? null,
    title: who?.label ?? UNKNOWN,
    status,
    stale,
    glyph: look.glyph,
    tone: look.tone,
    label: look.label,
    facts: [
      who?.project ?? null,
      who?.model ?? null,
      who ? startedWords(who.startedAgo) : null,
      plural(view.agentCount, 'agent'),
    ]
      .filter((p): p is string => p !== null)
      .join(' · '),
    lastHeard: stale ? `last heard ${clockTime(main?.lastEventAt ?? view.root.startedAt)}` : null,
    activity: view.root.currentActivity,
    ended: view.ended,
  };
}

export interface SessionActions {
  /** Message the main agent (the composer below its panel). */
  message: ControlState;
  pause: ControlState;
  resume: ControlState;
  /** Show Resume instead of Pause (the main agent is paused or pausing). */
  paused: boolean;
  /** Stop the run: only runs the Huddle launched (capabilities, not origin checks). */
  stop: ControlState;
  runId: string | null;
}

/** Message, Pause or Resume, and Stop for the session's main agent, each with its reason when off. */
export function sessionActions(state: HuddleState, root: AgentNode): SessionActions {
  const c = selectControls(root, state.connection, state.connection?.startedAt);
  const run = selectRunControls(root);
  return {
    message: c.message,
    pause: c.pause,
    resume: c.resume,
    paused: root.status === 'paused' || root.pausePending === true,
    stop: run.stop,
    runId: root.run?.runId ?? null,
  };
}

/** The open request of this agent the "why" block is about: its oldest open approval or question. */
export function openRequestOf(state: HuddleState, key: AgentKey): AttentionItem | null {
  return (
    state.inbox
      .filter((i) => i.agentKey === key && i.resolvedAt === null && (i.kind === 'approval' || i.kind === 'question'))
      .sort((a, b) => a.createdAt - b.createdAt)[0] ?? null
  );
}

/**
 * Why the agent is asking. Generic and true: an open request carries no policy result (the rule that held it is known
 * only once it is answered), so it never names a rule.
 */
export function whyAsking(item: AttentionItem): string | null {
  if (item.resolvedAt !== null) return null;
  if (item.kind === 'approval') return SESSION_WORDS.whyApproval;
  if (item.kind === 'question') return SESSION_WORDS.whyQuestion;
  return null;
}

/** Single command words an allow rule may stand on alone (the editor's own check says the same). */
const SINGLE_WORDS = new Set(['ls', 'dir', 'pwd', 'get-childitem', 'get-location']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

/**
 * The prefix a rule would match: the command's first line, its first two words (one for the read-only words that
 * stand alone). Null for an empty command.
 */
export function commandPrefixOf(command: string): string | null {
  const line = command.trim().split(/\r?\n/)[0]?.trim() ?? '';
  if (line === '') return null;
  const words = line.split(/\s+/);
  const first = words[0] ?? '';
  const prefix = SINGLE_WORDS.has(first.toLowerCase()) ? first : words.slice(0, 2).join(' ');
  return prefix.slice(0, 1000);
}

/** Shell characters that chain, substitute or redirect: a prefix with one of them is never prefilled. */
const SHELL_SPECIAL = /[;&|`$()<>]/;

/**
 * The editor's starting point for "Make a rule from this…" (security review, WP3). The command is the request's own
 * `toolInput.command`, which the normalizer already masked and clipped before it was stored (`sanitizeToolInput`), else
 * its one-line summary (masked too). The draft is never wider than the request:
 *  - a shell command whose prefix is a known read-only command (`isReadOnlyCommandPrefix`): allow that prefix;
 *  - any other shell command: ask, with exactly this command (`commandExact`), so switching it to allow covers only it;
 *  - a command with a chaining, substitution or redirection character, or more than one line: ask, with the part
 *    before the first such character as the prefix (nothing when that is empty);
 *  - every other tool (Write, Edit, NotebookEdit, WebFetch, WebSearch, mcp__…): ask, on the tool.
 * Always in the session's folder. The editor still checks it, warns on a wide allow, and saves only on Save.
 */
export function ruleDraftFromRequest(req: ApprovalRequest, agent: AgentNode | null, id: string): RuleDraft {
  const base = emptyRuleDraft(id);
  const folder = agent?.sessionCwd ?? agent?.cwd ?? '';
  const note = 'Made from a request in the session view.';
  const draft = (action: RuleDraft['action'], prefix: string, exact: boolean, what: string): RuleDraft => ({
    ...base,
    name: `${action === 'allow' ? 'Allow' : 'Ask before'} ${what}`.slice(0, 200),
    action,
    match: { ...base.match, tool: req.toolName, commandPrefix: prefix, folder },
    commandExact: exact && prefix !== '',
    note,
  });
  if (!SHELL_TOOLS.has(req.toolName)) return draft('ask', '', false, req.toolName);
  const raw = req.toolInput['command'];
  const command = (typeof raw === 'string' ? raw : req.summary).trim();
  const lines = command.split(/\r?\n/);
  const first = (lines[0] ?? '').trim();
  const special = first.search(SHELL_SPECIAL);
  if (lines.length > 1 || special >= 0) {
    const before = special >= 0 ? first.slice(0, special) : first;
    const prefix = commandPrefixOf(before) ?? '';
    return draft('ask', prefix, false, prefix || req.toolName);
  }
  const prefix = commandPrefixOf(first);
  if (prefix === null) return draft('ask', '', false, req.toolName);
  // `<tool> --version` is read-only only as the whole command, so its allow is exact (as the default version rules).
  if (isReadOnlyCommandPrefix(prefix)) return draft('allow', prefix, isVersionPrefix(prefix), prefix);
  const exact = first.slice(0, 1000);
  return draft('ask', exact, true, exact);
}

/**
 * The note under "Make a rule from this…" for a session started in a terminal while rules apply only to Huddle's own
 * runs; null when a rule would apply to it.
 */
export function makeRuleNote(state: HuddleState, agent: AgentNode): string | null {
  const root = getOwn(state.agents, agentKey(agent.sessionId)) ?? agent;
  if (root.origin === 'managed') return null;
  return currentSettings(state).policy.applyToAttached ? null : SESSION_WORDS.rulesOnlyLaunched;
}
