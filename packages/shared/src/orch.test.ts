/** F28/F29 pure parts: the SKILL.md round trip and the untrusted-frontmatter parser, drafts, and known projects. */
import { describe, expect, it } from 'vitest';
import { EMPTY_STATE, type HuddleState, type TeamTemplate } from './model.js';
import {
  buildSkillFile,
  findKnownProject,
  MAX_KNOWN_PROJECTS,
  parseSkillFile,
  selectKnownProjects,
  skillDraftErrors,
  SKILL_WORDS,
  taskPrompt,
} from './orch.js';

describe('SKILL.md', () => {
  it('round-trips a draft, keeping the description on one line', () => {
    const text = buildSkillFile({
      name: 'notes',
      description: 'Use when "notes"\nare needed\n---\nname: evil',
      instructions: 'Step one.\r\nStep two.\n',
    });
    expect(text.split('\n').slice(0, 4)).toEqual([
      '---',
      'name: notes',
      'description: "Use when \\"notes\\" are needed --- name: evil"',
      '---',
    ]);
    expect(parseSkillFile(text)).toEqual({
      name: 'notes',
      description: 'Use when "notes" are needed --- name: evil',
      body: 'Step one.\nStep two.\n',
      unterminated: false,
    });
  });

  it('reads plain, single-quoted and folded values, a BOM and CRLF, and ignores the rest', () => {
    const text =
      "\uFEFF---\r\nname: 'it''s'\r\nallowed-tools: Bash\r\ndescription: >\r\n  first\r\n  second\r\n---\r\nBody";
    expect(parseSkillFile(text)).toMatchObject({ name: "it's", description: 'first second', body: 'Body' });
  });

  it('treats a file without frontmatter as all body, and an unterminated one as broken', () => {
    expect(parseSkillFile('just text')).toEqual({
      name: null,
      description: null,
      body: 'just text',
      unterminated: false,
    });
    expect(parseSkillFile('---\nname: x\n')).toMatchObject({ name: null, unterminated: true });
  });

  it('clips and flattens untrusted values', () => {
    const parsed = parseSkillFile(`---\nname: ${'n'.repeat(100)}\ndescription: ${'d'.repeat(2000)}\n---\n`);
    expect(parsed.name).toHaveLength(64);
    expect(parsed.description).toHaveLength(1024);
  });
});

describe('skillDraftErrors', () => {
  it('names each wrong field', () => {
    expect(skillDraftErrors({ name: 'ok-name', description: 'd', instructions: 'i' }, 'C:/p/app')).toEqual({});
    expect(skillDraftErrors({ name: 'Bad', description: ' ', instructions: '' }, null)).toEqual({
      name: SKILL_WORDS.name,
      description: SKILL_WORDS.description,
      instructions: SKILL_WORDS.instructions,
      project: SKILL_WORDS.project,
    });
  });

  it('refuses Windows reserved device names in any casing, and keeps names that only start like one', () => {
    for (const name of ['con', 'prn', 'aux', 'nul', 'com0', 'com9', 'lpt1', 'CON', 'Lpt3']) {
      expect(skillDraftErrors({ name, description: 'd', instructions: 'i' }, 'C:/p/app').name).toBe(SKILL_WORDS.name);
    }
    for (const name of ['console', 'con-tools', 'com10', 'lpt', 'nul1x', 'auxiliary']) {
      expect(skillDraftErrors({ name, description: 'd', instructions: 'i' }, 'C:/p/app')).toEqual({});
    }
  });
});

describe('selectKnownProjects', () => {
  const template = (cwd: string): TeamTemplate => ({
    id: cwd,
    name: 't',
    prompt: 'p',
    cwd,
    mainAgent: null,
    model: null,
    permissionMode: 'default',
    worktree: false,
  });
  it('collects template and task folders, one per folder, never a too-broad one', () => {
    const state: HuddleState = {
      ...EMPTY_STATE,
      templates: [template('C:\\work\\api'), template('c:/work/api/'), template('C:\\Users\\me'), template('C:\\')],
      huddleTasks: [
        {
          taskId: 't1',
          title: 'x',
          details: '',
          projectPath: 'C:\\work\\web',
          templateId: null,
          status: 'todo',
          runId: null,
          createdAt: 1,
          updatedAt: 1,
          launchedAt: null,
        },
      ],
    };
    const projects = selectKnownProjects(state);
    expect(projects.map((p) => p.path)).toEqual(['C:\\work\\api', 'C:\\work\\web']);
    expect(findKnownProject(projects, 'C:/WORK/API')?.path).toBe('C:\\work\\api');
    expect(findKnownProject(projects, 'C:\\work')).toBeNull();
    expect(findKnownProject(projects, null)).toBeNull();
  });

  it('is not capped: a folder past MAX_KNOWN_PROJECTS is still known (the cap is for lists shown)', () => {
    const many = Array.from({ length: MAX_KNOWN_PROJECTS + 1 }, (_, i) =>
      template(`C:\\work\\p${String(i).padStart(3, '0')}`),
    );
    const projects = selectKnownProjects({ ...EMPTY_STATE, templates: many });
    expect(projects).toHaveLength(MAX_KNOWN_PROJECTS + 1);
    expect(findKnownProject(projects, `C:\\work\\p${String(MAX_KNOWN_PROJECTS).padStart(3, '0')}`)).not.toBeNull();
  });
});

describe('taskPrompt', () => {
  it('is the title, then the details when there are any', () => {
    expect(taskPrompt({ title: ' Do it ', details: '' })).toBe('Do it');
    expect(taskPrompt({ title: 'Do it', details: 'More.' })).toBe('Do it\n\nMore.');
  });
});
