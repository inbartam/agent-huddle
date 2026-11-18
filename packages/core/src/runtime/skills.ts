/**
 * Claude Code skills on disk (F28): list them, read one, write one. The only place the Huddle writes into a project
 * folder. See docs/SECURITY.md ("Skill files") and ADR-028.
 *
 * Where:
 *  - project skills: `<project>/.claude/skills/<name>/SKILL.md`, for each known project (`selectKnownProjects`), which
 *    the caller passes in. Never a typed path: the renderer names a folder and the core finds it in that list.
 *  - the user's skills: `<claudeConfigDir>/skills/<name>/SKILL.md`, listed READ-ONLY. Nothing here writes there.
 *
 * Every write is checked, in this order, and refused at the first failure:
 *  1. the name matches SKILL_NAME_PATTERN (so it has no separator, no `..`, no drive, no reserved character);
 *  2. the project path is a plain local absolute path (`isLocalAbsolutePath`, before any file system call);
 *  3. its real path (symlinks resolved) is again a plain local absolute path (not a share or device path), is a folder
 *     and is not too broad to be one project (`isTooBroadFolder`);
 *  4. `.claude`, `.claude/skills` and `.claude/skills/<name>` are each a real folder, not a symlink or junction
 *     (missing ones are made, one level at a time); none of them resolves inside Claude Code's config folder or
 *     `<home>/.claude`;
 *  5. `SKILL.md`, if it exists, is a regular file, not a link, and is replaced only with `overwrite`;
 *  6. the text goes to a new temporary file in the skill folder (`wx`), then is renamed over SKILL.md (a hard link to
 *     another file is replaced, never written through); the folder's real path is checked again before the rename.
 *
 * Reads follow the same checks (no folder is made) and read at most SKILL_FILE_READ_MAX bytes of a regular file.
 * What a file says is untrusted text (`parseSkillFile`).
 */
import { promises as fs, type Stats } from 'node:fs';
import path from 'node:path';
import {
  buildSkillFile,
  isTooBroadFolder,
  MAX_SKILLS_PER_FOLDER,
  parseSkillFile,
  projectKey,
  SKILL_FILE_READ_MAX,
  SKILL_NAME_PATTERN,
  skillDraftErrors,
  type CommandResult,
  type KnownProject,
  type SkillDraft,
  type SkillFile,
  type SkillInfo,
  type SkillsAnswer,
} from '@huddle/shared';
import { renameWithRetry } from './atomic-file.js';
import { isLocalAbsolutePath } from './paths.js';

export interface SkillsDeps {
  /** Claude Code's config folder (CLAUDE_CONFIG_DIR or ~/.claude): user skills are read here, never written. */
  claudeConfigDir: string;
  /** The user's home folder: `<home>/.claude` is refused as a target too. */
  homeDir: string;
  platform?: NodeJS.Platform;
  /** Tests: a hook just before the rename (to change the folder under the writer). */
  beforeRename?: (skillDir: string) => Promise<void>;
  /** Tests: stands in for fs.realpath on the project folder (to return a network or device path). */
  realpath?: (p: string) => Promise<string>;
}

type Failure = Extract<CommandResult, { ok: false }>;
const fail = (code: Failure['code'], message: string, extra: Partial<Failure> = {}): Failure => ({
  ok: false,
  code,
  message,
  ...extra,
});

export const SKILL_REFUSALS = {
  name: 'That skill name is not allowed. Use lower case letters, digits and "-".',
  project: 'That folder is not a local project folder Huddle knows.',
  broad: 'That folder is too broad to be one project (a drive, a home folder or Documents).',
  missing: 'That project folder does not exist any more.',
  link: 'A folder on the way to the skill is a link or junction, so Huddle will not write there.',
  notDir: 'Something on the way to the skill is a file, not a folder.',
  claudeConfig: "That would write into Claude Code's own config folder, which Huddle never edits.",
  notFile: 'SKILL.md there is not a plain file, so Huddle will not replace it.',
  exists: 'A skill with this name already exists in that project. Confirm to replace it.',
  notFound: 'That skill is not in this project.',
  tooBig: 'This SKILL.md is too big to show here.',
  failed: 'The skill could not be saved. Check that the project folder is writable, then try again.',
} as const;

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

async function lstatOrNull(p: string): Promise<Stats | null> {
  try {
    return await fs.lstat(p);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return null;
    throw error;
  }
}

/** Is `child` the folder `parent` or inside it (case-insensitive on Windows)? Both absolute. */
export function isInside(child: string, parent: string, platform: NodeJS.Platform = process.platform): boolean {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const a = platform === 'win32' ? child.toLowerCase() : child;
  const b = platform === 'win32' ? parent.toLowerCase() : parent;
  const rel = p.relative(b, a);
  return rel === '' || (!rel.startsWith('..') && !p.isAbsolute(rel));
}

async function realOrResolved(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    return path.resolve(p);
  }
}

/** Claude Code's config folders, real paths where they exist: no skill is ever written inside one. */
async function forbiddenRoots(deps: SkillsDeps): Promise<string[]> {
  return Promise.all([deps.claudeConfigDir, path.join(deps.homeDir, '.claude')].map(realOrResolved));
}

type Checked<T> = { ok: true; value: T } | Failure;

/** Steps 2 and 3: the project's real folder. */
async function realProject(project: KnownProject, deps: SkillsDeps): Promise<Checked<string>> {
  const platform = deps.platform ?? process.platform;
  if (!isLocalAbsolutePath(project.path, platform)) return fail('invalid', SKILL_REFUSALS.project);
  const key = projectKey(project.path);
  if (key === null || isTooBroadFolder(key)) return fail('invalid', SKILL_REFUSALS.broad);
  let real: string;
  try {
    real = await (deps.realpath ?? fs.realpath)(project.path);
  } catch {
    return fail('not_found', SKILL_REFUSALS.missing);
  }
  // A link or junction can resolve to a network share (`\\server\share`) or a device path (`\\?\`,
  // `\\.\`): the real folder must be a plain local path too.
  if (!isLocalAbsolutePath(real, platform)) return fail('invalid', SKILL_REFUSALS.project);
  try {
    if (!(await fs.stat(real)).isDirectory()) return fail('not_found', SKILL_REFUSALS.missing);
  } catch {
    return fail('not_found', SKILL_REFUSALS.missing);
  }
  const realKey = projectKey(real);
  if (realKey === null || isTooBroadFolder(realKey)) return fail('invalid', SKILL_REFUSALS.broad);
  // A project inside a Claude Code config folder is refused before anything is made in it.
  for (const root of await forbiddenRoots(deps)) {
    if (isInside(real, root, platform) || isInside(path.resolve(project.path), root, platform)) {
      return fail('invalid', SKILL_REFUSALS.claudeConfig);
    }
  }
  return { ok: true, value: real };
}

/**
 * Step 4 for one folder: a real folder (not a link), made when missing and `create`; null when missing and not
 * `create`. Refused when it resolves inside a Claude Code config folder.
 */
async function realFolder(p: string, create: boolean, deps: SkillsDeps): Promise<Checked<string | null>> {
  const platform = deps.platform ?? process.platform;
  let st = await lstatOrNull(p);
  if (st === null) {
    if (!create) return { ok: true, value: null };
    // Never make a folder inside a Claude Code config folder, not even one refused right after.
    for (const root of await forbiddenRoots(deps)) {
      if (isInside(path.resolve(p), root, platform)) return fail('invalid', SKILL_REFUSALS.claudeConfig);
    }
    try {
      await fs.mkdir(p);
    } catch (error) {
      if (!isErrno(error, 'EEXIST')) throw error;
    }
    st = await fs.lstat(p);
  }
  if (st.isSymbolicLink()) return fail('invalid', SKILL_REFUSALS.link);
  if (!st.isDirectory()) return fail('invalid', SKILL_REFUSALS.notDir);
  const real = await fs.realpath(p);
  for (const root of await forbiddenRoots(deps)) {
    if (isInside(real, root, platform) || isInside(path.resolve(p), root, platform)) {
      return fail('invalid', SKILL_REFUSALS.claudeConfig);
    }
  }
  return { ok: true, value: real };
}

/** `.claude/skills` of a real project folder, checked (and made when `create`); null when it does not exist. */
async function skillsRootOf(project: string, create: boolean, deps: SkillsDeps): Promise<Checked<string | null>> {
  const dotClaude = await realFolder(path.join(project, '.claude'), create, deps);
  if (!dotClaude.ok || dotClaude.value === null) return dotClaude;
  return realFolder(path.join(dotClaude.value, 'skills'), create, deps);
}

/** Reads a regular, non-link file of at most SKILL_FILE_READ_MAX bytes. */
async function readSkillText(file: string): Promise<{ text: string } | { problem: string } | null> {
  const st = await lstatOrNull(file);
  if (st === null) return null;
  if (st.isSymbolicLink() || !st.isFile()) return { problem: SKILL_REFUSALS.notFile };
  if (st.size > SKILL_FILE_READ_MAX) return { problem: SKILL_REFUSALS.tooBig };
  const handle = await fs.open(file, 'r');
  try {
    const buf = Buffer.alloc(Math.min(st.size, SKILL_FILE_READ_MAX));
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    return { text: buf.subarray(0, bytesRead).toString('utf8') };
  } finally {
    await handle.close();
  }
}

async function listFolder(root: string, scope: SkillInfo['scope'], projectPath: string | null): Promise<SkillInfo[]> {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  // Only real folders: a symlinked or junction skill folder is left out (readdir reports it as a link).
  const dirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .slice(0, MAX_SKILLS_PER_FOLDER);
  const out: SkillInfo[] = [];
  for (const dirName of dirs) {
    const file = path.join(root, dirName, 'SKILL.md');
    let read: Awaited<ReturnType<typeof readSkillText>>;
    try {
      read = await readSkillText(file);
    } catch {
      read = { problem: 'Could not read SKILL.md.' };
    }
    if (read === null) continue;
    const parsed = 'text' in read ? parseSkillFile(read.text) : null;
    out.push({
      scope,
      projectPath,
      dirName,
      name: parsed?.name ?? null,
      description: parsed?.description ?? null,
      file,
      problem: 'problem' in read ? read.problem : parsed?.unterminated === true ? 'The frontmatter never ends.' : null,
      editable: scope === 'project' && SKILL_NAME_PATTERN.test(dirName) && 'text' in read,
    });
  }
  return out;
}

/** Every skill in the known projects, then the user's own (read-only). Never throws; an unreadable folder is skipped. */
export async function listSkills(projects: readonly KnownProject[], deps: SkillsDeps): Promise<SkillsAnswer> {
  const skills: SkillInfo[] = [];
  for (const project of projects) {
    try {
      const real = await realProject(project, deps);
      if (!real.ok) continue;
      const root = await skillsRootOf(real.value, false, deps);
      if (!root.ok || root.value === null) continue;
      skills.push(...(await listFolder(root.value, 'project', project.path)));
    } catch {
      /* this project's skills are left out; the others still list */
    }
  }
  try {
    const userRoot = path.join(deps.claudeConfigDir, 'skills');
    const st = await lstatOrNull(userRoot);
    if (st?.isDirectory() === true) skills.push(...(await listFolder(userRoot, 'user', null)));
  } catch {
    /* no user skills listed */
  }
  return { projects: [...projects], skills };
}

/** Steps 1-4 without making anything: the skill's folder, or null when it does not exist. */
async function existingSkillDir(
  project: KnownProject,
  name: string,
  deps: SkillsDeps,
): Promise<Checked<string | null>> {
  if (!SKILL_NAME_PATTERN.test(name)) return fail('invalid', SKILL_REFUSALS.name);
  const real = await realProject(project, deps);
  if (!real.ok) return real;
  const root = await skillsRootOf(real.value, false, deps);
  if (!root.ok || root.value === null) return root;
  return realFolder(path.join(root.value, name), false, deps);
}

/** One project skill's file for the editor. */
export async function readProjectSkill(
  project: KnownProject,
  name: string,
  deps: SkillsDeps,
): Promise<{ ok: true; skill: SkillFile } | Failure> {
  try {
    const dir = await existingSkillDir(project, name, deps);
    if (!dir.ok) return dir;
    if (dir.value === null) return fail('not_found', SKILL_REFUSALS.notFound);
    const read = await readSkillText(path.join(dir.value, 'SKILL.md'));
    if (read === null) return fail('not_found', SKILL_REFUSALS.notFound);
    if ('problem' in read) return fail('invalid', read.problem);
    const parsed = parseSkillFile(read.text);
    return {
      ok: true,
      skill: { projectPath: project.path, name, description: parsed.description ?? '', instructions: parsed.body },
    };
  } catch {
    return fail('failed', 'The skill could not be read.');
  }
}

/** Write (or, with `overwrite`, replace) `<project>/.claude/skills/<name>/SKILL.md`. See the checks at the top. */
export async function saveProjectSkill(
  project: KnownProject,
  draft: SkillDraft,
  overwrite: boolean,
  deps: SkillsDeps,
): Promise<CommandResult> {
  const platform = deps.platform ?? process.platform;
  const errors = skillDraftErrors(draft, project.path);
  if (errors.name !== undefined) return fail('invalid', SKILL_REFUSALS.name);
  const first = Object.values(errors)[0];
  if (first !== undefined) return fail('invalid', first);
  let tmp: string | null = null;
  try {
    const real = await realProject(project, deps);
    if (!real.ok) return real;
    const root = await skillsRootOf(real.value, true, deps);
    if (!root.ok) return root;
    if (root.value === null) return fail('failed', SKILL_REFUSALS.failed);
    const skillsRoot = root.value;
    const wanted = path.join(skillsRoot, draft.name);
    // The pattern already rules out separators and dots; this is the defence in depth.
    if (path.relative(skillsRoot, wanted) !== draft.name) return fail('invalid', SKILL_REFUSALS.name);
    const dir = await realFolder(wanted, true, deps);
    if (!dir.ok) return dir;
    if (dir.value === null) return fail('failed', SKILL_REFUSALS.failed);
    const skillDir = dir.value;
    if (!isInside(skillDir, skillsRoot, platform)) return fail('invalid', SKILL_REFUSALS.link);
    const file = path.join(skillDir, 'SKILL.md');
    const existing = await lstatOrNull(file);
    if (existing !== null) {
      if (existing.isSymbolicLink() || !existing.isFile()) return fail('invalid', SKILL_REFUSALS.notFile);
      if (!overwrite) return fail('invalid', SKILL_REFUSALS.exists, { exists: true });
    }
    tmp = path.join(skillDir, `.SKILL.md.${String(process.pid)}.${String(Date.now())}.tmp`);
    await fs.writeFile(tmp, buildSkillFile(draft), { encoding: 'utf8', flag: 'wx' });
    await deps.beforeRename?.(skillDir);
    // Checked again just before the rename: the folder must still be the same real folder inside the skills folder.
    const again = await lstatOrNull(wanted);
    if (again === null || again.isSymbolicLink() || !again.isDirectory()) return fail('invalid', SKILL_REFUSALS.link);
    const realAgain = await fs.realpath(wanted);
    if (realAgain !== skillDir) return fail('invalid', SKILL_REFUSALS.link);
    const fileAgain = await lstatOrNull(file);
    if (fileAgain !== null && (fileAgain.isSymbolicLink() || !fileAgain.isFile())) {
      return fail('invalid', SKILL_REFUSALS.notFile);
    }
    if (fileAgain !== null && !overwrite) return fail('invalid', SKILL_REFUSALS.exists, { exists: true });
    await renameWithRetry(tmp, file);
    tmp = null;
    return { ok: true, detail: file };
  } catch {
    return fail('failed', SKILL_REFUSALS.failed);
  } finally {
    if (tmp !== null) await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
}
