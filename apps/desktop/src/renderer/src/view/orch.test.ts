/** F28/F29 renderer helpers: drafts to commands, the Launch control's reasons, and the Ask hand-off drafts. */
import { describe, expect, it } from 'vitest';
import type { HuddleTaskView, TeamTemplate } from '@huddle/shared';
import {
  ORCH_WORDS,
  skillDraftFromAsk,
  skillSaveOutcome,
  taskCreateCommand,
  taskDraftErrors,
  taskDraftFromAsk,
  taskLaunchControl,
} from './orch.js';

const view = (extra: Partial<HuddleTaskView> = {}): HuddleTaskView => ({
  taskId: 't',
  title: 'T',
  details: '',
  projectPath: 'C:/a',
  templateId: null,
  status: 'todo',
  runId: null,
  createdAt: 1,
  updatedAt: 1,
  launchedAt: null,
  runRootKey: null,
  ...extra,
});
const ON = { enabled: true, reason: null };
const PROJECTS = [{ key: 'c:/a', path: 'C:/a', name: 'a' }];
const TPL = { id: 'tpl' } as TeamTemplate;

describe('tasks', () => {
  it('builds commands with null for none, and checks the draft', () => {
    expect(taskCreateCommand({ title: ' x ', details: 'd', projectPath: '', templateId: 'tpl' })).toEqual({
      type: 'huddle_task.create',
      title: 'x',
      details: 'd',
      projectPath: null,
      templateId: 'tpl',
    });
    expect(taskDraftErrors({ title: '', details: '', projectPath: '', templateId: '' })).toEqual({
      title: ORCH_WORDS.needsTitle,
      where: ORCH_WORDS.needsWhere,
    });
  });
  it('says why Launch is off', () => {
    expect(taskLaunchControl(view(), ON, [], PROJECTS)).toEqual(ON);
    expect(taskLaunchControl(view({ status: 'running' }), ON, [], PROJECTS).reason).toBe(ORCH_WORDS.running);
    expect(taskLaunchControl(view(), { enabled: false, reason: 'Connect' }, [], PROJECTS).reason).toBe('Connect');
    expect(taskLaunchControl(view({ templateId: 'gone' }), ON, [TPL], PROJECTS).reason).toBe(ORCH_WORDS.templateGone);
    expect(taskLaunchControl(view({ projectPath: 'C:/b' }), ON, [], PROJECTS).reason).toBe(ORCH_WORDS.projectGone);
  });
  it('drafts from an Ask answer: first line as the title, never sent', () => {
    expect(taskDraftFromAsk('\n  Why?\nmore', ' Because. ')).toEqual({
      title: 'Why?',
      details: 'Because.',
      projectPath: '',
      templateId: '',
    });
  });
});

describe('skills', () => {
  it('drafts from an Ask answer and reads the save outcome', () => {
    expect(skillDraftFromAsk('Review PRs', 'Steps.')).toEqual({
      name: '',
      description: 'Review PRs',
      instructions: 'Steps.',
    });
    expect(skillSaveOutcome({ ok: true })).toEqual({ kind: 'done' });
    expect(skillSaveOutcome({ ok: false, code: 'invalid', message: 'm', exists: true })).toEqual({ kind: 'exists' });
    expect(skillSaveOutcome({ ok: false, code: 'failed', message: 'm' })).toEqual({ kind: 'error', text: 'm' });
  });
});

describe('bidi controls in drafts from an Ask answer (A5-02)', () => {
  it('strips direction overrides and isolates, keeps the zero-width joiner', () => {
    expect(skillDraftFromAsk('q‮', 'a‮b⁦c').instructions).toBe('abc');
    expect(skillDraftFromAsk('q‮x', 'a').description).toBe('qx');
    expect(taskDraftFromAsk('t⁩itle', 'de‪tails').title).toBe('title');
    expect(taskDraftFromAsk('t', 'de‪tails').details).toBe('details');
    expect(skillDraftFromAsk('q', 'a‍b').instructions).toBe('a‍b');
  });
});
