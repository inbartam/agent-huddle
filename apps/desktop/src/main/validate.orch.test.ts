/**
 * F28/F29: the new commands and queries on the existing `huddle:command` and `huddle:query` channels are checked in
 * main before they reach the core: a skill name that could leave its folder, a missing confirmation flag, overlong
 * text, a task status the user may not set, and unknown fields kept (loose objects).
 */
import { describe, expect, it } from 'vitest';
import { parseCommand, parseQuery } from './validate.js';

const save = {
  type: 'skill.save',
  projectPath: 'C:\\work\\app',
  name: 'release-notes',
  description: 'Use when writing release notes.',
  instructions: 'Read the log.',
  overwrite: false,
};

describe('skill.save', () => {
  it('accepts a well-formed save and keeps unknown fields', () => {
    expect(parseCommand({ ...save, extra: 1 })).toEqual({ ...save, extra: 1 });
  });
  it.each(['../x', '..\\x', 'a/b', 'C:', 'Upper', '-x', '', 'a'.repeat(65), 'a.b', 'a b'])(
    'refuses the name %j',
    (name) => {
      expect(parseCommand({ ...save, name })).toBeNull();
    },
  );
  it('refuses a missing overwrite flag, empty or overlong text, a missing folder', () => {
    const { overwrite: _o, ...noFlag } = save;
    expect(parseCommand(noFlag)).toBeNull();
    expect(parseCommand({ ...save, overwrite: 'yes' })).toBeNull();
    expect(parseCommand({ ...save, description: '' })).toBeNull();
    expect(parseCommand({ ...save, description: 'd'.repeat(1025) })).toBeNull();
    expect(parseCommand({ ...save, instructions: 'i'.repeat(20_001) })).toBeNull();
    expect(parseCommand({ ...save, projectPath: '' })).toBeNull();
    expect(parseCommand({ ...save, projectPath: 'p'.repeat(1025) })).toBeNull();
  });
});

describe('huddle_task commands', () => {
  const create = {
    type: 'huddle_task.create',
    title: 'Do it',
    details: '',
    projectPath: 'C:\\work\\app',
    templateId: null,
  };
  it('accepts create, update, delete and launch', () => {
    expect(parseCommand(create)).toEqual(create);
    expect(parseCommand({ ...create, projectPath: null, templateId: 'tpl-1' })).not.toBeNull();
    expect(parseCommand({ type: 'huddle_task.update', taskId: 't1', status: 'done' })).not.toBeNull();
    expect(parseCommand({ type: 'huddle_task.update', taskId: 't1', projectPath: null })).not.toBeNull();
    expect(parseCommand({ type: 'huddle_task.delete', taskId: 't1' })).not.toBeNull();
    expect(parseCommand({ type: 'huddle_task.launch', taskId: 't1' })).not.toBeNull();
  });
  it('refuses empty titles, long text, statuses only a run may set, and missing ids', () => {
    expect(parseCommand({ ...create, title: '' })).toBeNull();
    expect(parseCommand({ ...create, title: 't'.repeat(201) })).toBeNull();
    expect(parseCommand({ ...create, details: 'd'.repeat(4001) })).toBeNull();
    expect(parseCommand({ ...create, templateId: undefined })).toBeNull();
    expect(parseCommand({ type: 'huddle_task.update', taskId: 't1', status: 'running' })).toBeNull();
    expect(parseCommand({ type: 'huddle_task.update', taskId: 't1', status: 'failed' })).toBeNull();
    expect(parseCommand({ type: 'huddle_task.launch' })).toBeNull();
    expect(parseCommand({ type: 'huddle_task.delete', taskId: '' })).toBeNull();
  });
});

describe('skills queries', () => {
  it('accepts skills.list and skill.read, refuses a bad name', () => {
    expect(parseQuery({ type: 'skills.list' })).toEqual({ type: 'skills.list' });
    expect(parseQuery({ type: 'skill.read', projectPath: 'C:\\work\\app', name: 'triage' })).not.toBeNull();
    expect(parseQuery({ type: 'skill.read', projectPath: 'C:\\work\\app', name: '../../x' })).toBeNull();
    expect(parseQuery({ type: 'skill.read', name: 'triage' })).toBeNull();
  });
});
