/**
 * F28/F29 commands through the Orchestrator with the real reducer and a fake launch path: tasks are made only in known
 * projects or with saved templates, launch goes through `launch` with the task text and links the run, the run's exit
 * writes the outcome back, and a skill is written only into a known project.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  agentKey,
  MAX_KNOWN_PROJECTS,
  selectHuddleTasks,
  TASKS_SESSION_ID,
  type CommandResult,
  type HuddleEvent,
  type TeamTemplate,
} from '@huddle/shared';
import { maskSecrets } from '../privacy/redact.js';
import { initialState, reduce, toHuddleState, type ReducerState } from '../state/reduce.js';
import { Orchestrator, TASK_REFUSALS } from './orchestrator.js';

let root = '';
let project = '';
let state: ReducerState;
let templates: TeamTemplate[];
let launches: { template: TeamTemplate; templateId: string | null; prompt: string | undefined }[];
let launchResult: CommandResult;
let accepted: HuddleEvent[];
let n = 0;

function apply(events: readonly HuddleEvent[]): void {
  for (const e of events) state = reduce(state, e);
}

function orch(): Orchestrator {
  return new Orchestrator({
    state: () => toHuddleState(state),
    templates: () => templates,
    accept: (events) => {
      accepted.push(...events);
      apply(events);
      return Promise.resolve(true);
    },
    nextId: () => `id-${String((n += 1))}`,
    now: () => 9000 + n,
    launch: (template, templateId, prompt) => {
      launches.push({ template, templateId, prompt });
      return Promise.resolve(launchResult);
    },
    skills: { claudeConfigDir: path.join(root, 'home', '.claude'), homeDir: path.join(root, 'home') },
  });
}

/** A session seen in `project`, so it is a known project. */
function seenSession(cwd: string): void {
  apply([
    {
      id: 's1',
      type: 'session.started',
      ts: 1000,
      sessionId: 'sess-1',
      agentKey: agentKey('sess-1'),
      source: 'hook',
      origin: 'attached',
      cwd,
      title: null,
      model: null,
      startKind: 'startup',
    },
  ]);
}

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'huddle-orch-')));
  project = path.join(root, 'work', 'app');
  await fs.mkdir(project, { recursive: true });
  state = initialState();
  templates = [];
  launches = [];
  accepted = [];
  launchResult = { ok: true, detail: '11111111-2222-4333-8444-555555555555' };
  seenSession(project);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
});

describe('tasks', () => {
  it('makes a task in a known project, on the tasks session, source user', async () => {
    const o = orch();
    const r = await o.command({
      type: 'huddle_task.create',
      title: '  Fix the flaky test ',
      details: 'login.spec',
      projectPath: project.toUpperCase(),
      templateId: null,
    });
    expect(r.ok).toBe(true);
    const e = accepted[0];
    expect(e).toMatchObject({
      type: 'huddle_task.created',
      sessionId: TASKS_SESSION_ID,
      agentKey: TASKS_SESSION_ID,
      source: 'user',
      title: 'Fix the flaky test',
      // The known path, not the casing the renderer sent.
      projectPath: project,
    });
    expect(r.ok && r.detail).toBe(e?.type === 'huddle_task.created' ? e.taskId : null);
  });

  it('refuses an unknown folder, an unknown template, neither, and a bad shape', async () => {
    const o = orch();
    const base = { type: 'huddle_task.create', title: 'x', details: '' } as const;
    expect(await o.command({ ...base, projectPath: path.join(root, 'other'), templateId: null })).toMatchObject({
      ok: false,
      message: TASK_REFUSALS.project,
    });
    expect(await o.command({ ...base, projectPath: null, templateId: 'nope' })).toMatchObject({
      ok: false,
      code: 'not_found',
    });
    expect(await o.command({ ...base, projectPath: null, templateId: null })).toMatchObject({
      ok: false,
      message: TASK_REFUSALS.where,
    });
    expect(await o.command({ type: 'huddle_task.create', title: '', details: '' })).toMatchObject({
      ok: false,
      code: 'invalid',
    });
    expect(accepted).toEqual([]);
  });

  it('launches a plain run in the project with the task text, links it, and records the outcome', async () => {
    const o = orch();
    const made = await o.command({
      type: 'huddle_task.create',
      title: 'Write the docs',
      details: 'For F29.',
      projectPath: project,
      templateId: null,
    });
    const taskId = made.ok ? (made.detail ?? '') : '';
    const r = await o.command({ type: 'huddle_task.launch', taskId });
    expect(r).toMatchObject({ ok: true, detail: launchResult.ok ? launchResult.detail : '' });
    expect(launches).toHaveLength(1);
    expect(launches[0]).toMatchObject({
      templateId: null,
      prompt: 'Write the docs\n\nFor F29.',
      template: { cwd: project, permissionMode: 'default', worktree: false, mainAgent: null, model: null },
    });
    const view = selectHuddleTasks(toHuddleState(state))[0];
    expect(view).toMatchObject({ status: 'running', runId: launchResult.ok ? launchResult.detail : '' });
    // Launching again while it runs is refused.
    expect(await o.command({ type: 'huddle_task.launch', taskId })).toMatchObject({
      ok: false,
      message: TASK_REFUSALS.running,
    });
    // The run's exit is written back to the task.
    const runId = launchResult.ok ? (launchResult.detail ?? '') : '';
    const exited: HuddleEvent = {
      id: 'x1',
      type: 'run.exited',
      ts: 9999,
      sessionId: runId,
      agentKey: runId,
      source: 'huddle',
      runId,
      exitCode: 1,
      how: 'failed',
      error: 'boom',
    };
    const back = o.runStep(exited);
    expect(back).toMatchObject([{ type: 'huddle_task.updated', taskId, status: 'failed', source: 'huddle' }]);
    apply(back);
    expect(o.runStep(exited)).toEqual([]);
    expect(selectHuddleTasks(toHuddleState(state))[0]?.status).toBe('failed');
  });

  it('launches with a template (its own folder when the task has none) and passes a refusal through', async () => {
    templates = [
      {
        id: 'tpl-1',
        name: 'Team',
        prompt: 'template prompt',
        cwd: project,
        mainAgent: null,
        model: 'sonnet',
        permissionMode: 'acceptEdits',
        worktree: true,
      },
    ];
    const o = orch();
    const made = await o.command({
      type: 'huddle_task.create',
      title: 'Refactor',
      details: '',
      projectPath: null,
      templateId: 'tpl-1',
    });
    const taskId = made.ok ? (made.detail ?? '') : '';
    launchResult = { ok: false, code: 'unsupported', message: 'Connect first.' };
    expect(await o.command({ type: 'huddle_task.launch', taskId })).toEqual(launchResult);
    expect(launches[0]).toMatchObject({ templateId: 'tpl-1', prompt: 'Refactor', template: { worktree: true } });
    expect(selectHuddleTasks(toHuddleState(state))[0]?.status).toBe('todo');
  });

  it('updates and deletes; marks done by hand', async () => {
    const o = orch();
    const made = await o.command({
      type: 'huddle_task.create',
      title: 'A',
      details: '',
      projectPath: project,
      templateId: null,
    });
    const taskId = made.ok ? (made.detail ?? '') : '';
    expect((await o.command({ type: 'huddle_task.update', taskId, title: 'B', status: 'done' })).ok).toBe(true);
    expect(selectHuddleTasks(toHuddleState(state))[0]).toMatchObject({ title: 'B', status: 'done' });
    expect(await o.command({ type: 'huddle_task.update', taskId, status: 'failed' })).toMatchObject({ ok: false });
    expect(await o.command({ type: 'huddle_task.update', taskId, projectPath: null })).toMatchObject({
      ok: false,
      message: TASK_REFUSALS.where,
    });
    expect((await o.command({ type: 'huddle_task.delete', taskId })).ok).toBe(true);
    expect(toHuddleState(state).huddleTasks).toEqual([]);
    expect(await o.command({ type: 'huddle_task.delete', taskId })).toMatchObject({ ok: false, code: 'not_found' });
  });
});

describe('task launch edge cases', () => {
  const SECRET = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz';
  const RAW = `Deploy with ANTHROPIC_API_KEY=${SECRET}`;
  const SHOWN = maskSecrets(RAW);

  async function makeTask(
    o: Orchestrator,
    title: string,
    over: { projectPath?: string | null; templateId?: string | null } = {},
  ): Promise<string> {
    const made = await o.command({
      type: 'huddle_task.create',
      title,
      details: '',
      projectPath: over.projectPath === undefined ? project : over.projectPath,
      templateId: over.templateId ?? null,
    });
    return made.ok ? (made.detail ?? '') : '';
  }

  it('refuses a task whose text still shows a masked secret (after a restart) and launches nothing', async () => {
    expect(SHOWN).toContain('<redacted>');
    const o = orch();
    const taskId = await makeTask(o, SHOWN);
    expect(await o.command({ type: 'huddle_task.launch', taskId })).toEqual({
      ok: false,
      code: 'invalid',
      message: TASK_REFUSALS.masked,
    });
    expect(launches).toEqual([]);
    expect(selectHuddleTasks(toHuddleState(state))[0]?.status).toBe('todo');
  });

  it("puts back the template's stored prompt when the task text is exactly its masked form", async () => {
    templates = [
      {
        id: 'tpl-1',
        name: 'Deploy',
        prompt: RAW,
        cwd: project,
        mainAgent: null,
        model: null,
        permissionMode: 'default',
        worktree: false,
      },
    ];
    const o = orch();
    const taskId = await makeTask(o, SHOWN, { projectPath: null, templateId: 'tpl-1' });
    expect((await o.command({ type: 'huddle_task.launch', taskId })).ok).toBe(true);
    expect(launches[0]?.prompt).toBe(RAW);
  });

  it('records the outcome at once when the run exited before the task was linked', async () => {
    const runId = launchResult.ok ? (launchResult.detail ?? '') : '';
    const o = new Orchestrator({
      state: () => toHuddleState(state),
      templates: () => templates,
      accept: (events) => {
        accepted.push(...events);
        apply(events);
        return Promise.resolve(true);
      },
      nextId: () => `id-${String((n += 1))}`,
      now: () => 9000 + n,
      launch: () => {
        // A fast auth failure: the run launched and exited before launch returned (RunHost uses the runId as the
        // session id).
        apply([
          {
            id: 'l1',
            type: 'run.launched',
            ts: 9001,
            sessionId: runId,
            agentKey: runId,
            source: 'huddle',
            runId,
            claudeSessionId: runId,
            templateId: null,
            cwd: project,
            model: null,
            permissionMode: 'default',
            mainAgent: null,
            agentNames: [],
            worktree: null,
          },
          {
            id: 'x1',
            type: 'run.exited',
            ts: 9002,
            sessionId: runId,
            agentKey: runId,
            source: 'huddle',
            runId,
            exitCode: 1,
            how: 'failed',
            error: 'Not logged in',
          },
        ]);
        return Promise.resolve(launchResult);
      },
      skills: { claudeConfigDir: path.join(root, 'home', '.claude'), homeDir: path.join(root, 'home') },
    });
    const taskId = await makeTask(o, 'Quick one');
    expect((await o.command({ type: 'huddle_task.launch', taskId })).ok).toBe(true);
    expect(toHuddleState(state).huddleTasks?.[0]).toMatchObject({ taskId, runId, status: 'failed' });
    expect(selectHuddleTasks(toHuddleState(state))[0]?.status).toBe('failed');
    // Not stuck: it can be launched again.
    expect((await o.command({ type: 'huddle_task.launch', taskId })).ok).toBe(true);
  });

  it('refuses a second Launch while the first is still starting, and allows one after it returns', async () => {
    let release: (r: CommandResult) => void = () => undefined;
    let calls = 0;
    const o = new Orchestrator({
      state: () => toHuddleState(state),
      templates: () => templates,
      accept: (events) => {
        apply(events);
        return Promise.resolve(true);
      },
      nextId: () => `id-${String((n += 1))}`,
      now: () => 9000 + n,
      launch: () => {
        calls += 1;
        return new Promise<CommandResult>((resolve) => (release = resolve));
      },
      skills: { claudeConfigDir: path.join(root, 'home', '.claude'), homeDir: path.join(root, 'home') },
    });
    const taskId = await makeTask(o, 'Paid run');
    const first = o.command({ type: 'huddle_task.launch', taskId });
    // Let the first launch reach the (still pending) launch path.
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toBe(1);
    expect(await o.command({ type: 'huddle_task.launch', taskId })).toEqual({
      ok: false,
      code: 'invalid',
      message: TASK_REFUSALS.launching,
    });
    expect(calls).toBe(1);
    // The first one fails (no run): the guard is cleared, so Launch works again.
    release({ ok: false, code: 'unsupported', message: 'Connect first.' });
    expect((await first).ok).toBe(false);
    const again = o.command({ type: 'huddle_task.launch', taskId });
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toBe(2);
    release(launchResult);
    expect((await again).ok).toBe(true);
  });
});

describe('more known projects than are listed', () => {
  it('still accepts a task and a skill in a project past MAX_KNOWN_PROJECTS', async () => {
    const tpl = (id: string, cwd: string): TeamTemplate => ({
      id,
      name: 't',
      prompt: 'p',
      cwd,
      mainAgent: null,
      model: null,
      permissionMode: 'default',
      worktree: false,
    });
    templates = Array.from({ length: MAX_KNOWN_PROJECTS + 5 }, (_, i) =>
      tpl(`tpl-${String(i)}`, path.join(root, 'many', `a${String(i).padStart(3, '0')}`)),
    );
    // Sorted by name, `zz-last` comes after every `a…` folder and the session's `app`.
    const last = path.join(root, 'many', 'zz-last');
    await fs.mkdir(last, { recursive: true });
    templates.push(tpl('tpl-last', last));
    const o = orch();
    expect(o.knownProjects().length).toBeGreaterThan(MAX_KNOWN_PROJECTS);
    const made = await o.command({
      type: 'huddle_task.create',
      title: 'Far down the list',
      details: '',
      projectPath: last,
      templateId: null,
    });
    expect(made.ok).toBe(true);
    const saved = await o.command({
      type: 'skill.save',
      projectPath: last,
      name: 'late',
      description: 'Use late.',
      instructions: 'Do it.',
      overwrite: false,
    });
    expect(saved.ok).toBe(true);
    const list = await o.query({ type: 'skills.list' });
    // The list shown stays capped.
    expect(list.ok && list.type === 'skills.list' ? list.answer.projects.length : null).toBe(MAX_KNOWN_PROJECTS);
  });
});

describe('skills through the orchestrator', () => {
  it('writes only into a known project and lists it', async () => {
    const o = orch();
    const cmd = {
      type: 'skill.save',
      projectPath: project,
      name: 'triage',
      description: 'Use when triaging bugs.',
      instructions: 'Ask for steps to reproduce.',
      overwrite: false,
    };
    expect((await o.command(cmd)).ok).toBe(true);
    const unknown = await o.command({ ...cmd, projectPath: path.join(root, 'work') });
    expect(unknown).toMatchObject({ ok: false, message: TASK_REFUSALS.project });
    const list = await o.query({ type: 'skills.list' });
    expect(list.ok && list.type === 'skills.list' ? list.answer.skills.map((s) => s.dirName) : null).toEqual([
      'triage',
    ]);
    const read = await o.query({ type: 'skill.read', projectPath: project, name: 'triage' });
    expect(read.ok && read.type === 'skill.read' ? read.skill.description : null).toBe('Use when triaging bugs.');
    expect(await o.query({ type: 'skill.read', projectPath: project, name: '../x' })).toMatchObject({ ok: false });
  });
});
