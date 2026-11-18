/**
 * The Huddle as orchestrator (F28 skills, F29 tasks): the commands and queries HuddleCore hands over. Side effects
 * live here (files through runtime/skills.ts, events through `accept`); what the state looks like is the reducer's
 * (`huddle_task.*`), and what is shown is the shared selectors' (orch.ts).
 *
 * Tasks: every change is one `huddle_task.*` event on the Huddle's own tasks session (TASKS_SESSION_ID), source user.
 * Launch goes through the normal launch path (`RunHost.launch`, the same as `run.launch`): the task's template with the
 * task text as the prompt override (in the task's project when it has one), or a plain run in its project (default
 * permission mode, no worktree, no agents). The run's outcome is written back as `huddle_task.updated` (source huddle)
 * when its `run.exited` goes through the core (`runStep`), so the status survives the run leaving the state.
 *
 * Skills: the folder a skill is read from or written to must be one of `selectKnownProjects` at that moment (the
 * renderer only names it); everything about the path is checked again in runtime/skills.ts. Writes run one at a time.
 */
import {
  findKnownProject,
  MAX_HUDDLE_TASKS,
  MAX_KNOWN_PROJECTS,
  runTaskStatus,
  selectHuddleTasks,
  selectKnownProjects,
  TASKS_SESSION_ID,
  taskPrompt,
  type CommandResult,
  type EventOfType,
  type HuddleEvent,
  type HuddleState,
  type HuddleTask,
  type KnownProject,
  type QueryResult,
  type TeamTemplate,
} from '@huddle/shared';
import { parseOrchCommand, parseOrchQuery } from '../contracts/orch-schemas.js';
import { REDACTED } from '../privacy/redact.js';
import { listSkills, readProjectSkill, saveProjectSkill, type SkillsDeps } from './skills.js';
import { restoreMaskedPrompt } from './templates.js';

export interface OrchestratorDeps {
  /** The reducer's state as the UI sees it, with the saved templates. */
  state: () => HuddleState;
  templates: () => readonly TeamTemplate[];
  accept: (events: readonly HuddleEvent[]) => Promise<boolean>;
  nextId: () => string;
  now: () => number;
  /** The launch path of `run.launch` (RunHost.launch). */
  launch: (template: TeamTemplate, templateId: string | null, promptOverride?: string) => Promise<CommandResult>;
  skills: SkillsDeps;
}

type Failure = Extract<CommandResult, { ok: false }>;
const fail = (code: Failure['code'], message: string): Failure => ({ ok: false, code, message });

export const TASK_REFUSALS = {
  invalid: 'That task is not well formed.',
  unknown: 'That task is not in the list.',
  project: 'Pick one of the project folders Huddle knows.',
  template: 'That template is not saved.',
  where: 'Pick a project folder or a template for this task.',
  full: `At most ${String(MAX_HUDDLE_TASKS)} tasks can be kept. Delete some first.`,
  running: 'This task is already running.',
  launching: 'This task is already starting.',
  unsaved: 'The task changed here but could not be saved; it is lost on restart.',
  masked:
    'This task still shows <redacted> where Huddle hid a secret. Edit the task and type the secret again, then launch.',
} as const;

export class Orchestrator {
  private skillQueue: Promise<unknown> = Promise.resolve();
  /** Tasks whose launch has started and not yet returned. */
  private readonly launching = new Set<string>();

  constructor(private readonly deps: OrchestratorDeps) {}

  knownProjects(): KnownProject[] {
    return selectKnownProjects({ ...this.deps.state(), templates: [...this.deps.templates()] });
  }

  private tasks(): HuddleTask[] {
    return this.deps.state().huddleTasks ?? [];
  }

  private envelope(source: 'user' | 'huddle') {
    return {
      id: this.deps.nextId(),
      ts: this.deps.now(),
      sessionId: TASKS_SESSION_ID,
      agentKey: TASKS_SESSION_ID,
      source,
    };
  }

  /** Checks a project/template pair; the project comes back as the known path (never the one the renderer sent). */
  private where(
    projectPath: string | null | undefined,
    templateId: string | null | undefined,
  ): { ok: true; projectPath: string | null | undefined; templateId: string | null | undefined } | Failure {
    let path = projectPath;
    if (typeof projectPath === 'string') {
      const known = findKnownProject(this.knownProjects(), projectPath);
      if (known === null) return fail('invalid', TASK_REFUSALS.project);
      path = known.path;
    }
    if (typeof templateId === 'string' && !this.deps.templates().some((t) => t.id === templateId)) {
      return fail('not_found', TASK_REFUSALS.template);
    }
    return { ok: true, projectPath: path, templateId };
  }

  private async save(event: HuddleEvent, detail?: string): Promise<CommandResult> {
    const saved = await this.deps.accept([event]);
    if (!saved) return fail('failed', TASK_REFUSALS.unsaved);
    return detail === undefined ? { ok: true } : { ok: true, detail };
  }

  /** `skill.save` and `huddle_task.*`. Never rejects. */
  async command(cmd: unknown): Promise<CommandResult> {
    const parsed = parseOrchCommand(cmd);
    if (parsed === null) return fail('invalid', 'That command is not well formed.');
    switch (parsed.type) {
      case 'skill.save': {
        const project = findKnownProject(this.knownProjects(), parsed.projectPath);
        if (project === null) return fail('invalid', TASK_REFUSALS.project);
        const draft = { name: parsed.name, description: parsed.description, instructions: parsed.instructions };
        const run = this.skillQueue.then(() => saveProjectSkill(project, draft, parsed.overwrite, this.deps.skills));
        this.skillQueue = run.catch(() => undefined);
        return run;
      }
      case 'huddle_task.create': {
        if (parsed.title.trim() === '') return fail('invalid', TASK_REFUSALS.invalid);
        if (parsed.projectPath === null && parsed.templateId === null) return fail('invalid', TASK_REFUSALS.where);
        if (this.tasks().length >= MAX_HUDDLE_TASKS) return fail('invalid', TASK_REFUSALS.full);
        const where = this.where(parsed.projectPath, parsed.templateId);
        if (!where.ok) return where;
        const taskId = `task-${this.deps.nextId()}`;
        return this.save(
          {
            ...this.envelope('user'),
            type: 'huddle_task.created',
            taskId,
            title: parsed.title.trim(),
            details: parsed.details,
            projectPath: where.projectPath ?? null,
            templateId: where.templateId ?? null,
          },
          taskId,
        );
      }
      case 'huddle_task.update': {
        const task = this.tasks().find((t) => t.taskId === parsed.taskId);
        if (task === undefined) return fail('not_found', TASK_REFUSALS.unknown);
        if (parsed.title?.trim() === '') return fail('invalid', TASK_REFUSALS.invalid);
        const where = this.where(parsed.projectPath, parsed.templateId);
        if (!where.ok) return where;
        const project = where.projectPath === undefined ? task.projectPath : where.projectPath;
        const template = where.templateId === undefined ? task.templateId : where.templateId;
        if (project === null && template === null) return fail('invalid', TASK_REFUSALS.where);
        const event: EventOfType<'huddle_task.updated'> = {
          ...this.envelope('user'),
          type: 'huddle_task.updated',
          taskId: task.taskId,
        };
        if (parsed.title !== undefined) event.title = parsed.title.trim();
        if (parsed.details !== undefined) event.details = parsed.details;
        if (where.projectPath !== undefined) event.projectPath = where.projectPath;
        if (where.templateId !== undefined) event.templateId = where.templateId;
        if (parsed.status !== undefined) event.status = parsed.status;
        return this.save(event);
      }
      case 'huddle_task.delete': {
        if (!this.tasks().some((t) => t.taskId === parsed.taskId)) return fail('not_found', TASK_REFUSALS.unknown);
        return this.save({ ...this.envelope('user'), type: 'huddle_task.deleted', taskId: parsed.taskId });
      }
      case 'huddle_task.launch':
        return this.launch(parsed.taskId);
    }
  }

  /**
   * A second Launch while the first is still on its way (before its run is linked, so the task does not show running
   * yet) is refused: each launch starts a paid run.
   */
  private async launch(taskId: string): Promise<CommandResult> {
    if (this.launching.has(taskId)) return fail('invalid', TASK_REFUSALS.launching);
    this.launching.add(taskId);
    try {
      return await this.launchOnce(taskId);
    } finally {
      this.launching.delete(taskId);
    }
  }

  private async launchOnce(taskId: string): Promise<CommandResult> {
    const task = this.tasks().find((t) => t.taskId === taskId);
    if (task === undefined) return fail('not_found', TASK_REFUSALS.unknown);
    const view = selectHuddleTasks(this.deps.state()).find((t) => t.taskId === taskId);
    if (view?.status === 'running') return fail('invalid', TASK_REFUSALS.running);
    let project: KnownProject | null = null;
    if (task.projectPath !== null) {
      project = findKnownProject(this.knownProjects(), task.projectPath);
      if (project === null) return fail('invalid', TASK_REFUSALS.project);
    }
    // The store masks secret-shaped text on write, so after a restart the task text may show <redacted> where a secret
    // was. Put back a stored template prompt it is the masked form of (the run.launch rule), else refuse: launching it
    // would send the word "<redacted>" instead of the secret. (A task typed with a literal "<redacted>" is refused too.)
    const prompt = restoreMaskedPrompt(taskPrompt(task), this.deps.templates(), {
      templateId: task.templateId,
      agent: null,
    });
    if (prompt === null || prompt.includes(REDACTED)) {
      return fail('invalid', TASK_REFUSALS.masked);
    }
    let template: TeamTemplate;
    let templateId: string | null = null;
    if (task.templateId !== null) {
      const saved = this.deps.templates().find((t) => t.id === task.templateId);
      if (saved === undefined) return fail('not_found', TASK_REFUSALS.template);
      template = project === null ? saved : { ...saved, cwd: project.path };
      templateId = saved.id;
    } else {
      if (project === null) return fail('invalid', TASK_REFUSALS.where);
      template = {
        id: task.taskId,
        name: task.title,
        prompt,
        cwd: project.path,
        mainAgent: null,
        model: null,
        permissionMode: 'default',
        worktree: false,
      };
    }
    const result = await this.deps.launch(template, templateId, prompt);
    if (!result.ok || typeof result.detail !== 'string' || result.detail === '') return result;
    const runId = result.detail;
    const events: HuddleEvent[] = [
      {
        ...this.envelope('user'),
        type: 'huddle_task.updated',
        taskId,
        runId,
        status: 'running',
        launchedAt: this.deps.now(),
      },
    ];
    // A run that failed fast (login, bad arguments) exited before this link existed, so `runStep` matched no task:
    // write its outcome now, or the task would stay running for good.
    const live = runTaskStatus(this.deps.state(), runId);
    if (live === 'done' || live === 'failed') {
      events.push({ ...this.envelope('huddle'), type: 'huddle_task.updated', taskId, status: live });
    }
    const linked = await this.deps.accept(events);
    return linked ? result : { ...result, warning: TASK_REFUSALS.unsaved };
  }

  /** `skills.list` and `skill.read`. Never rejects. */
  async query(q: unknown): Promise<QueryResult> {
    const parsed = parseOrchQuery(q);
    if (parsed === null) return { ok: false, code: 'invalid', message: 'That query is not well formed.' };
    try {
      if (parsed.type === 'skills.list') {
        const listed = this.knownProjects().slice(0, MAX_KNOWN_PROJECTS);
        return { ok: true, type: 'skills.list', answer: await listSkills(listed, this.deps.skills) };
      }
      const project = findKnownProject(this.knownProjects(), parsed.projectPath);
      if (project === null) return { ok: false, code: 'invalid', message: TASK_REFUSALS.project };
      const read = await readProjectSkill(project, parsed.name, this.deps.skills);
      if (!read.ok) {
        const code = read.code === 'not_found' ? 'not_found' : read.code === 'invalid' ? 'invalid' : 'failed';
        return { ok: false, code, message: read.message };
      }
      return { ok: true, type: 'skill.read', skill: read.skill };
    } catch {
      return { ok: false, code: 'failed', message: 'The skills could not be read.' };
    }
  }

  /**
   * After a run's `run.exited`: the tasks linked to it whose recorded status is still running get the run's outcome
   * (source huddle). Pure apart from the ids and the clock; the caller accepts what comes back.
   */
  runStep(event: HuddleEvent): HuddleEvent[] {
    if (event.type !== 'run.exited') return [];
    const status = event.how === 'completed' ? 'done' : 'failed';
    return this.tasks()
      .filter((t) => t.runId === event.runId && t.status === 'running')
      .map((t) => ({ ...this.envelope('huddle'), type: 'huddle_task.updated', taskId: t.taskId, status }));
  }
}
