/**
 * The phone view as it arrives over the network (`GET /api/state`, `event: view` on `/api/stream`), checked field by
 * field before the page uses it. The page is served by the core it talks to, but the JSON is still parsed as
 * untrusted: anything of the wrong shape is dropped (an item) or refused (the whole view), never thrown on. The
 * objects returned are built here, so unknown fields never reach the page. Pure.
 */
import type {
  AgentStatus,
  PhoneAgentControls,
  PhoneAgentView,
  PhoneApprovalView,
  PhoneControl,
  PhoneInboxItem,
  PhoneNoticeView,
  PhoneQuestionPart,
  PhoneQuestionView,
  PhoneSessionView,
  PhoneView,
} from '@huddle/shared';

type Rec = Record<string, unknown>;

const NOTICE_KINDS: ReadonlySet<string> = new Set<PhoneNoticeView['kind']>([
  'stuck',
  'loop',
  'file_conflict',
  'budget',
  'context_high',
  'error',
  'finished',
  'role_drift',
]);

/** Longest string kept from the network (the core clips far shorter; this only bounds a broken answer). */
const MAX_TEXT = 2000;
const MAX_ITEMS = 200;

function isRec(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function str(v: unknown): string | null {
  return typeof v === 'string' ? v.slice(0, MAX_TEXT) : null;
}
function strOrNull(v: unknown): string | null | undefined {
  if (v === null) return null;
  return typeof v === 'string' ? v.slice(0, MAX_TEXT) : undefined;
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function numOrNull(v: unknown): number | null | undefined {
  if (v === null) return null;
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
function list(v: unknown): unknown[] {
  return Array.isArray(v) ? v.slice(0, MAX_ITEMS) : [];
}

/** Said when a control arrives in a shape this page does not know (a newer or broken answer): never offered. */
export const CONTROL_UNKNOWN = 'Not available from this phone right now.';

function controlOf(v: unknown): PhoneControl {
  if (!isRec(v) || typeof v['enabled'] !== 'boolean') return { enabled: false, reason: CONTROL_UNKNOWN };
  const reason = strOrNull(v['reason']) ?? null;
  return v['enabled'] ? { enabled: true, reason: null } : { enabled: false, reason: reason ?? CONTROL_UNKNOWN };
}

function controlsOf(v: unknown): PhoneAgentControls {
  const r = isRec(v) ? v : {};
  return {
    message: controlOf(r['message']),
    pause: controlOf(r['pause']),
    resume: controlOf(r['resume']),
    stop: controlOf(r['stop']),
  };
}

function agent(v: unknown): PhoneAgentView | null {
  if (!isRec(v)) return null;
  const key = str(v['key']);
  const parentKey = strOrNull(v['parentKey']);
  const depth = num(v['depth']);
  const name = str(v['name']);
  const role = str(v['role']);
  const status = str(v['status']);
  const p = v['progress'];
  if (key === null || parentKey === undefined || depth === null || name === null || role === null) return null;
  // A status this page does not know (a newer core) is kept as is; the words fall back to a neutral look.
  if (status === null) return null;
  let fraction: number | null = null;
  let label: string | null = null;
  if (isRec(p)) {
    const f = numOrNull(p['fraction']);
    fraction = f === undefined || f === null ? null : Math.min(1, Math.max(0, f));
    label = strOrNull(p['label']) ?? null;
  }
  return {
    key: key,
    parentKey: parentKey,
    depth: Math.max(0, Math.min(50, Math.floor(depth))),
    name,
    role,
    status: status as AgentStatus,
    progress: { fraction, label },
    activity: strOrNull(v['activity']) ?? null,
    controls: controlsOf(v['controls']),
    messageLands: strOrNull(v['messageLands']) ?? null,
  };
}

function session(v: unknown): PhoneSessionView | null {
  if (!isRec(v)) return null;
  const rootKey = str(v['rootKey']);
  const title = str(v['title']);
  const project = strOrNull(v['project']);
  if (rootKey === null || title === null || project === undefined) return null;
  const agents = list(v['agents'])
    .map(agent)
    .filter((a): a is PhoneAgentView => a !== null);
  return { rootKey: rootKey, title, project, agents };
}

function inboxItem(v: unknown): PhoneInboxItem | null {
  if (!isRec(v)) return null;
  const kind = str(v['kind']);
  const id = str(v['id']);
  const agentKey = str(v['agentKey']);
  const agentName = str(v['agentName']);
  const createdAt = num(v['createdAt']);
  if (kind === null || id === null || agentKey === null || agentName === null || createdAt === null) return null;
  if (kind === 'approval') {
    const requestId = str(v['requestId']);
    const toolName = str(v['toolName']);
    const summary = str(v['summary']);
    const expiresAt = numOrNull(v['expiresAt']);
    if (requestId === null || requestId === '' || toolName === null || summary === null || expiresAt === undefined) {
      return null;
    }
    const item: PhoneApprovalView = {
      kind: 'approval',
      id,
      requestId,
      agentKey: agentKey,
      agentName,
      toolName,
      summary,
      // Only an explicit false shows Allow (AX-01): an older or broken view errs towards the note and Deny only.
      hidden: v['hidden'] !== false,
      createdAt,
      expiresAt,
    };
    return item;
  }
  const title = str(v['title']);
  if (kind === 'question') return questionItem(v, { id, agentKey, agentName, createdAt, title });
  if (title === null || !NOTICE_KINDS.has(kind)) return null;
  const notice: PhoneNoticeView = {
    kind: kind as PhoneNoticeView['kind'],
    id,
    agentKey: agentKey,
    agentName,
    title,
    createdAt,
  };
  return notice;
}

function questionPart(v: unknown): PhoneQuestionPart | null {
  if (!isRec(v)) return null;
  const question = str(v['question']);
  const header = strOrNull(v['header']);
  if (question === null || header === undefined || typeof v['multiSelect'] !== 'boolean') return null;
  const options: PhoneQuestionPart['options'] = [];
  for (const o of list(v['options'])) {
    if (!isRec(o)) return null;
    const label = str(o['label']);
    const description = strOrNull(o['description']);
    // A broken option would shift the indexes the answer is sent by: refuse the whole question.
    if (label === null || description === undefined) return null;
    options.push({ label, description });
  }
  if (options.length === 0) return null;
  return { question, header, multiSelect: v['multiSelect'], options };
}

function questionItem(
  v: Rec,
  base: { id: string; agentKey: string; agentName: string; createdAt: number; title: string | null },
): PhoneQuestionView | null {
  const requestId = str(v['requestId']);
  const expiresAt = numOrNull(v['expiresAt']);
  if (requestId === null || requestId === '' || base.title === null || expiresAt === undefined) return null;
  const questions: PhoneQuestionPart[] = [];
  for (const q of list(v['questions'])) {
    const part = questionPart(q);
    if (part === null) return null;
    questions.push(part);
  }
  if (questions.length === 0) return null;
  return {
    kind: 'question',
    id: base.id,
    requestId,
    agentKey: base.agentKey,
    agentName: base.agentName,
    title: base.title,
    questions,
    answer: controlOf(v['answer']),
    createdAt: base.createdAt,
    expiresAt,
  };
}

/** The phone view from untrusted JSON, or null when it is not one. Items of the wrong shape are left out. */
export function parsePhoneView(v: unknown): PhoneView | null {
  if (!isRec(v)) return null;
  const generatedAt = num(v['generatedAt']);
  if (generatedAt === null || !Array.isArray(v['sessions']) || !Array.isArray(v['inbox'])) return null;
  return {
    generatedAt,
    sessions: list(v['sessions'])
      .map(session)
      .filter((s): s is PhoneSessionView => s !== null),
    inbox: list(v['inbox'])
      .map(inboxItem)
      .filter((i): i is PhoneInboxItem => i !== null),
  };
}

/** `{deviceId, token}` from the pairing answer, or null. The token must look like one the server accepts. */
export function parsePairAnswer(v: unknown): { deviceId: string; token: string } | null {
  if (!isRec(v)) return null;
  const deviceId = str(v['deviceId']);
  const token = str(v['token']);
  if (deviceId === null || token === null || !/^[A-Za-z0-9_-]{1,200}$/.test(token)) return null;
  return { deviceId, token };
}

/** The `error` sentence of a refusal, or null. */
export function errorOf(v: unknown): string | null {
  if (!isRec(v)) return null;
  const e = str(v['error']);
  return e === null || e.trim() === '' ? null : e.slice(0, 300);
}
