/**
 * Telling sessions apart (F2 Identity). Every main agent is called "main" unless the user named it or Claude Code sent
 * a session title, so two cards in the widget looked the same. `selectSessionIdentity` names each session by one rule
 * used everywhere (nickname or session title → first prompt → last prompt → first subagent's task → "<project> session"
 * → "Session <HH:MM>"), and gives the project it works in, what the user last asked it (topic), a short model label
 * and how long ago it started. Pure: the clock is passed in.
 *
 * One exception: the phone view (phone.ts) skips the prompt steps (`withoutPrompts`), because it crosses the LAN and
 * carries no prompt text; its rule is nickname or session title → first subagent's task → "<project> session" →
 * "Session <HH:MM>". The subagent's task step stays on there: it is the short description the parent agent gave the
 * Task tool (`handoff.title`, also that subagent's display name, which the phone lists anyway), never the user's typed
 * prompt and never the brief handed to the subagent.
 *
 * Every string here may come from an agent, a hook or a path on disk: render it as text.
 */
import type { AgentKey, AgentNode, HuddleState } from './model.js';

/** Longest topic kept on a main agent (`AgentNode.lastPrompt`), in characters, ellipsis included. */
export const TOPIC_MAX = 120;

/** The title of a main agent nobody named (the reducer's default name). */
export const DEFAULT_MAIN_NAME = 'main';

function getOwn<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/** Collapse whitespace and clip to `max` characters, ending in an ellipsis when cut. */
function clipLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/**
 * What a typed prompt is about, in one line: its first non-empty line, whitespace collapsed, clipped to TOPIC_MAX.
 * Null for an empty prompt and for one that opens with a tag (`<task-notification>`, `<agent-message …>`,
 * `<browser_instruction>`): those are written by Claude Code or another agent, not by the user.
 */
export function promptTopic(text: string): string | null {
  const trimmed = text.trimStart();
  if (trimmed === '' || trimmed.startsWith('<')) return null;
  const line = trimmed.split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
  const topic = clipLine(line, TOPIC_MAX);
  return topic === '' ? null : topic;
}

/**
 * Tag names Claude Code itself writes into a typed prompt: pasted text, slash commands and their output, `!` shell
 * input and output, reminders, hook output. Only these are stripped; any other tag is text.
 */
const CLAUDE_CODE_TAGS: ReadonlySet<string> = new Set([
  'command-name',
  'command-message',
  'command-args',
  'command-contents',
  'local-command-stdout',
  'local-command-stderr',
  'local-command-caveat',
  'bash-input',
  'bash-stdout',
  'bash-stderr',
  'system-reminder',
  'user-prompt-submit-hook',
]);
/** `pasted_content`, `pasted_content_2`: nobody types these, so even an unclosed one is a block wherever it is. */
const PASTED = /^pasted_content(?:_\d+)?$/;
/** Prompts that open with these are written by Claude Code or another agent, not by the user: no title. */
const HARNESS_TAGS: ReadonlySet<string> = new Set(['task-notification', 'agent-message', 'browser_instruction']);
/** Bidi embeddings, overrides and isolates, and zero-width characters: dropped from a title. */
const INVISIBLE_CHARS = /[\u202A-\u202E\u2066-\u2069\u200B-\u200D\u2060\uFEFF]/g;
/** Most reruns for unclosed tags in the middle of a line (each turns one into text). */
const MAX_PROSE_RERUNS = 20;

function isNameChar(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 45 ||
    code === 95
  );
}

function isClaudeCodeTag(name: string): boolean {
  return CLAUDE_CODE_TAGS.has(name) || PASTED.test(name);
}

/** The lower-cased name after `<` or `</` at `at`, read in one pass; '' when there is none. */
function tagNameAt(text: string, at: number): { name: string; close: boolean; nameEnd: number } {
  let j = at + 1;
  const close = text.charCodeAt(j) === 47; // '/'
  if (close) j += 1;
  const start = j;
  while (j < text.length && isNameChar(text.charCodeAt(j))) j += 1;
  return { name: text.slice(start, j).toLowerCase(), close, nameEnd: j };
}

interface TagToken {
  name: string;
  close: boolean;
  selfClose: boolean;
  /** Index just after the `>`; null when the tag is cut (no `>` before the next `<` or the end). */
  end: number | null;
}

/** The tag at `at` (`text[at]` is `<`), scanned once: name, then up to `>` with no `<` in between. Linear. */
function tagAt(text: string, at: number): TagToken | null {
  const { name, close, nameEnd } = tagNameAt(text, at);
  if (name === '') return null;
  let k = nameEnd;
  while (k < text.length && text[k] !== '>' && text[k] !== '<') k += 1;
  if (text[k] !== '>') return { name, close, selfClose: false, end: null };
  return { name, close, selfClose: !close && text[k - 1] === '/', end: k + 1 };
}

/** Only whitespace so far on the output's current line. */
function atLineStart(out: string): boolean {
  return out.slice(out.lastIndexOf('\n') + 1).trim() === '';
}

interface Opened {
  name: string;
  at: number;
  outLength: number;
  lineStart: boolean;
}

/**
 * One pass that removes Claude Code tag blocks. `prose`: positions of unclosed tags to keep as text. Returns the text,
 * or the position of an unclosed tag in mid-line that should be text instead (the caller runs again).
 */
function stripOnce(text: string, prose: ReadonlySet<number>): { out: string } | { retry: number } {
  let out = '';
  const stack: Opened[] = [];
  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt < 0) {
      if (stack.length === 0) out += text.slice(i);
      break;
    }
    if (stack.length === 0) out += text.slice(i, lt);
    const tag = tagAt(text, lt);
    const known = tag !== null && isClaudeCodeTag(tag.name) && !prose.has(lt);
    if (tag === null || !known) {
      if (stack.length === 0) out += '<';
      i = lt + 1;
      continue;
    }
    if (tag.end === null) {
      // Cut by a clip: a block to the end at the start of a line (or any pasted block); text in mid-line.
      if (tag.close || stack.length > 0) {
        if (stack.length === 0) out += '<';
        i = lt + 1;
        continue;
      }
      if (PASTED.test(tag.name) || atLineStart(out)) return { out };
      return { retry: lt };
    }
    if (tag.selfClose) {
      if (stack.length === 0) out += ' ';
      i = tag.end;
      continue;
    }
    if (!tag.close) {
      stack.push({ name: tag.name, at: lt, outLength: out.length, lineStart: atLineStart(out) });
      i = tag.end;
      continue;
    }
    // A closing tag: closes the innermost open block of that name (and any opened inside it).
    let open = -1;
    for (let s = stack.length - 1; s >= 0; s--) {
      if (stack[s]?.name === tag.name) {
        open = s;
        break;
      }
    }
    if (open >= 0) {
      stack.length = open;
      if (stack.length === 0) out += ' ';
    } else if (stack.length === 0) {
      // A closing tag with no opening one: dropped at the start of a line, text in mid-line.
      out += atLineStart(out) ? ' ' : text.slice(lt, tag.end);
    }
    i = tag.end;
  }
  const outer = stack[0];
  if (outer === undefined) return { out };
  if (PASTED.test(outer.name) || outer.lineStart) return { out: out.slice(0, outer.outLength) };
  return { retry: outer.at };
}

/**
 * Claude Code's tag blocks removed from a prompt (see `cleanPromptTitle`). Linear per pass; at most
 * MAX_PROSE_RERUNS + 1 passes.
 */
function stripClaudeCodeBlocks(text: string): string {
  const prose = new Set<number>();
  for (let run = 0; run <= MAX_PROSE_RERUNS; run++) {
    const result = stripOnce(text, prose);
    if ('out' in result) return result.out;
    prose.add(result.retry);
  }
  // Too many unclosed tags in prose: give up on them and cut at the last one.
  const result = stripOnce(text, new Set());
  return 'out' in result ? result.out : text.slice(0, result.retry);
}

/**
 * A prompt as a readable title (sidebar session titles, History rows, run reports, the Ask context). Rules:
 *  - Bidi controls and zero-width characters are dropped.
 *  - Only Claude Code's own tags are stripped (`pasted_content…`, `command-name`, `command-message`, `command-args`,
 *    `command-contents`, `local-command-…`, `bash-…`, `system-reminder`, `user-prompt-submit-hook`): a closed block
 *    goes with everything in it (nested blocks too, same name or not) and leaves a space; a self-closing one goes.
 *  - An unclosed one (or one cut by a clip) is a block to the end only when it starts a line, or for pasted content;
 *    in mid-line it is text ("explain what <command-name> does" stays as typed). A closing tag with no opening one is
 *    dropped at the start of a line, text in mid-line.
 *  - Then the first non-empty line, whitespace collapsed, clipped to TOPIC_MAX.
 * Null when nothing is left, or when the prompt opens with a harness tag (`<task-notification>`, `<agent-message>`,
 * `<browser_instruction>`). Any other tag is text (`<div> not centered`). Pure and linear; render the result as text.
 */
export function cleanPromptTitle(text: string | null | undefined): string | null {
  if (text === null || text === undefined) return null;
  const visible = text.replace(INVISIBLE_CHARS, '');
  const first = visible.trimStart();
  if (first.startsWith('<') && HARNESS_TAGS.has(tagNameAt(first, 0).name)) return null;
  const line = stripClaudeCodeBlocks(visible)
    .split(/\r?\n/)
    .find((l) => l.trim() !== '');
  if (line === undefined) return null;
  const title = clipLine(line, TOPIC_MAX);
  return title === '' ? null : title;
}

/**
 * What a session is about, one rule for History rows, run reports and the Ask context: the last typed prompt,
 * cleaned (`cleanPromptTitle`), else the first one when the last is only Claude Code tags. Null when neither says
 * anything.
 */
export function sessionTopic(
  lastPrompt: string | null | undefined,
  firstPrompt: string | null | undefined,
): string | null {
  return cleanPromptTitle(lastPrompt) ?? cleanPromptTitle(firstPrompt);
}

/** Last folder of a path, Windows or POSIX separators, trailing separators ignored. Null when there is none. */
export function pathBasename(path: string | null | undefined): string | null {
  if (path === null || path === undefined) return null;
  const parts = path.split(/[\\/]+/).filter((p) => p.trim() !== '');
  return parts[parts.length - 1] ?? null;
}

const FAMILY = /^(opus|sonnet|haiku|fable)$/i;

function capital(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/**
 * A short model label: "claude-opus-5-5" → "Opus 5.5", "claude-sonnet-4-20250514" → "Sonnet 4",
 * "claude-3-5-haiku-20241022" → "Haiku 3.5", "opus" → "Opus", a `[1m]` suffix → "· 1M". Anything else is returned as
 * given (trimmed); null or empty → null.
 */
export function modelLabel(model: string | null | undefined): string | null {
  if (model === null || model === undefined) return null;
  let id = model.trim();
  if (id === '') return null;
  let suffix = '';
  const window = /\[(\d+)([km])\]$/i.exec(id);
  if (window?.[1] !== undefined && window[2] !== undefined) {
    suffix = ` · ${window[1]}${window[2].toUpperCase()}`;
    id = id.slice(0, window.index).trim();
  }
  let base: string | null = null;
  const modern = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/i.exec(id);
  const legacy = /^claude-(\d+)(?:-(\d{1,2}))?-([a-z]+)(?:-\d{8})?$/i.exec(id);
  if (modern?.[1] !== undefined && modern[2] !== undefined) {
    base = `${capital(modern[1])} ${modern[2]}${modern[3] !== undefined ? `.${modern[3]}` : ''}`;
  } else if (legacy?.[1] !== undefined && legacy[3] !== undefined) {
    base = `${capital(legacy[3])} ${legacy[1]}${legacy[2] !== undefined ? `.${legacy[2]}` : ''}`;
  } else if (FAMILY.test(id)) {
    base = capital(id);
  }
  if (base === null) return suffix === '' ? id : `${id}${suffix}`;
  return `${base}${suffix}`;
}

/** How long ago, short: "just now", "3m", "2h", "yesterday", "4d". A time in the future reads "just now". */
export function startedAgo(startedAt: number, now: number): string {
  const ms = now - startedAt;
  if (!Number.isFinite(ms) || ms < 60_000) return 'just now';
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${String(min)}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${String(h)}h`;
  if (h < 48) return 'yesterday';
  return `${String(Math.floor(h / 24))}d`;
}

/** "started 3m ago", "started yesterday", "started just now". */
export function startedWords(ago: string): string {
  return ago === 'yesterday' || ago === 'just now' ? `started ${ago}` : `started ${ago} ago`;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Local wall-clock HH:MM. */
function clock(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export interface SessionIdentity {
  /**
   * The session's name, one rule everywhere (sidebar, session header, widget card, tree rows, palette, toasts):
   * nickname or Claude Code session title → first typed prompt (cleaned) → last typed prompt → the first subagent's
   * task → "<project folder> session" → "Session <HH:MM>" (its start time). Never the raw "main" or "Untitled session".
   */
  title: string;
  /**
   * Where the title came from: the user or Claude Code named it, a typed prompt, a subagent's task, the project
   * folder, or nothing known (the start time).
   */
  titleFrom: 'name' | 'prompt' | 'task' | 'project' | 'default';
  /**
   * Set only when another session has the same title and neither has a topic: the start time ("14:02"), or the
   * start of the session id when they also started in the same minute.
   */
  disambiguator: string | null;
  /** `title`, plus " · <disambiguator>" when there is one. Use it wherever one string names the session. */
  label: string;
  /** Folder name of the project (the repository for a run in a worktree); null when unknown. */
  project: string | null;
  /** The full path behind `project`, for a tooltip; null when unknown. */
  projectPath: string | null;
  /** The session runs in a git worktree the Huddle made (M4, F20). */
  worktree: boolean;
  /** What the user last asked (`lastPrompt`); null when none, or when it is the same text as the title. */
  topic: string | null;
  /** Short model label ("Opus 5.5"); null when unknown. */
  model: string | null;
  /** How long ago the session started: "3m", "2h", "yesterday". */
  startedAgo: string;
  startedAt: number;
}

export interface IdentityOptions {
  /** The user's pending renames (the renderer's optimistic names); they win over the core's name. */
  renames?: ReadonlyMap<AgentKey, string>;
  /** Sessions to tell this one apart from; default every session in state. */
  peers?: readonly AgentKey[];
  /**
   * Skip the typed prompts (the phone, which sends its view over the LAN and by design carries no prompt text): the
   * rule goes nickname or session title → first subagent's task → "<project> session" → "Session HH:MM", no topic.
   * The subagent's task is still used: it is the Task tool's short description written by the agent (that subagent's
   * own display name), not text the user typed, and not the brief.
   */
  withoutPrompts?: boolean;
}

/** How a session's main agent is labelled where it is one agent among others (its tree row, its panel). */
export const LEAD_AGENT = 'Lead agent';

/** "Session 14:02": the last resort, when nothing about a session is known but when it started. */
export function sessionAtTitle(startedAt: number): string {
  return `Session ${clock(startedAt)}`;
}

interface BaseIdentity {
  title: string;
  titleFrom: SessionIdentity['titleFrom'];
  project: string | null;
  projectPath: string | null;
  worktree: boolean;
  topic: string | null;
}

/** The folder a session works in: a worktree run's repository (or its template's folder), else sessionCwd, else cwd. */
function projectPathOf(state: HuddleState, root: AgentNode): string | null {
  const wt = root.run?.worktree ?? null;
  let projectPath: string | null = null;
  if (wt !== null) {
    const templateId = root.run?.templateId ?? null;
    const template = templateId !== null ? state.templates?.find((t) => t.id === templateId) : undefined;
    projectPath = wt.repoRoot ?? template?.cwd ?? null;
  }
  if (projectPath === null || projectPath.trim() === '') projectPath = root.sessionCwd ?? root.cwd ?? null;
  if (projectPath !== null && projectPath.trim() === '') projectPath = null;
  return projectPath;
}

/**
 * The project folder of a session (the same path as `SessionIdentity.projectPath`): a run in a worktree the Huddle
 * made → its repository; else the folder the session started in; else its cwd. Null when unknown or not a main agent.
 */
export function selectProjectPath(state: HuddleState, rootKey: AgentKey): string | null {
  const root = getOwn(state.agents, rootKey);
  if (root === undefined || root.kind !== 'main') return null;
  return projectPathOf(state, root);
}

/** The task the session handed its first subagent (the Task tool's description), cleaned; null when none. */
function firstSubagentTask(state: HuddleState, root: AgentNode): string | null {
  for (const key of root.childKeys) {
    const child = getOwn(state.agents, key);
    if (child === undefined || child.kind === 'main') continue;
    const task = cleanPromptTitle(child.handoff?.title);
    if (task !== null) return task;
  }
  return null;
}

function baseIdentity(state: HuddleState, root: AgentNode, opts: IdentityOptions | undefined): BaseIdentity {
  const renames = opts?.renames;
  const wt = root.run?.worktree ?? null;
  const projectPath = projectPathOf(state, root);
  const project = pathBasename(projectPath);

  const pending = renames?.get(root.key);
  const own = root.name.trim() !== '' && root.name !== DEFAULT_MAIN_NAME ? root.name : null;
  const named = pending !== undefined && pending.trim() !== '' ? pending.trim() : own;
  const prompts = opts?.withoutPrompts !== true;
  const prompt =
    named === null && prompts ? (cleanPromptTitle(root.firstPrompt) ?? cleanPromptTitle(root.lastPrompt)) : null;
  const task = named === null && prompt === null ? firstSubagentTask(state, root) : null;
  let title: string;
  let titleFrom: SessionIdentity['titleFrom'];
  if (named !== null) [title, titleFrom] = [named, 'name'];
  else if (prompt !== null) [title, titleFrom] = [prompt, 'prompt'];
  else if (task !== null) [title, titleFrom] = [task, 'task'];
  else if (project !== null) [title, titleFrom] = [`${project} session`, 'project'];
  else [title, titleFrom] = [sessionAtTitle(root.startedAt), 'default'];

  const last = prompts ? (root.lastPrompt ?? null) : null;
  const topic = last === null || last.trim() === '' || last === title ? null : last;
  return { title, titleFrom, project, projectPath, worktree: wt !== null, topic };
}

/**
 * Who a session is, for its card, its tree row, the detail header and anything else that names it. Null when
 * `rootKey` is not a main agent in state.
 */
export function selectSessionIdentity(
  state: HuddleState,
  rootKey: AgentKey,
  now: number,
  opts?: IdentityOptions,
): SessionIdentity | null {
  const root = getOwn(state.agents, rootKey);
  if (root === undefined || root.kind !== 'main') return null;
  const base = baseIdentity(state, root, opts);
  const disambiguator = disambiguate(state, root, base, opts);
  return {
    ...base,
    disambiguator,
    label: disambiguator === null ? base.title : `${base.title} · ${disambiguator}`,
    model: modelLabel(root.model),
    startedAgo: startedAgo(root.startedAt, now),
    startedAt: root.startedAt,
  };
}

function disambiguate(state: HuddleState, root: AgentNode, base: BaseIdentity, opts?: IdentityOptions): string | null {
  if (base.topic !== null) return null;
  const twins: AgentNode[] = [];
  for (const key of opts?.peers ?? state.rootKeys) {
    if (key === root.key) continue;
    const peer = getOwn(state.agents, key);
    if (peer === undefined || peer.kind !== 'main') continue;
    const other = baseIdentity(state, peer, opts);
    if (other.topic === null && other.title === base.title) twins.push(peer);
  }
  if (twins.length === 0) return null;
  const at = clock(root.startedAt);
  if (twins.some((t) => clock(t.startedAt) === at)) return `#${root.sessionId.slice(0, 6)}`;
  return at;
}

/**
 * The one string that names an agent: a main agent's session label (as `selectSessionIdentity`), a subagent's pending
 * rename or name. Null when the agent is not in state.
 */
export function selectAgentLabel(state: HuddleState, key: AgentKey, opts?: IdentityOptions): string | null {
  const node = getOwn(state.agents, key);
  if (node === undefined) return null;
  if (node.kind === 'main') return selectSessionIdentity(state, key, node.startedAt, opts)?.label ?? node.name;
  return opts?.renames?.get(key) ?? node.name;
}
