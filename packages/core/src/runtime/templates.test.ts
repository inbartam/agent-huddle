/** templates.json (M4 WP6, F16/F17): parse, edit, write, and what a bad file does. */
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TeamTemplate } from '@huddle/shared';
import {
  parseTemplates,
  preserveBadTemplatesFile,
  readTemplates,
  removeTemplate,
  serializeTemplates,
  templatesPath,
  upsertTemplate,
  writeTemplates,
} from './templates.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await fsp.rm(d, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), 'huddle-templates-'));
  dirs.push(d);
  return d;
}

function template(over: Partial<TeamTemplate> = {}): TeamTemplate {
  return {
    id: 'tpl-1',
    name: 'Reviewers',
    prompt: 'Review the last commit.',
    cwd: 'C:/Users/user/project',
    mainAgent: null,
    model: null,
    permissionMode: 'default',
    worktree: true,
    ...over,
  };
}

describe('parseTemplates', () => {
  it('no file: an empty list, no warning', () => {
    expect(parseTemplates(null)).toEqual({ templates: [], warning: null, bad: false });
  });

  it('round-trips, keeps unknown fields, and reads a BOM', () => {
    const withExtra = { ...template(), futureField: { x: 1 } } as TeamTemplate;
    const text = serializeTemplates([withExtra]);
    expect(parseTemplates(text).templates).toEqual([withExtra]);
    expect(parseTemplates(`\ufeff${text}`).templates).toEqual([withExtra]);
  });

  it.each([
    ['not JSON', '{nope'],
    ['wrong shape', JSON.stringify({ version: 1, templates: [{ id: 'x' }] })],
    ['newer version', JSON.stringify({ version: 2, templates: [] })],
    ['two with one id', serializeTemplates([template(), template({ name: 'again' })])],
    ['a bad agent name', serializeTemplates([template({ agents: { '-x': { description: 'd', prompt: 'p' } } })])],
  ])('a bad file (%s): an empty list and a warning without file contents', (_why, text) => {
    const load = parseTemplates(text);
    expect(load.templates).toEqual([]);
    expect(load.bad).toBe(true);
    expect(load.warning).toMatch(/^templates\.json .*; no templates loaded$/);
    expect(load.warning).not.toContain('Review the last commit');
  });
});

describe('list edits', () => {
  it('upsert adds or replaces in place; remove drops by id', () => {
    const a = template({ id: 'a' });
    const b = template({ id: 'b' });
    const list = upsertTemplate(upsertTemplate([], a), b);
    expect(list.map((t) => t.id)).toEqual(['a', 'b']);
    const renamed = upsertTemplate(list, { ...a, name: 'Renamed' });
    expect(renamed.map((t) => [t.id, t.name])).toEqual([
      ['a', 'Renamed'],
      ['b', 'Reviewers'],
    ]);
    expect(removeTemplate(renamed, 'a').map((t) => t.id)).toEqual(['b']);
    expect(removeTemplate(renamed, 'nope')).toEqual(renamed);
  });
});

describe('the file', () => {
  it('write then read', async () => {
    const dir = await tempDir();
    await writeTemplates(dir, [template()]);
    expect(await readTemplates(dir)).toEqual({ templates: [template()], warning: null, bad: false });
  });

  it('a bad file is moved aside, never deleted', async () => {
    const dir = await tempDir();
    await fsp.writeFile(templatesPath(dir), '{broken');
    expect((await readTemplates(dir)).bad).toBe(true);
    const moved = await preserveBadTemplatesFile(dir, 1234);
    expect(moved).toBe(`${templatesPath(dir)}.bad-1234`);
    expect(await fsp.readFile(`${templatesPath(dir)}.bad-1234`, 'utf8')).toBe('{broken');
    expect(await preserveBadTemplatesFile(dir, 1235)).toBeNull();
  });
});
