/**
 * Library › Skills and Library › Tasks (F28, F29): the words, drafts and commands the two panels use, pure so the tests
 * and the panels agree. Every string that comes from a file, a task or an Ask answer is rendered as text.
 */
import {
  ASK_QUESTION_MAX,
  HUDDLE_TASK_DETAILS_MAX,
  HUDDLE_TASK_TITLE_MAX,
  SKILL_DESCRIPTION_MAX,
  SKILL_INSTRUCTIONS_MAX,
  type CommandResult,
  type ControlState,
  type HuddleCommand,
  type HuddleTask,
  type HuddleTaskView,
  type KnownProject,
  type SkillDraft,
  type TeamTemplate,
} from '@huddle/shared';
import { stripBidi } from './markdown.js';

export const ORCH_WORDS = {
  skillsTitle: 'Skills',
  skillsIntro:
    'Claude Code skills in the projects Huddle knows, and your own. Huddle writes only into a project’s .claude/skills folder.',
  newSkill: 'New skill',
  editSkill: 'Edit skill',
  saveSkill: 'Save skill',
  replace: 'Replace it',
  replaceAsk: 'A skill with this name is already in that project. Replace its SKILL.md?',
  userSkill: 'Yours (read-only)',
  userSkillHint: 'Your own skills folder belongs to Claude Code; Huddle never edits it.',
  noProjects: 'Huddle knows no project folder yet. Run a session or save a template in one first.',
  noSkills: 'No skills yet.',
  loading: 'Reading skills…',
  saved: 'Skill saved.',
  projectLabel: 'Project folder',
  nameLabel: 'Name',
  nameNote: 'Lower case letters, digits and "-". It becomes the folder name.',
  descriptionLabel: 'When to use it',
  instructionsLabel: 'Instructions',
  tasksTitle: 'Tasks',
  tasksIntro: 'Work for Huddle to hand out: each task launches a run (from a template, or a plain one in its folder).',
  newTask: 'New task',
  editTask: 'Edit task',
  saveTask: 'Save task',
  noTasks: 'No tasks yet. Make one here, or from an answer of Ask the Huddle.',
  titleLabel: 'Title',
  detailsLabel: 'Details',
  templateLabel: 'Template',
  noTemplate: 'None: a plain run in the folder',
  templateFolder: 'The template’s own folder',
  launch: 'Launch',
  launching: 'Launching…',
  launched: 'Launch sent. The run shows up in the team when it starts.',
  taskDeleted: 'This task was deleted',
  markDone: 'Mark done',
  reopen: 'To do again',
  openRun: 'Open run',
  deleteAsk: 'Delete this task?',
  running: 'This task is running.',
  templateGone: 'Its template is no longer saved. Edit the task to pick another.',
  projectGone: 'Huddle no longer knows its folder. Edit the task to pick another.',
  needsWhere: 'Pick a project folder or a template.',
  needsTitle: 'Give the task a title.',
  makeTask: 'Make a task from this',
  makeSkill: 'Create skill from this',
} as const;

const ON: ControlState = { enabled: true, reason: null };
const off = (reason: string): ControlState => ({ enabled: false, reason });

// --- tasks ----------------------------------------------------------------------------------------------------------

/** The task form. `projectPath` and `templateId` are '' for none. */
export interface TaskDraft {
  title: string;
  details: string;
  projectPath: string;
  templateId: string;
}

export const EMPTY_TASK_DRAFT: TaskDraft = { title: '', details: '', projectPath: '', templateId: '' };

export type TaskDraftErrors = Partial<Record<'title' | 'where', string>>;

export function taskDraftErrors(d: TaskDraft): TaskDraftErrors {
  const errors: TaskDraftErrors = {};
  if (d.title.trim() === '') errors.title = ORCH_WORDS.needsTitle;
  if (d.projectPath === '' && d.templateId === '') errors.where = ORCH_WORDS.needsWhere;
  return errors;
}

export function draftFromTask(t: HuddleTask): TaskDraft {
  return { title: t.title, details: t.details, projectPath: t.projectPath ?? '', templateId: t.templateId ?? '' };
}

const orNull = (s: string): string | null => (s === '' ? null : s);

export function taskCreateCommand(d: TaskDraft): HuddleCommand {
  return {
    type: 'huddle_task.create',
    title: d.title.trim().slice(0, HUDDLE_TASK_TITLE_MAX),
    details: d.details.slice(0, HUDDLE_TASK_DETAILS_MAX),
    projectPath: orNull(d.projectPath),
    templateId: orNull(d.templateId),
  };
}

export function taskUpdateCommand(taskId: string, d: TaskDraft): HuddleCommand {
  return {
    type: 'huddle_task.update',
    taskId,
    title: d.title.trim().slice(0, HUDDLE_TASK_TITLE_MAX),
    details: d.details.slice(0, HUDDLE_TASK_DETAILS_MAX),
    projectPath: orNull(d.projectPath),
    templateId: orNull(d.templateId),
  };
}

/**
 * Launch for one task: off while it runs, off when the launch path is off (its reason), when its template is gone, or
 * when its folder is no longer a known project.
 */
export function taskLaunchControl(
  task: HuddleTaskView,
  launch: ControlState,
  templates: readonly TeamTemplate[],
  projects: readonly KnownProject[],
): ControlState {
  if (task.status === 'running') return off(ORCH_WORDS.running);
  if (!launch.enabled) return launch;
  if (task.templateId !== null && !templates.some((t) => t.id === task.templateId)) return off(ORCH_WORDS.templateGone);
  if (task.projectPath !== null && !projects.some((p) => p.path === task.projectPath)) {
    return off(ORCH_WORDS.projectGone);
  }
  return ON;
}

function firstLine(text: string): string {
  return (
    stripBidi(text)
      .split(/\r?\n/)
      .find((l) => l.trim() !== '') ?? ''
  ).trim();
}

/** "Make a task from this" on an Ask answer: the question as the title, the answer as the details. Never sent. */
export function taskDraftFromAsk(question: string, answer: string): TaskDraft {
  return {
    title: firstLine(question).slice(0, HUDDLE_TASK_TITLE_MAX),
    details: stripBidi(answer).trim().slice(0, HUDDLE_TASK_DETAILS_MAX),
    projectPath: '',
    templateId: '',
  };
}

// --- skills ---------------------------------------------------------------------------------------------------------

export const EMPTY_SKILL_DRAFT: SkillDraft = { name: '', description: '', instructions: '' };

/** "Create skill from this" on an Ask answer: the answer as the instructions; the user names it. Never sent. */
export function skillDraftFromAsk(question: string, answer: string): SkillDraft {
  return {
    name: '',
    description: firstLine(question).slice(0, Math.min(SKILL_DESCRIPTION_MAX, ASK_QUESTION_MAX)),
    instructions: stripBidi(answer).trim().slice(0, SKILL_INSTRUCTIONS_MAX),
  };
}

export function skillSaveCommand(projectPath: string, d: SkillDraft, overwrite: boolean): HuddleCommand {
  return {
    type: 'skill.save',
    projectPath,
    name: d.name.trim(),
    description: d.description.trim(),
    instructions: d.instructions,
    overwrite,
  };
}

export type SkillSaveOutcome = { kind: 'done' } | { kind: 'exists' } | { kind: 'error'; text: string };

export function skillSaveOutcome(r: CommandResult): SkillSaveOutcome {
  if (r.ok) return { kind: 'done' };
  if (r.exists === true) return { kind: 'exists' };
  return { kind: 'error', text: r.message };
}
