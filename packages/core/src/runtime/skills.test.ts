/**
 * F28 path safety (runtime/skills.ts): what a skill write refuses (bad names, a folder that is not a known local
 * project, links and junctions on the way, an existing file without confirmation, anything inside Claude Code's config
 * folder) and what listing and reading return. Real temp folders; on Windows the links are junctions (no admin needed).
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSkillFile, parseSkillFile, projectKey, type KnownProject, type SkillDraft } from '@huddle/shared';
import { isInside, listSkills, readProjectSkill, saveProjectSkill, SKILL_REFUSALS, type SkillsDeps } from './skills.js';

let root = '';
let projectDir = '';
let deps: SkillsDeps;

const draft = (extra: Partial<SkillDraft> = {}): SkillDraft => ({
  name: 'release-notes',
  description: 'Use when writing release notes.',
  instructions: 'Read the git log since the last tag.\nGroup by feature.',
  ...extra,
});

function known(dir: string): KnownProject {
  const key = projectKey(dir);
  if (key === null) throw new Error('no key');
  return { key, path: dir, name: path.basename(dir) };
}

/** A folder link: a junction on Windows (no privilege needed), a symlink elsewhere. */
async function linkDir(target: string, at: string): Promise<void> {
  await fs.symlink(target, at, process.platform === 'win32' ? 'junction' : 'dir');
}

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'huddle-skills-')));
  projectDir = path.join(root, 'work', 'app');
  await fs.mkdir(projectDir, { recursive: true });
  const home = path.join(root, 'home');
  const claudeConfigDir = path.join(home, '.claude');
  await fs.mkdir(path.join(claudeConfigDir, 'skills', 'mine'), { recursive: true });
  await fs.writeFile(
    path.join(claudeConfigDir, 'skills', 'mine', 'SKILL.md'),
    '---\nname: mine\ndescription: My own skill\n---\nDo it.\n',
  );
  deps = { claudeConfigDir, homeDir: home };
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
});

describe('saveProjectSkill', () => {
  it('writes <project>/.claude/skills/<name>/SKILL.md, making the folders', async () => {
    const r = await saveProjectSkill(known(projectDir), draft(), false, deps);
    expect(r.ok).toBe(true);
    const file = path.join(projectDir, '.claude', 'skills', 'release-notes', 'SKILL.md');
    const text = await fs.readFile(file, 'utf8');
    expect(text).toBe(buildSkillFile(draft()));
    expect(parseSkillFile(text)).toMatchObject({
      name: 'release-notes',
      description: 'Use when writing release notes.',
    });
    // No temporary file is left behind.
    expect(await fs.readdir(path.dirname(file))).toEqual(['SKILL.md']);
  });

  it.each([
    '../evil',
    '..',
    'a/b',
    'a\\b',
    'C:',
    'Upper',
    '-dash',
    '',
    'x'.repeat(65),
    'con.md',
    'a.b',
    'con',
    'prn',
    'aux',
    'nul',
    'com1',
    'com0',
    'lpt9',
    'CON',
    'Nul',
  ])('refuses the name %j and writes nothing', async (name) => {
    const r = await saveProjectSkill(known(projectDir), draft({ name }), false, deps);
    expect(r).toMatchObject({ ok: false, code: 'invalid', message: SKILL_REFUSALS.name });
    await expect(fs.access(path.join(projectDir, '.claude'))).rejects.toThrow();
  });

  it('refuses to overwrite without confirmation, and replaces with it', async () => {
    expect((await saveProjectSkill(known(projectDir), draft(), false, deps)).ok).toBe(true);
    const again = await saveProjectSkill(known(projectDir), draft({ instructions: 'New text.' }), false, deps);
    expect(again).toMatchObject({ ok: false, exists: true, message: SKILL_REFUSALS.exists });
    const file = path.join(projectDir, '.claude', 'skills', 'release-notes', 'SKILL.md');
    expect(await fs.readFile(file, 'utf8')).toContain('Group by feature.');
    const confirmed = await saveProjectSkill(known(projectDir), draft({ instructions: 'New text.' }), true, deps);
    expect(confirmed.ok).toBe(true);
    expect(await fs.readFile(file, 'utf8')).toContain('New text.');
  });

  it('refuses a project that is the home folder (its .claude/skills is the user folder)', async () => {
    const home = deps.homeDir;
    const r = await saveProjectSkill(known(home), draft(), false, deps);
    expect(r.ok).toBe(false);
    await expect(fs.access(path.join(home, '.claude', 'skills', 'release-notes'))).rejects.toThrow();
  });

  it("refuses anything that resolves inside Claude Code's config folder", async () => {
    // A project whose .claude is a link to the user's ~/.claude.
    const sneaky = path.join(root, 'work', 'sneaky');
    await fs.mkdir(sneaky, { recursive: true });
    await linkDir(deps.claudeConfigDir, path.join(sneaky, '.claude'));
    const r = await saveProjectSkill(known(sneaky), draft(), false, deps);
    expect(r).toMatchObject({ ok: false, code: 'invalid' });
    await expect(fs.access(path.join(deps.claudeConfigDir, 'skills', 'release-notes'))).rejects.toThrow();

    // A project folder inside the config folder itself.
    const inside = path.join(deps.claudeConfigDir, 'projects', 'p1');
    await fs.mkdir(inside, { recursive: true });
    const r2 = await saveProjectSkill(known(inside), draft(), false, deps);
    expect(r2).toMatchObject({ ok: false, message: SKILL_REFUSALS.claudeConfig });
    // Refused before anything is made: no .claude folder appears inside the config folder.
    await expect(fs.access(path.join(inside, '.claude'))).rejects.toThrow();
  });

  it.each(['.claude', 'skills', 'skill'])('refuses a link or junction at %s', async (where) => {
    const elsewhere = path.join(root, 'elsewhere');
    await fs.mkdir(elsewhere, { recursive: true });
    const dotClaude = path.join(projectDir, '.claude');
    if (where === '.claude') await linkDir(elsewhere, dotClaude);
    else if (where === 'skills') {
      await fs.mkdir(dotClaude);
      await linkDir(elsewhere, path.join(dotClaude, 'skills'));
    } else {
      await fs.mkdir(path.join(dotClaude, 'skills'), { recursive: true });
      await linkDir(elsewhere, path.join(dotClaude, 'skills', 'release-notes'));
    }
    const r = await saveProjectSkill(known(projectDir), draft(), false, deps);
    expect(r).toMatchObject({ ok: false, code: 'invalid', message: SKILL_REFUSALS.link });
    expect(await fs.readdir(elsewhere)).toEqual([]);
  });

  it('refuses a SKILL.md that is not a plain file', async () => {
    const dir = path.join(projectDir, '.claude', 'skills', 'release-notes');
    await fs.mkdir(path.join(dir, 'SKILL.md'), { recursive: true });
    const r = await saveProjectSkill(known(projectDir), draft(), true, deps);
    expect(r).toMatchObject({ ok: false, message: SKILL_REFUSALS.notFile });
  });

  it('refuses when the skill folder is swapped for a link just before the rename', async () => {
    const elsewhere = path.join(root, 'elsewhere');
    await fs.mkdir(elsewhere, { recursive: true });
    const r = await saveProjectSkill(known(projectDir), draft(), false, {
      ...deps,
      beforeRename: async (skillDir) => {
        await fs.rm(skillDir, { recursive: true, force: true });
        await linkDir(elsewhere, skillDir);
      },
    });
    expect(r.ok).toBe(false);
    expect(await fs.readdir(elsewhere)).toEqual([]);
  });

  it('refuses network, relative and too-broad folders before touching the disk', async () => {
    for (const p of ['\\\\server\\share\\app', 'relative\\app', '//server/share/app']) {
      const r = await saveProjectSkill({ key: 'x', path: p, name: 'x' }, draft(), false, deps);
      expect(r).toMatchObject({ ok: false, code: 'invalid' });
    }
    const drive = path.parse(projectDir).root;
    const r = await saveProjectSkill(known(drive), draft(), false, deps);
    expect(r).toMatchObject({ ok: false, message: SKILL_REFUSALS.broad });
  });

  it('refuses a project whose real path is a network share or a device path', async () => {
    for (const real of [
      '\\\\server\\share\\app',
      '\\\\?\\C:\\work\\app',
      '\\\\.\\C:\\work\\app',
      '//server/share/app',
    ]) {
      const r = await saveProjectSkill(known(projectDir), draft(), false, {
        ...deps,
        realpath: () => Promise.resolve(real),
      });
      expect(r, real).toEqual({ ok: false, code: 'invalid', message: SKILL_REFUSALS.project });
    }
    expect(await fs.readdir(projectDir)).toEqual([]);
  });

  it('retries the final rename when Windows briefly refuses it (the file is open elsewhere)', async () => {
    const real = fs.rename.bind(fs);
    let refused = 0;
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (refused < 2) {
        refused += 1;
        throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      }
      await real(from, to);
    });
    try {
      const r = await saveProjectSkill(known(projectDir), draft(), false, deps);
      expect(r.ok).toBe(true);
      expect(refused).toBe(2);
    } finally {
      spy.mockRestore();
    }
    const file = path.join(projectDir, '.claude', 'skills', 'release-notes', 'SKILL.md');
    expect(parseSkillFile(await fs.readFile(file, 'utf8')).name).toBe('release-notes');
  });

  it('refuses a folder that is gone, and empty fields', async () => {
    const gone = path.join(root, 'work', 'gone');
    expect(await saveProjectSkill(known(gone), draft(), false, deps)).toMatchObject({ ok: false, code: 'not_found' });
    expect(await saveProjectSkill(known(projectDir), draft({ description: ' ' }), false, deps)).toMatchObject({
      ok: false,
      code: 'invalid',
    });
  });
});

describe('listSkills and readProjectSkill', () => {
  it('lists project skills and the user skills (read-only), skipping linked folders', async () => {
    await saveProjectSkill(known(projectDir), draft(), false, deps);
    const odd = path.join(projectDir, '.claude', 'skills', 'Odd Name');
    await fs.mkdir(odd);
    await fs.writeFile(path.join(odd, 'SKILL.md'), 'no frontmatter <img src=x onerror=alert(1)>');
    await linkDir(path.join(root, 'work'), path.join(projectDir, '.claude', 'skills', 'linked'));
    const answer = await listSkills([known(projectDir)], deps);
    const rows = answer.skills.map((s) => [s.scope, s.dirName, s.name, s.editable]);
    expect(rows).toEqual([
      ['project', 'Odd Name', null, false],
      ['project', 'release-notes', 'release-notes', true],
      ['user', 'mine', 'mine', false],
    ]);
    expect(answer.projects).toEqual([known(projectDir)]);
  });

  it('reads one skill for the editor; refuses unknown and bad names', async () => {
    await saveProjectSkill(known(projectDir), draft(), false, deps);
    const r = await readProjectSkill(known(projectDir), 'release-notes', deps);
    expect(r).toEqual({
      ok: true,
      skill: {
        projectPath: projectDir,
        name: 'release-notes',
        description: 'Use when writing release notes.',
        instructions: 'Read the git log since the last tag.\nGroup by feature.\n',
      },
    });
    expect(await readProjectSkill(known(projectDir), 'nope', deps)).toMatchObject({ ok: false, code: 'not_found' });
    expect(await readProjectSkill(known(projectDir), '../x', deps)).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('marks a too big file and never reads past the limit', async () => {
    const dir = path.join(projectDir, '.claude', 'skills', 'big');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'SKILL.md'), 'x'.repeat(70 * 1024));
    const answer = await listSkills([known(projectDir)], deps);
    expect(answer.skills.find((s) => s.dirName === 'big')).toMatchObject({ problem: SKILL_REFUSALS.tooBig });
  });
});

describe('isInside', () => {
  it('compares folders, case-insensitively on Windows', () => {
    expect(isInside('C:\\A\\b\\c', 'c:\\a', 'win32')).toBe(true);
    expect(isInside('C:\\A', 'C:\\A', 'win32')).toBe(true);
    expect(isInside('C:\\Ab', 'C:\\A', 'win32')).toBe(false);
    expect(isInside('/a/b', '/a', 'linux')).toBe(true);
    expect(isInside('/A/b', '/a', 'linux')).toBe(false);
  });
});
