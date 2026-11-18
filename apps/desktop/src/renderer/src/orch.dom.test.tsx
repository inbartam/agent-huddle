// @vitest-environment happy-dom
/**
 * F28/F29 in happy-dom with real DOM events: Library › Skills (list, user skills read-only, New skill, the overwrite
 * confirmation, a bad name), Library › Tasks (create, Launch on and off with the reason, Open run, prefill), and the
 * Ask hand-offs ("Make a task from this", "Create skill from this"). File and answer text stays text.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  EMPTY_STATE,
  type AskAnswer,
  type CommandResult,
  type HuddleCommand,
  type HuddleQuery,
  type HuddleState,
  type HuddleTask,
  type QueryResult,
  type SkillsAnswer,
} from '@huddle/shared';
import { AskPanel } from './components/Ask.js';
import { Library } from './components/Shell.js';
import { SkillsPanel } from './components/Skills.js';
import { TasksPanel } from './components/Tasks.js';
import { byText, click, flush, mount, type, type Mounted } from './testing/dom.js';
import { XSS } from './testing/fixture.js';
import { CONNECTED } from './testing/interact-fixture.js';
import { ORCH_WORDS, taskDraftFromAsk } from './view/orch.js';

let mounted: Mounted | null = null;
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});

const PROJECT = 'C:\\work\\app';
const ANSWER: SkillsAnswer = {
  projects: [{ key: 'c:/work/app', path: PROJECT, name: 'app' }],
  skills: [
    {
      scope: 'project',
      projectPath: PROJECT,
      dirName: 'triage',
      name: 'triage',
      description: `Use when triaging ${XSS}`,
      file: `${PROJECT}\\.claude\\skills\\triage\\SKILL.md`,
      problem: null,
      editable: true,
    },
    {
      scope: 'user',
      projectPath: null,
      dirName: 'mine',
      name: 'mine',
      description: 'My own',
      file: 'C:\\Users\\me\\.claude\\skills\\mine\\SKILL.md',
      problem: null,
      editable: false,
    },
  ],
};

function recorder(results: CommandResult[] = []) {
  const commands: HuddleCommand[] = [];
  const send = (cmd: HuddleCommand): Promise<CommandResult> => {
    commands.push(cmd);
    return Promise.resolve(results.shift() ?? { ok: true });
  };
  return { commands, send };
}

function fakeQuery(answer: SkillsAnswer = ANSWER) {
  const queries: HuddleQuery[] = [];
  const query = (q: HuddleQuery): Promise<QueryResult> => {
    queries.push(q);
    if (q.type === 'skills.list') return Promise.resolve({ ok: true, type: 'skills.list', answer });
    if (q.type === 'skill.read') {
      return Promise.resolve({
        ok: true,
        type: 'skill.read',
        skill: { projectPath: PROJECT, name: q.name, description: 'Use when triaging', instructions: 'Ask for steps.' },
      });
    }
    return Promise.resolve({ ok: false, code: 'invalid', message: 'no' });
  };
  return { queries, query };
}

async function select(el: Element | null, value: string): Promise<void> {
  if (!(el instanceof HTMLSelectElement)) throw new Error('not a select');
  const { act } = await import('react');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(el, value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();
  });
}

function field(scope: ParentNode, label: string): HTMLElement | null {
  const l = byText(scope, 'label', label);
  const id = l?.getAttribute('for');
  return id ? document.getElementById(id) : null;
}

describe('Library › Skills', () => {
  it('lists project and user skills; the user skill cannot be edited; text stays text', async () => {
    const { query } = fakeQuery();
    mounted = await mount(<SkillsPanel query={query} onCommand={recorder().send} />);
    await flush();
    const c = mounted.container;
    expect(c.textContent).toContain('triage');
    expect(c.textContent).toContain(XSS);
    expect(c.querySelector('img')).toBeNull();
    expect(c.textContent).toContain(ORCH_WORDS.userSkill);
    const edits = [...c.querySelectorAll('button')].filter((b) => b.textContent === 'Edit');
    expect(edits).toHaveLength(2);
    expect(edits[1]?.getAttribute('aria-disabled')).toBe('true');
    expect(edits[1]?.getAttribute('title')).toBe(ORCH_WORDS.userSkillHint);
  });

  it('New skill: saves, asks before replacing an existing file, then replaces and reloads', async () => {
    const { query, queries } = fakeQuery();
    const rec = recorder([
      { ok: false, code: 'invalid', message: 'exists', exists: true },
      { ok: true, detail: 'file' },
    ]);
    mounted = await mount(<SkillsPanel query={query} onCommand={rec.send} />);
    await flush();
    const c = mounted.container;
    await click(byText(c, 'button', ORCH_WORDS.newSkill));
    await type(field(c, ORCH_WORDS.nameLabel), 'release-notes');
    await type(field(c, ORCH_WORDS.descriptionLabel), 'Use for release notes');
    await type(field(c, ORCH_WORDS.instructionsLabel), 'Read the log.');
    await click(byText(c, 'button', ORCH_WORDS.saveSkill));
    await flush();
    expect(rec.commands[0]).toEqual({
      type: 'skill.save',
      projectPath: PROJECT,
      name: 'release-notes',
      description: 'Use for release notes',
      instructions: 'Read the log.',
      overwrite: false,
    });
    expect(c.textContent).toContain(ORCH_WORDS.replaceAsk);
    await click(byText(c, 'button', ORCH_WORDS.replace));
    await flush();
    expect(rec.commands[1]).toMatchObject({ type: 'skill.save', overwrite: true });
    expect(c.textContent).toContain(ORCH_WORDS.saved);
    expect(queries.filter((q) => q.type === 'skills.list')).toHaveLength(2);
  });

  it('refuses a bad name in the form and sends nothing', async () => {
    const { query } = fakeQuery();
    const rec = recorder();
    mounted = await mount(<SkillsPanel query={query} onCommand={rec.send} />);
    await flush();
    const c = mounted.container;
    await click(byText(c, 'button', ORCH_WORDS.newSkill));
    await type(field(c, ORCH_WORDS.nameLabel), '../evil');
    await type(field(c, ORCH_WORDS.descriptionLabel), 'x');
    await type(field(c, ORCH_WORDS.instructionsLabel), 'y');
    await click(byText(c, 'button', ORCH_WORDS.saveSkill));
    await flush();
    expect(rec.commands).toEqual([]);
    expect(c.querySelector('[aria-invalid="true"]')).not.toBeNull();
  });

  it('Edit loads the file and keeps the name fixed', async () => {
    const { query, queries } = fakeQuery();
    mounted = await mount(<SkillsPanel query={query} onCommand={recorder().send} />);
    await flush();
    const c = mounted.container;
    await click([...c.querySelectorAll('button')].find((b) => b.textContent === 'Edit') ?? null);
    await flush();
    expect(queries).toContainEqual({ type: 'skill.read', projectPath: PROJECT, name: 'triage' });
    const name = field(c, ORCH_WORDS.nameLabel);
    expect((name as HTMLInputElement | null)?.readOnly).toBe(true);
    expect((field(c, ORCH_WORDS.instructionsLabel) as HTMLTextAreaElement | null)?.value).toBe('Ask for steps.');
  });
});

const task = (extra: Partial<HuddleTask> = {}): HuddleTask => ({
  taskId: 'task-1',
  title: `Fix it ${XSS}`,
  details: 'Details here',
  projectPath: PROJECT,
  templateId: null,
  status: 'todo',
  runId: null,
  createdAt: 1,
  updatedAt: 1,
  launchedAt: null,
  ...extra,
});

function tasksState(tasks: HuddleTask[], connected = true): HuddleState {
  return {
    ...EMPTY_STATE,
    ...(connected ? { connection: CONNECTED } : {}),
    templates: [],
    huddleTasks: tasks,
  };
}

describe('Library › Tasks', () => {
  it('makes a task in a known project', async () => {
    const rec = recorder();
    mounted = await mount(<TasksPanel state={tasksState([task()])} onCommand={rec.send} />);
    const c = mounted.container;
    await click(byText(c, 'button', ORCH_WORDS.newTask));
    await type(field(c, ORCH_WORDS.titleLabel), 'Write docs');
    await select(field(c, ORCH_WORDS.projectLabel), PROJECT);
    await click(byText(c, 'button', ORCH_WORDS.saveTask));
    await flush();
    expect(rec.commands).toEqual([
      { type: 'huddle_task.create', title: 'Write docs', details: '', projectPath: PROJECT, templateId: null },
    ]);
  });

  it('needs a folder or a template before it sends', async () => {
    const rec = recorder();
    mounted = await mount(<TasksPanel state={tasksState([])} onCommand={rec.send} />);
    const c = mounted.container;
    await click(byText(c, 'button', ORCH_WORDS.newTask));
    await type(field(c, ORCH_WORDS.titleLabel), 'Write docs');
    await click(byText(c, 'button', ORCH_WORDS.saveTask));
    expect(rec.commands).toEqual([]);
    expect(c.textContent).toContain(ORCH_WORDS.needsWhere);
  });

  it('draws details made from an Ask answer as text with bold and a list, never as HTML (2026-11-18)', async () => {
    const details = `Two sessions need you.\n\n- **Refactor the parser**: approval of \`npm test\`\n- ${XSS}`;
    mounted = await mount(<TasksPanel state={tasksState([task({ details })])} onCommand={recorder().send} />);
    const box = mounted.container.querySelector('.orch-details');
    expect(box?.querySelector('strong')?.textContent).toBe('Refactor the parser');
    expect(box?.querySelectorAll('li')).toHaveLength(2);
    expect(box?.querySelector('.md-code')?.textContent).toBe('npm test');
    expect(box?.textContent).not.toContain('**');
    expect(box?.querySelector('img')).toBeNull();
    expect(box?.textContent).toContain(XSS);
  });

  it('shows the status in words, launches, and offers Open run for a running task', async () => {
    const rec = recorder();
    const opened: string[] = [];
    mounted = await mount(<TasksPanel state={tasksState([task()])} onCommand={rec.send} />);
    const c = mounted.container;
    expect(c.textContent).toContain('To do');
    expect(c.textContent).toContain(XSS);
    expect(c.querySelector('img')).toBeNull();
    await click(byText(c, 'button', ORCH_WORDS.launch));
    await flush();
    expect(rec.commands).toEqual([{ type: 'huddle_task.launch', taskId: 'task-1' }]);
    expect(c.textContent).toContain(ORCH_WORDS.launched);

    // A running task (the state has its run): Launch is off with the reason, Open run opens the session.
    const RUN = 'run-1';
    const running: HuddleState = {
      ...tasksState([task({ runId: RUN, status: 'running' })]),
      agents: {
        [RUN]: {
          ...({} as HuddleState['agents'][string]),
          key: RUN,
          run: {
            runId: RUN,
            templateId: null,
            permissionMode: 'default',
            mainAgent: null,
            agentNames: [],
            worktree: null,
          },
        },
      },
    };
    await mounted.render(
      <TasksPanel
        state={running}
        onCommand={rec.send}

        onOpenRun={(k) => {
          opened.push(k);
        }}
      />,
    );
    const launch = byText(c, 'button', ORCH_WORDS.launch);
    expect(launch?.getAttribute('aria-disabled')).toBe('true');
    expect(launch?.getAttribute('title')).toBe(ORCH_WORDS.running);
    expect(c.textContent).toContain('Running');
    await click(byText(c, 'button', ORCH_WORDS.openRun));
    expect(opened).toEqual([RUN]);
  });

  it('turns Launch off with the connection reason when hooks are not attached', async () => {
    mounted = await mount(<TasksPanel state={tasksState([task()], false)} onCommand={recorder().send} />);
    const launch = byText(mounted.container, 'button', ORCH_WORDS.launch);
    expect(launch?.getAttribute('aria-disabled')).toBe('true');
    expect(launch?.getAttribute('title')).toBeTruthy();
  });

  it('opens the form filled in from an Ask answer', async () => {
    mounted = await mount(
      <TasksPanel
        state={tasksState([])}
        onCommand={recorder().send}

        prefill={taskDraftFromAsk('Why is the build slow?\nmore', 'Because of the cache.')}
      />,
    );
    expect((field(mounted.container, ORCH_WORDS.titleLabel) as HTMLInputElement | null)?.value).toBe(
      'Why is the build slow?',
    );
    expect((field(mounted.container, ORCH_WORDS.detailsLabel) as HTMLTextAreaElement | null)?.value).toBe(
      'Because of the cache.',
    );
  });
});

describe('Ask hand-offs', () => {
  const answer: AskAnswer = {
    text: 'Split the job.',
    model: 'claude-haiku-5-5',
    askedAt: 1,
    wallMs: 1,
    apiMs: 1,
    tokens: { input: 1, output: 1 },
    costUsd: 0.001,
    sent: 'sent',
  };
  it('hands the question and the answer to the task and skill forms; absent handlers show nothing', async () => {
    const tasks: string[][] = [];
    const skills: string[][] = [];
    const el = (withHandlers: boolean) => (
      <AskPanel
        enabled
        query={null}
        onCommand={recorder().send}
        onOpenSettings={() => undefined}
        layout="card"
        initial={{ turns: [{ question: 'How do I speed it up?', answer }], preview: { kind: 'failed', text: 'x' } }}
        {...(withHandlers
          ? {
              onMakeTask: (q: string, a: string) => {
                tasks.push([q, a]);
              },
              onMakeSkill: (q: string, a: string) => {
                skills.push([q, a]);
              },
            }
          : {})}
      />
    );
    mounted = await mount(el(false));
    expect(byText(mounted.container, 'button', ORCH_WORDS.makeTask)).toBeNull();
    await mounted.render(el(true));
    await click(byText(mounted.container, 'button', ORCH_WORDS.makeTask));
    await click(byText(mounted.container, 'button', ORCH_WORDS.makeSkill));
    expect(tasks).toEqual([['How do I speed it up?', 'Split the job.']]);
    expect(skills).toEqual([['How do I speed it up?', 'Split the job.']]);
  });
});

describe('Library tabs', () => {
  it('has Skills, Tasks and Roles after Templates and Rules', async () => {
    const picked: string[] = [];
    mounted = await mount(
      <Library
        tab="tasks"
        onTab={(t) => {
          picked.push(t);
        }}
      >
        <p>tasks</p>
      </Library>,
    );
    const tabs = [...mounted.container.querySelectorAll('[role="tab"]')].map((t) => t.textContent);
    expect(tabs).toEqual(['Templates', 'Rules', 'Skills', 'Tasks', 'Roles']);
    await click(byText(mounted.container, '[role="tab"]', 'Skills'));
    expect(picked).toEqual(['skills']);
  });
});
