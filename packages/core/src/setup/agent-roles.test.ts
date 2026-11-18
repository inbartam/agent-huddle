import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLIP_LIMITS } from '@huddle/shared';
import { parseAgentDefinition, parseFrontmatter, readAgentRoles, roleDescribedEvents } from './agent-roles.js';

const tmpDirs: string[] = [];
async function tmpDir(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'huddle-roles-'));
  tmpDirs.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of tmpDirs.splice(0)) await fsp.rm(dir, { recursive: true, force: true });
});

/** A temp project folder with a `.claude/agents` folder holding the four agent files these tests read. */
async function projectWithAgents(): Promise<string> {
  const repo = await tmpDir();
  const agents = path.join(repo, '.claude', 'agents');
  await fsp.mkdir(agents, { recursive: true });
  const defs: Record<string, string> = {
    'core-engineer': "Implements Agent Huddle's core in packages/core and packages/shared. Use for non-UI work.",
    'docs-verifier': 'Checks facts about Claude Code against the live documentation.',
    'security-reviewer': 'Reviews changes for security and privacy problems.',
    'ui-engineer': "Implements Agent Huddle's UI in the desktop app.",
  };
  for (const [name, description] of Object.entries(defs)) {
    await fsp.writeFile(
      path.join(agents, `${name}.md`),
      `---
name: ${name}
description: ${description}
---

Body.
`,
    );
  }
  return repo;
}

describe('parseFrontmatter', () => {
  it('reads plain, double-quoted and single-quoted values', () => {
    const text = [
      '---',
      'name: reviewer',
      'description: "Says \\"no\\" politely: a reviewer"',
      "model: 'it''s sonnet'",
      'color: blue # a comment',
      '---',
      'body: not frontmatter',
    ].join('\n');
    expect(parseFrontmatter(text)).toEqual({
      name: 'reviewer',
      description: 'Says "no" politely: a reviewer',
      model: "it's sonnet",
      color: 'blue',
    });
  });

  it('reads literal and folded block scalars', () => {
    const literal = parseFrontmatter('---\nname: a\ndescription: |\n  line one\n  line two\n\nmodel: x\n---\n');
    expect(literal).toEqual({ name: 'a', description: 'line one\nline two\n', model: 'x' });
    const folded = parseFrontmatter('---\ndescription: >-\n  one\n  two\n\n  three\nname: b\n---\n');
    expect(folded).toEqual({ description: 'one two\nthree', name: 'b' });
  });

  it('folds a plain value continued on indented lines, and a quoted value over lines', () => {
    expect(parseFrontmatter('---\ndescription: first part\n  second part\nname: c\n---')).toEqual({
      description: 'first part second part',
      name: 'c',
    });
    expect(parseFrontmatter('---\ndescription: "first\n  second"\nname: d\n---')).toEqual({
      description: 'first second',
      name: 'd',
    });
  });

  it('handles CRLF, a BOM, and skips lists and nested maps', () => {
    const text =
      String.fromCharCode(0xfeff) +
      '---\r\nname: e\r\ntools:\r\n  - Read\r\n  - Grep\r\nhooks:\r\n  Stop: x\r\ndescription: Does e\r\n---\r\n';
    expect(parseFrontmatter(text)).toEqual({ name: 'e', description: 'Does e' });
  });

  it('returns null without frontmatter or without a closing marker', () => {
    expect(parseFrontmatter('# Just markdown\n')).toBeNull();
    expect(parseFrontmatter('---\nname: x\n')).toBeNull();
    expect(parseFrontmatter('')).toBeNull();
  });

  it('never throws on malformed input', () => {
    const bad = [
      '---\n: no key\n---',
      '---\ndescription: "never closes\nname: x\n---',
      '---\n\0\0\0\n---',
      '---\n|\n>\n---',
    ];
    for (const text of bad) expect(() => parseFrontmatter(text)).not.toThrow();
    expect(parseFrontmatter('---\nname: ok\ndescription: "never closes\n---')).toEqual({ name: 'ok' });
  });
});

describe('parseAgentDefinition', () => {
  it('needs both name and description', () => {
    expect(parseAgentDefinition('---\nname: x\n---', 'x.md', 'user')).toBeNull();
    expect(parseAgentDefinition('---\ndescription: y\n---', 'x.md', 'user')).toBeNull();
    expect(parseAgentDefinition('no frontmatter', 'x.md', 'user')).toBeNull();
  });

  it('clips the description to CLIP_LIMITS.description', () => {
    const long = 'a'.repeat(CLIP_LIMITS.description + 500);
    const role = parseAgentDefinition(`---\nname: long\ndescription: ${long}\n---`, 'l.md', 'project');
    expect(role?.description.length).toBe(CLIP_LIMITS.description);
  });
});

describe('readAgentRoles', () => {
  it('reads project agent definitions', async () => {
    const REPO = await projectWithAgents();
    const roles = await readAgentRoles({ cwd: REPO, userAgentsDir: null });
    const core = roles.find((r) => r.role === 'core-engineer');
    expect(core).toMatchObject({ definedIn: 'project' });
    expect(core?.description).toMatch(/^Implements Agent Huddle's core/);
    expect(core?.filePath).toBe(path.join(REPO, '.claude', 'agents', 'core-engineer.md'));
    expect(roles.map((r) => r.role)).toEqual(
      expect.arrayContaining(['docs-verifier', 'security-reviewer', 'ui-engineer']),
    );
  });

  it('project definitions win over user ones with the same name', async () => {
    const REPO = await projectWithAgents();
    const userDir = await tmpDir();
    await fsp.writeFile(
      path.join(userDir, 'core-engineer.md'),
      '---\nname: core-engineer\ndescription: user copy\n---\n',
    );
    await fsp.writeFile(path.join(userDir, 'my-helper.md'), '---\nname: my-helper\ndescription: "Mine"\n---\n');
    await fsp.writeFile(path.join(userDir, 'broken.md'), '---\nname: [unclosed\n');
    await fsp.writeFile(path.join(userDir, 'notes.txt'), '---\nname: not-md\ndescription: skip\n---\n');
    const roles = await readAgentRoles({ cwd: REPO, userAgentsDir: userDir });
    expect(roles.filter((r) => r.role === 'core-engineer')).toHaveLength(1);
    expect(roles.find((r) => r.role === 'core-engineer')?.definedIn).toBe('project');
    expect(roles.find((r) => r.role === 'my-helper')).toMatchObject({ definedIn: 'user', description: 'Mine' });
    expect(roles.some((r) => r.role === 'not-md')).toBe(false);
  });

  it('missing folders give no roles, with mixed slashes in the paths', async () => {
    const dir = await tmpDir();
    const mixed = `${dir.replace(/\\/g, '/')}\\nope/agents`;
    expect(await readAgentRoles({ cwd: mixed, userAgentsDir: mixed })).toEqual([]);
    await fsp.mkdir(path.join(dir, 'proj', '.claude', 'agents'), { recursive: true });
    await fsp.writeFile(path.join(dir, 'proj', '.claude', 'agents', 'a.md'), '---\nname: a\ndescription: A\n---\n');
    const roles = await readAgentRoles({ cwd: `${dir.replace(/\\/g, '/')}\\proj`, userAgentsDir: null });
    expect(roles).toEqual([
      {
        role: 'a',
        description: 'A',
        definedIn: 'project',
        filePath: path.join(dir, 'proj', '.claude', 'agents', 'a.md'),
      },
    ]);
  });
});

describe('readAgentRoles with a project folder that is not local (A2-05)', () => {
  it.each(['\\\\host\\share', '//host/share/proj', '\\\\?\\C:\\proj'])(
    'does not touch the file system for %s, and still lists the user roles',
    async (cwd) => {
      const userDir = await tmpDir();
      await fsp.writeFile(path.join(userDir, 'mine.md'), '---\nname: mine\ndescription: d\n---\nbody\n');
      const readdir = vi.spyOn(fsp, 'readdir');
      try {
        const roles = await readAgentRoles({ cwd, userAgentsDir: userDir });
        expect(roles.map((r) => r.role)).toEqual(['mine']);
        const touched = readdir.mock.calls.map((c) => String(c[0]));
        expect(touched.every((p) => !/host|share/.test(p))).toBe(true);
      } finally {
        readdir.mockRestore();
      }
    },
  );
});

describe('roleDescribedEvents', () => {
  it('builds events with the ids and time passed in', () => {
    let n = 0;
    const events = roleDescribedEvents([{ role: 'a', description: 'A', definedIn: 'user', filePath: '/x/a.md' }], {
      sessionId: 's1',
      ts: 1000,
      nextId: () => `id-${String(++n)}`,
    });
    expect(events).toEqual([
      {
        id: 'id-1',
        type: 'role.described',
        ts: 1000,
        sessionId: 's1',
        agentKey: 's1',
        source: 'huddle',
        role: 'a',
        description: 'A',
        definedIn: 'user',
        filePath: '/x/a.md',
      },
    ]);
  });
});
