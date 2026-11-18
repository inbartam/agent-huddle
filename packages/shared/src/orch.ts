/**
 * The Huddle as orchestrator (F28 Skills, F29 Tasks): the pure parts both the core and the renderer use. No clock, no
 * I/O: the core reads and writes the files, the reducer keeps the task list, and these functions only decide.
 *
 * Known projects (F28, F29): the folders a skill may be written into and a task may run in. They come from what the
 * Huddle has already seen, never from a typed path: the project folder of every session in the state
 * (`selectProjectPath`), the folder of every saved template, and the folder of every task (each was a known project
 * when the task was saved). Folders too broad to be one project (`isTooBroadFolder`: a drive root, a home folder,
 * Documents...) are left out, so `<home>/.claude/skills` (the user's own skills folder) is never offered as a target.
 *
 * Skill files (F28): `SKILL.md` with a small YAML frontmatter (`name`, `description`) and the instructions below it.
 * The parser reads only `key: value` lines (plain, single- or double-quoted, and `>` / `|` blocks) and treats every
 * value as untrusted text: it is shown as text, never run, never followed.
 */
import type { AgentKey, HuddleState } from './model.js';
import { selectProjectPath, pathBasename } from './identity.js';
import { isTooBroadFolder, projectKey } from './projects.js';

// ---------------------------------------------------------------------------
// Known projects
// ---------------------------------------------------------------------------

export interface KnownProject {
  /** `projectKey` of the folder (compare by this). */
  key: string;
  /** The folder as a session, template or task reported it. */
  path: string;
  /** Its last segment, for lists. */
  name: string;
}

/**
 * At most this many known projects are listed and searched for skills (`skills.list`). A display cap only: whether a
 * task may run in a folder, or a skill be read or written there, is always checked against the full list.
 */
export const MAX_KNOWN_PROJECTS = 50;

/**
 * Every folder the Huddle may write a skill into or run a task in, sorted by name then path. One per `projectKey`; the
 * first path seen wins (sessions, then templates, then tasks). Not capped: slice to `MAX_KNOWN_PROJECTS` only for a
 * list shown to the user, never before `findKnownProject`.
 */
export function selectKnownProjects(state: HuddleState): KnownProject[] {
  const seen = new Map<string, KnownProject>();
  const add = (path: string | null | undefined) => {
    if (typeof path !== 'string') return;
    const key = projectKey(path);
    if (key === null || seen.has(key) || isTooBroadFolder(key)) return;
    seen.set(key, { key, path: path.trim(), name: pathBasename(path) ?? path.trim() });
  };
  for (const rootKey of state.rootKeys) add(selectProjectPath(state, rootKey));
  for (const t of state.templates ?? []) add(t.cwd);
  for (const t of state.huddleTasks ?? []) add(t.projectPath);
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
}

/** The known project with this folder (compared by `projectKey`), or null: the folder is not one the Huddle knows. */
export function findKnownProject(
  projects: readonly KnownProject[],
  path: string | null | undefined,
): KnownProject | null {
  const key = projectKey(path);
  if (key === null) return null;
  return projects.find((p) => p.key === key) ?? null;
}

// ---------------------------------------------------------------------------
// Skills (F28)
// ---------------------------------------------------------------------------

/**
 * A skill folder name: lower case letters, digits and `-`, starting with a letter or digit, at most 64, and not a
 * Windows reserved device name (`con`, `prn`, `aux`, `nul`, `com0`-`com9`, `lpt0`-`lpt9`): Windows opens the device
 * instead of a folder. Only lower case passes the pattern, so the lower case check covers every casing.
 */
export const SKILL_NAME_PATTERN = /^(?!(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$)[a-z0-9][a-z0-9-]{0,63}$/;
/** Claude Code's own limit for a skill description. */
export const SKILL_DESCRIPTION_MAX = 1024;
export const SKILL_INSTRUCTIONS_MAX = 20_000;
/** At most this much of a SKILL.md is read (a bigger file is listed with a problem). */
export const SKILL_FILE_READ_MAX = 64 * 1024;
/** At most this many skills are listed per folder. */
export const MAX_SKILLS_PER_FOLDER = 200;

export type SkillScope = 'project' | 'user';

/** One skill as `skills.list` reports it. Every string came from a file: render it as text. */
export interface SkillInfo {
  scope: SkillScope;
  /** The known project it belongs to (scope project), or null (scope user). */
  projectPath: string | null;
  /** The folder name under `.claude/skills/`. */
  dirName: string;
  /** From the frontmatter; null when the file has none. */
  name: string | null;
  description: string | null;
  /** The SKILL.md path, for a tooltip. */
  file: string;
  /** Why the file could not be read, or null. */
  problem: string | null;
  /** Only project skills whose folder name is a valid skill name can be edited (user skills never). */
  editable: boolean;
}

export interface SkillsAnswer {
  projects: KnownProject[];
  skills: SkillInfo[];
}

/** One skill's file for the editor (`skill.read`). */
export interface SkillFile {
  projectPath: string;
  name: string;
  description: string;
  instructions: string;
}

export interface SkillDraft {
  name: string;
  description: string;
  instructions: string;
}

export type SkillDraftErrors = Partial<Record<keyof SkillDraft | 'project', string>>;

export const SKILL_WORDS = {
  name: 'Use lower case letters, digits and "-" (at most 64), starting with a letter or digit.',
  description: 'Say in one line when Claude should use this skill.',
  descriptionLong: `At most ${String(SKILL_DESCRIPTION_MAX)} characters.`,
  instructions: 'Write the instructions.',
  instructionsLong: `At most ${String(SKILL_INSTRUCTIONS_MAX)} characters.`,
  project: 'Pick a project folder.',
  exists: 'A skill with this name already exists in that project.',
} as const;

/** What is wrong with a draft, by field (empty: it can be saved). The core checks the same again. */
export function skillDraftErrors(draft: SkillDraft, projectPath: string | null): SkillDraftErrors {
  const errors: SkillDraftErrors = {};
  if (!SKILL_NAME_PATTERN.test(draft.name)) errors.name = SKILL_WORDS.name;
  const description = draft.description.trim();
  if (description === '') errors.description = SKILL_WORDS.description;
  else if (description.length > SKILL_DESCRIPTION_MAX) errors.description = SKILL_WORDS.descriptionLong;
  if (draft.instructions.trim() === '') errors.instructions = SKILL_WORDS.instructions;
  else if (draft.instructions.length > SKILL_INSTRUCTIONS_MAX) errors.instructions = SKILL_WORDS.instructionsLong;
  if (projectPath === null || projectPath.trim() === '') errors.project = SKILL_WORDS.project;
  return errors;
}

/** Control characters and line or paragraph separators. */
// eslint-disable-next-line no-control-regex -- control characters are exactly what is replaced
const LINE_BREAKS = /[\u0000-\u001f\u007f\u2028\u2029]+/g;

/** One line: control characters and line breaks become spaces, runs of spaces collapse. */
function oneLine(text: string): string {
  return text.replace(LINE_BREAKS, ' ').replace(/ {2,}/g, ' ').trim();
}

/**
 * The SKILL.md text for a draft. The description is one line written as a JSON string, which is also a valid YAML
 * double-quoted scalar, so no character in it can end the frontmatter or start a new key.
 */
export function buildSkillFile(draft: SkillDraft): string {
  const description = oneLine(draft.description).slice(0, SKILL_DESCRIPTION_MAX);
  const body = draft.instructions.replace(/\r\n?/g, '\n').trim();
  return `---\nname: ${draft.name}\ndescription: ${JSON.stringify(description)}\n---\n\n${body}\n`;
}

export interface ParsedSkillFile {
  name: string | null;
  description: string | null;
  /** The text after the frontmatter (the whole text when there is none). */
  body: string;
  /** The file starts with `---` but the frontmatter never ends. */
  unterminated: boolean;
}

function unquote(raw: string): string {
  const v = raw.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(v);
      if (typeof parsed === 'string') return parsed;
    } catch {
      /* not JSON-compatible: fall back to the text between the quotes */
    }
    return v.slice(1, -1);
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

/**
 * The frontmatter's `name` and `description` and the body. Minimal YAML on purpose: `key: value` lines at the top
 * level, quoted or plain values, and `>` / `|` blocks (indented lines joined). Anything else is ignored. Values are
 * clipped (name 64, description SKILL_DESCRIPTION_MAX) and made one line.
 */
export function parseSkillFile(text: string): ParsedSkillFile {
  const src = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  if (lines[0]?.trim() !== '---') return { name: null, description: null, body: src, unterminated: false };
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end === -1) return { name: null, description: null, body: '', unterminated: true };
  const fields = new Map<string, string>();
  for (let i = 1; i < end; i += 1) {
    const line = lines[i] ?? '';
    const m = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:(.*)$/.exec(line);
    if (m === null) continue;
    const key = (m[1] ?? '').toLowerCase();
    let value = (m[2] ?? '').trim();
    if (/^[>|][+-]?$/.test(value)) {
      const block: string[] = [];
      while (i + 1 < end && /^(\s+\S|\s*$)/.test(lines[i + 1] ?? '')) {
        i += 1;
        block.push((lines[i] ?? '').trim());
      }
      value = block.join(value.startsWith('|') ? '\n' : ' ');
    } else {
      value = unquote(value);
    }
    if (!fields.has(key)) fields.set(key, value);
  }
  const clipLine = (v: string | undefined, max: number): string | null => {
    if (v === undefined) return null;
    const one = oneLine(v).slice(0, max);
    return one === '' ? null : one;
  };
  const body = lines
    .slice(end + 1)
    .join('\n')
    .replace(/^\n+/, '');
  return {
    name: clipLine(fields.get('name'), 64),
    description: clipLine(fields.get('description'), SKILL_DESCRIPTION_MAX),
    body,
    unterminated: false,
  };
}

// ---------------------------------------------------------------------------
// Tasks (F29)
// ---------------------------------------------------------------------------

/** The Huddle's own session for `huddle_task.*` events (never a run, never in the tree). */
export const TASKS_SESSION_ID = 'huddle-tasks';
/** The other session ids the Huddle files its own events under (core/state/huddle-sessions.ts says what each holds). */
export const BUDGET_SESSION_ID = 'huddle-budgets';
export const HISTORY_SESSION_ID = 'huddle-history';
export const PHONE_SESSION_ID = 'huddle-phone';
/** The Huddle's own sessions (never a run, never in the tree). */
export const HUDDLE_SESSION_IDS: readonly string[] = [
  BUDGET_SESSION_ID,
  HISTORY_SESSION_ID,
  PHONE_SESSION_ID,
  TASKS_SESSION_ID,
];
export const HUDDLE_TASK_TITLE_MAX = 200;
export const HUDDLE_TASK_DETAILS_MAX = 4000;
/** The most tasks the reducer keeps (the oldest go first) and the core lets the user make. */
export const MAX_HUDDLE_TASKS = 500;

/**
 * todo: not started. running: launched, its run has not ended. done: the run completed, or the user marked it done.
 * failed: the run failed, could not start, or was stopped.
 */
export type HuddleTaskStatus = 'todo' | 'running' | 'done' | 'failed';
export const HUDDLE_TASK_STATUSES: readonly HuddleTaskStatus[] = ['todo', 'running', 'done', 'failed'];

/** One task as the reducer keeps it (`HuddleState.huddleTasks`). Text is the user's own, clipped; render as text. */
export interface HuddleTask {
  taskId: string;
  title: string;
  details: string;
  /** The known project it runs in; null: the template's folder (or not set yet). */
  projectPath: string | null;
  templateId: string | null;
  /** The last status recorded in the log. The view derives a fresher one from the run while it is in the state. */
  status: HuddleTaskStatus;
  /** The run launched for it (also its Claude Code session id), or null. */
  runId: string | null;
  createdAt: number;
  updatedAt: number;
  launchedAt: number | null;
}

export interface HuddleTaskView extends HuddleTask {
  /** The session root of its run when the state has it (to open the run), else null. */
  runRootKey: AgentKey | null;
}

/**
 * The status of a linked run from the state: running while its process has not exited, done when it completed,
 * failed when it failed, never started or was stopped. Null when the state does not have the run's root.
 */
export function runTaskStatus(state: HuddleState, runId: string): HuddleTaskStatus | null {
  const root = Object.hasOwn(state.agents, runId) ? state.agents[runId] : undefined;
  const run = root?.run ?? null;
  if (run === null || run.runId !== runId) return null;
  const exited = run.exited ?? null;
  if (exited === null) return 'running';
  return exited.how === 'completed' ? 'done' : 'failed';
}

/** When the linked run's process exited, or null (not in the state, or still running). */
function runExitedAt(state: HuddleState, runId: string): number | null {
  const root = Object.hasOwn(state.agents, runId) ? state.agents[runId] : undefined;
  const run = root?.run ?? null;
  if (run === null || run.runId !== runId) return null;
  return run.exited?.at ?? null;
}

/** The task list, newest first, with the status derived from the linked run when the state has it. */
export function selectHuddleTasks(state: HuddleState): HuddleTaskView[] {
  return (state.huddleTasks ?? [])
    .map((t): HuddleTaskView => {
      const live = t.runId === null ? null : runTaskStatus(state, t.runId);
      // A mark the user made after the run ended ("Mark done", "Reopen") wins over the run's outcome.
      const exitedAt = t.runId === null ? null : (runExitedAt(state, t.runId) ?? null);
      const userMarkWins = live !== null && live !== 'running' && exitedAt !== null && t.updatedAt > exitedAt;
      return {
        ...t,
        status: userMarkWins ? t.status : (live ?? t.status),
        runRootKey: live === null || t.runId === null ? null : t.runId,
      };
    })
    .sort((a, b) => b.createdAt - a.createdAt || (a.taskId < b.taskId ? 1 : -1));
}

export const TASK_STATUS_WORDS: Record<HuddleTaskStatus, string> = {
  todo: 'To do',
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
};

/** The first prompt of a task's run: the title, then the details. */
export function taskPrompt(task: Pick<HuddleTask, 'title' | 'details'>): string {
  const details = task.details.trim();
  return details === '' ? task.title.trim() : `${task.title.trim()}\n\n${details}`;
}
