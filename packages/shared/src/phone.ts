/**
 * Phone access (M6, F26): the types the desktop and the phone page share, the limits, and the one pure selector that
 * decides what a phone may see (`selectPhoneView`).
 *
 * What the phone may see (owner decision; widened by ADR-030): live
 * sessions and their agents (display name, role, status, progress, what each is doing now, and which phone actions its
 * capabilities allow, with the reason when not), and the open inbox items with their masked one-line summaries; a held
 * question also carries its questions and options so it can be answered. Never tool input beyond the summary, never a
 * folder beyond the project name, no prompts, no history, no Ask, no task list, no queued messages. Everything the
 * selector returns is built field by field from `HuddleState`, so a field added to the state later never reaches a
 * phone by accident.
 *
 * Pure: `now` and the Huddle's start time are passed in.
 */
import { CLIP_LIMITS } from './events.js';
import type { AgentKey, AgentNode, AgentStatus, AttentionItem, AttentionKind, HuddleState } from './model.js';
import { LEAD_AGENT, sessionAtTitle, selectSessionIdentity } from './identity.js';
import { selectRunControls } from './manage.js';
import {
  approvalTextHidden,
  CONTROL_REASONS,
  isTerminal,
  selectControls,
  selectCurrentTask,
  selectProgress,
  selectStaleSessionIds,
  whereMessageLands,
  type ControlState,
} from './selectors.js';

// --- limits ---------------------------------------------------------------------------------------------------------

/** The phone listener's port when the user picks none. Private range, next to the hook port (47821). */
export const PHONE_DEFAULT_PORT = 47835;
/** Ports the user may pick: any unprivileged port. */
export const PHONE_PORT_MIN = 1024;
export const PHONE_PORT_MAX = 65535;
/** A pairing code is valid this long (owner decision: 2 minutes). */
export const PHONE_PAIR_CODE_TTL_MS = 2 * 60_000;
/** Wrong codes before the code in force stops working (owner decision: 5 tries). */
export const PHONE_PAIR_MAX_TRIES = 5;
/** Digits in a pairing code. */
export const PHONE_PAIR_CODE_DIGITS = 6;
/** The listener closes by itself after this long without a phone request (owner decision: 8 hours). */
export const PHONE_IDLE_OFF_MS = 8 * 60 * 60_000;
/** Paired phones kept at once; pairing one more is refused until one is revoked. */
export const PHONE_MAX_DEVICES = 10;
/** Longest device name kept (the phone types it when pairing). */
export const PHONE_DEVICE_NAME_MAX = 60;
/** What one phone view carries at most. */
export const PHONE_SESSIONS_MAX = 20;
export const PHONE_AGENTS_PER_SESSION_MAX = 50;
export const PHONE_INBOX_MAX = 50;
/** A held question shows at most this many questions and options per question (Claude Code asks 1-4 with 2-4). */
export const PHONE_QUESTIONS_MAX = 10;
export const PHONE_OPTIONS_MAX = 20;
/**
 * Longest typed text a phone may send (a message, or a typed "Other" answer), in UTF-16 units. Below CLIP_LIMITS.message
 * so a request still fits the listener's 4 KiB body limit with any characters (ADR-030).
 */
export const PHONE_TEXT_MAX = 1000;

// --- what a phone may do (ADR-024 approvals; ADR-030 the rest) ------------------------------------------------------

/**
 * The explicit allowlist of actions a paired phone may ask for on `POST /api/act`, besides Allow and Deny
 * (`POST /api/decide`). Anything else is refused by the listener before it reaches the core.
 */
export const PHONE_ACTION_TYPES = [
  'question.answer',
  'agent.message',
  'agent.pause',
  'agent.resume',
  'agent.stop',
] as const;
export type PhoneActionType = (typeof PHONE_ACTION_TYPES)[number];

/** A message from the phone always uses this delivery: whichever comes first, the next tool call or the turn's end. */
export const PHONE_MESSAGE_DELIVERY = 'auto' as const;

/** One question's answer from the phone: option indexes (into `PhoneQuestionView.questions[i].options`), and typed text. */
export interface PhoneAnswerPart {
  choices: number[];
  /** The user's own typed answer ("Other"); absent or blank when none. */
  other?: string;
}

export type PhoneAction =
  /** `answers[i]` answers `questions[i]` of the held question. Indexes, not labels: masked labels could be ambiguous. */
  | { type: 'question.answer'; requestId: string; answers: PhoneAnswerPart[] }
  | { type: 'agent.message'; agentKey: AgentKey; text: string }
  | { type: 'agent.pause'; agentKey: AgentKey }
  | { type: 'agent.resume'; agentKey: AgentKey }
  | { type: 'agent.stop'; agentKey: AgentKey };

/** Words for the phone-only reasons (the others are CONTROL_REASONS). */
export const PHONE_CONTROL_REASONS = {
  noStop: 'Only the main agent of a run Huddle launched can be stopped from here.',
  notInView: 'That is not on this phone any more.',
} as const;

// --- desktop state (HuddleState.phone, from phone.* events) -----------------------------------------------------------

/**
 * Why phone access changed (`phone.access_changed.reason`).
 *   user:         the user turned it on or off
 *   idle:         no phone request for PHONE_IDLE_OFF_MS (auto-off)
 *   address_gone: the chosen address is no longer one of this computer's LAN addresses
 *   failed:       the listener could not start (port taken, address not available) or stopped with an error
 *   shutdown:     the Huddle quit
 */
export type PhoneAccessReason = 'user' | 'idle' | 'address_gone' | 'failed' | 'shutdown';

/**
 * What happened to one paired phone (`phone.device_changed.change`).
 *   paired:       the phone sent the right code and got its token
 *   revoked:      the user revoked it (or retention / delete all removed it); its token stopped working at once
 *   connected:    it opened a live stream
 *   disconnected: its last live stream closed
 *   known:        the Huddle started and found it in phone-devices.json (paired before this start)
 */
export type PhoneDeviceChange = 'paired' | 'revoked' | 'connected' | 'disconnected' | 'known';

/** Why a phone was revoked (`phone.device_changed.reason`, revoked only). */
export type PhoneRevokeReason = 'user' | 'retention' | 'delete_all';

/** One paired phone as the desktop shows it. Never its token. */
export interface PhoneDeviceState {
  deviceId: string;
  /** What the phone called itself when pairing, clipped to PHONE_DEVICE_NAME_MAX. Text from the network: render as text. */
  name: string;
  /** Epoch ms it was paired, or null when unknown. */
  pairedAt: number | null;
  /** Epoch ms of its last live stream, or null when not seen since this start. */
  lastSeenAt: number | null;
  /** A live stream from it is open now. */
  connected: boolean;
}

/** `HuddleState.phone` (M6): derived by the reducer from `phone.*` events. Absent: phone access never touched. */
export interface PhoneState {
  enabled: boolean;
  /** The address phones open (`http://<ip>:<port>/`) while enabled, else null. */
  url: string | null;
  /** Epoch ms of the last access change. */
  changedAt: number;
  /** Why it last changed; null when not said. */
  reason: PhoneAccessReason | null;
  /** Paired phones, oldest pairing first. */
  devices: PhoneDeviceState[];
}

/** The user's phone settings (`UserSettings.phone`): the last chosen address and port, so Settings can offer them. */
export interface PhoneSettings {
  /** The LAN IPv4 last chosen, or null. Phone access itself always starts off (owner decision). */
  ip: string | null;
  port: number;
}

export const DEFAULT_PHONE_SETTINGS: PhoneSettings = { ip: null, port: PHONE_DEFAULT_PORT };

/** A LAN address phone access may bind (`phone.addresses` query). */
export interface PhoneAddress {
  ip: string;
  /** The network adapter's name ("Wi-Fi", "Ethernet"). */
  interfaceName: string;
}

/** `phone.pair` answers this in `CommandResult.phonePairing`: the code to show on the desktop. Never stored. */
export interface PhonePairing {
  code: string;
  expiresAt: number;
}

// --- what a phone sees ------------------------------------------------------------------------------------------------

export interface PhoneProgressView {
  /** 0..1, an estimate; null when there is nothing to base one on. */
  fraction: number | null;
  /** "3 of 5 tasks", "1 of 2 subagents", or null. */
  label: string | null;
}

/** One phone action for one agent: may it be used now, and if not, why (in words for the user). */
export interface PhoneControl {
  enabled: boolean;
  reason: string | null;
}

/** The phone actions on one agent (ADR-030), from its capabilities and its state now. */
export interface PhoneAgentControls {
  message: PhoneControl;
  pause: PhoneControl;
  resume: PhoneControl;
  stop: PhoneControl;
}

export interface PhoneAgentView {
  key: AgentKey;
  parentKey: AgentKey | null;
  /** 0 for the main agent. */
  depth: number;
  name: string;
  role: string;
  status: AgentStatus;
  progress: PhoneProgressView;
  /** What it is doing now: its current task's subject, else its running tool's one-line summary; null when nothing. */
  activity: string | null;
  controls: PhoneAgentControls;
  /** Where a phone message would land now (`whereMessageLands`, PHONE_MESSAGE_DELIVERY); null when none can be sent. */
  messageLands: string | null;
}

export interface PhoneSessionView {
  rootKey: AgentKey;
  /**
   * The session's label by the desktop rule without the prompt steps: its name or session title, else its first
   * subagent's task (the Task tool's short description, also that subagent's name here), else "<project> session",
   * else "Session HH:MM". Never a prompt the user typed.
   */
  title: string;
  /** The project folder's last segment, never the path. */
  project: string | null;
  /** Main agent first, then its subagents depth first, at most PHONE_AGENTS_PER_SESSION_MAX. */
  agents: PhoneAgentView[];
}

export interface PhoneApprovalView {
  kind: 'approval';
  id: string;
  requestId: string;
  agentKey: AgentKey;
  agentName: string;
  toolName: string;
  /** The masked one-line summary (command, path, URL) as the inbox shows it. */
  summary: string;
  /**
   * True when the summary does not show the whole command (`approvalTextHidden`, AX-01): the phone shows a note and
   * Deny only, and the server refuses Allow. A phone page treats an absent value as true.
   */
  hidden: boolean;
  createdAt: number;
  expiresAt: number | null;
}

export interface PhoneQuestionOption {
  label: string;
  description: string | null;
}

export interface PhoneQuestionPart {
  question: string;
  header: string | null;
  multiSelect: boolean;
  options: PhoneQuestionOption[];
}

/** A held question (F11) with what is needed to answer it from the phone. */
export interface PhoneQuestionView {
  kind: 'question';
  id: string;
  requestId: string;
  agentKey: AgentKey;
  agentName: string;
  title: string;
  questions: PhoneQuestionPart[];
  /** May it be answered from here now (the desktop's rule: `selectControls(...).answer`), and if not, why. */
  answer: PhoneControl;
  createdAt: number;
  expiresAt: number | null;
}

/** Any other open inbox item: shown, not actionable from the phone. */
export interface PhoneNoticeView {
  kind: Exclude<AttentionKind, 'approval' | 'question'>;
  id: string;
  agentKey: AgentKey;
  agentName: string;
  title: string;
  createdAt: number;
}

export type PhoneInboxItem = PhoneApprovalView | PhoneQuestionView | PhoneNoticeView;

export interface PhoneView {
  generatedAt: number;
  sessions: PhoneSessionView[];
  /** Approvals first (oldest first), then the other items (newest first); at most PHONE_INBOX_MAX. */
  inbox: PhoneInboxItem[];
}

export interface PhoneViewOptions {
  /** Epoch ms the Huddle started: sessions not heard from since are left out (they cannot be answered here). */
  huddleStartedAt?: number;
}

function getOwn<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/**
 * The session's name by the one rule the desktop uses (selectSessionIdentity: nickname or session title, first prompt,
 * last prompt, first subagent's task, "<project> session", "Session HH:MM"), minus the typed prompts: the phone view
 * carries no prompt text (it crosses the LAN), so a session the desktop names by its prompt is named by its first
 * subagent's task or its folder here.
 */
function sessionTitle(
  state: HuddleState,
  root: AgentNode,
  now: number,
  peers: readonly AgentKey[],
): { title: string; project: string | null } {
  const who = selectSessionIdentity(state, root.key, now, { peers, withoutPrompts: true });
  // No identity (not a main agent): the rule's own last resort, never the bare node name ("main").
  return { title: who?.label ?? sessionAtTitle(root.startedAt), project: who?.project ?? null };
}

function progressOf(state: HuddleState, key: AgentKey, now: number): PhoneProgressView {
  const p = selectProgress(state, key, now, { priors: state.priors ?? null });
  if (p === null || p.fraction === null || !Number.isFinite(p.fraction)) return { fraction: null, label: null };
  const fraction = Math.round(Math.min(1, Math.max(0, p.fraction)) * 100) / 100;
  let label: string | null = null;
  if (p.basis === 'subagents') label = `${String(p.finishedSubagents)} of ${String(p.startedSubagents)} subagents`;
  else if (p.basis === 'tasks') label = `${String(p.completedTasks)} of ${String(p.totalTasks)} tasks`;
  return { fraction, label };
}

/**
 * The broker answers whenever hooks arrive, so it reads the connection as attached (broker/outbox.ts `controlsOf`); the
 * phone lists only sessions heard from since the Huddle started, so it does the same (ADR-030).
 */
const LIVE = { status: 'attached', message: null } as const;

function control(c: ControlState): PhoneControl {
  return { enabled: c.enabled, reason: c.enabled ? null : c.reason };
}

function activityOf(node: AgentNode): string | null {
  const raw = selectCurrentTask(node)?.subject ?? node.currentActivity;
  const text = raw === null ? '' : raw.replace(/\s+/g, ' ').trim();
  if (text === '') return null;
  return text.length > CLIP_LIMITS.summary ? `${text.slice(0, CLIP_LIMITS.summary - 1)}…` : text;
}

/**
 * Stop from the phone: the main agent of a run this Huddle launched and whose process is alive (`selectRunControls`,
 * the desktop's rule; `agent.stop` refuses everything else).
 */
function stopControl(node: AgentNode): PhoneControl {
  if (isTerminal(node.status) || node.endedAt !== null) return { enabled: false, reason: CONTROL_REASONS.ended };
  if (node.kind !== 'main') return { enabled: false, reason: PHONE_CONTROL_REASONS.noStop };
  return control(selectRunControls(node).stop);
}

function controlsOf(node: AgentNode, huddleStartedAt: number | undefined): PhoneAgentControls {
  const c = selectControls(node, LIVE, huddleStartedAt);
  return { message: control(c.message), pause: control(c.pause), resume: control(c.resume), stop: stopControl(node) };
}

function agentsOf(state: HuddleState, root: AgentNode, now: number, huddleStartedAt?: number): PhoneAgentView[] {
  const out: PhoneAgentView[] = [];
  const seen = new Set<AgentKey>();
  const visit = (node: AgentNode, depth: number): void => {
    if (out.length >= PHONE_AGENTS_PER_SESSION_MAX || seen.has(node.key)) return;
    seen.add(node.key);
    const controls = controlsOf(node, huddleStartedAt);
    out.push({
      key: node.key,
      parentKey: node.parentKey,
      depth,
      name: node.kind === 'main' ? LEAD_AGENT : node.name,
      role: node.role,
      status: node.status,
      progress: progressOf(state, node.key, now),
      activity: activityOf(node),
      controls,
      messageLands: controls.message.enabled ? whereMessageLands(node, PHONE_MESSAGE_DELIVERY) : null,
    });
    const children = node.childKeys
      .map((k) => getOwn(state.agents, k))
      .filter((c): c is AgentNode => c !== undefined && c.role !== '')
      .sort((a, b) => a.startedAt - b.startedAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    for (const child of children) visit(child, depth + 1);
  };
  visit(root, 0);
  return out;
}

/**
 * What a paired phone sees now (F26). Live sessions only: not ended, and (with `huddleStartedAt`) heard from since the
 * Huddle started. Agents carry name, role, status and the estimated progress; the inbox carries the open items of
 * those sessions, approvals with their masked summary and tool name, everything else with its title only.
 * Expired approvals (past `expiresAt`) are left out. Pure.
 */
export function selectPhoneView(state: HuddleState, now: number, opts?: PhoneViewOptions): PhoneView {
  const stale = selectStaleSessionIds(
    state,
    opts?.huddleStartedAt !== undefined ? { huddleStartedAt: opts.huddleStartedAt } : undefined,
  );
  const roots = state.rootKeys
    .map((k) => getOwn(state.agents, k))
    .filter((r): r is AgentNode => r?.kind === 'main' && r.endedAt === null && !stale.has(r.sessionId))
    .sort((a, b) => b.lastEventAt - a.lastEventAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .slice(0, PHONE_SESSIONS_MAX);
  const live = new Set(roots.map((r) => r.sessionId));
  const titles = new Map<AgentKey, string>();
  const peers = roots.map((r) => r.key);
  const sessions: PhoneSessionView[] = roots.map((root) => {
    const { title, project } = sessionTitle(state, root, now, peers);
    titles.set(root.key, title);
    return { rootKey: root.key, title, project, agents: agentsOf(state, root, now, opts?.huddleStartedAt) };
  });

  const nameOf = (key: AgentKey): string | null => {
    const node = getOwn(state.agents, key);
    if (node === undefined) return null;
    return node.kind === 'main' ? (titles.get(node.key) ?? node.name) : node.name;
  };
  const approvals: PhoneApprovalView[] = [];
  const questions: PhoneQuestionView[] = [];
  const notices: PhoneNoticeView[] = [];
  for (const item of state.inbox) {
    if (item.resolvedAt !== null || item.dismissed === true) continue;
    const node = getOwn(state.agents, item.agentKey);
    if (node === undefined || !live.has(node.sessionId)) continue;
    const agentName = nameOf(item.agentKey) ?? node.name;
    if (item.kind === 'approval') {
      const req = item.approval;
      if (req === undefined || isTerminal(node.status)) continue;
      if (req.expiresAt !== null && req.expiresAt <= now) continue;
      approvals.push({
        kind: 'approval',
        id: item.id,
        requestId: req.requestId,
        agentKey: item.agentKey,
        agentName,
        toolName: req.toolName,
        summary: req.summary,
        hidden: approvalTextHidden(req),
        createdAt: item.createdAt,
        expiresAt: req.expiresAt,
      });
      continue;
    }
    if (item.kind === 'question') {
      const q = questionOf(item, node, agentName, opts?.huddleStartedAt);
      if (q !== null && !isTerminal(node.status)) questions.push(q);
      continue;
    }
    notices.push({
      kind: item.kind,
      id: item.id,
      agentKey: item.agentKey,
      agentName,
      title: item.title,
      createdAt: item.createdAt,
    });
  }
  const oldestFirst = (a: { createdAt: number; id: string }, b: { createdAt: number; id: string }) =>
    a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  approvals.sort(oldestFirst);
  questions.sort(oldestFirst);
  notices.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    generatedAt: now,
    sessions,
    inbox: [...approvals, ...questions, ...notices].slice(0, PHONE_INBOX_MAX),
  };
}

function questionOf(
  item: AttentionItem,
  node: AgentNode,
  agentName: string,
  huddleStartedAt: number | undefined,
): PhoneQuestionView | null {
  const req = item.question;
  if (req === undefined) return null;
  // A question cut short here could not be answered in full: it goes to the terminal.
  const cut =
    req.questions.length > PHONE_QUESTIONS_MAX || req.questions.some((q) => q.options.length > PHONE_OPTIONS_MAX);
  return {
    kind: 'question',
    id: item.id,
    requestId: req.requestId,
    agentKey: item.agentKey,
    agentName,
    title: item.title,
    questions: req.questions.slice(0, PHONE_QUESTIONS_MAX).map((q) => ({
      question: q.question,
      header: q.header ?? null,
      multiSelect: q.multiSelect,
      options: q.options
        .slice(0, PHONE_OPTIONS_MAX)
        .map((o) => ({ label: o.label, description: o.description ?? null })),
    })),
    answer: cut
      ? { enabled: false, reason: CONTROL_REASONS.noAnswer }
      : control(selectControls(node, LIVE, huddleStartedAt, item).answer),
    createdAt: item.createdAt,
    expiresAt: req.expiresAt ?? null,
  };
}

/** The open question with this request id in the phone view, or null. Pure. */
export function phoneViewQuestion(view: PhoneView, requestId: string): PhoneQuestionView | null {
  for (const i of view.inbox) if (i.kind === 'question' && i.requestId === requestId) return i;
  return null;
}

/** The agent with this key in the phone view, or null. Pure. */
export function phoneViewAgent(view: PhoneView, key: AgentKey): PhoneAgentView | null {
  for (const s of view.sessions) for (const a of s.agents) if (a.key === key) return a;
  return null;
}

/** True when the phone view lists this approval request as open (the phone may only decide those). Pure. */
export function phoneViewHasApproval(view: PhoneView, requestId: string): boolean {
  return view.inbox.some((i) => i.kind === 'approval' && i.requestId === requestId);
}
