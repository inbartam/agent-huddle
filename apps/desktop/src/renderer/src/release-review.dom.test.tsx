// @vitest-environment happy-dom
/**
 * Release review fixes in happy-dom with real DOM events: Launch on a task is off until its command answers (no
 * second paid run), the Ask prefill is used once, editing a task that was deleted meanwhile closes instead of
 * re-creating it, the explanation stays hidden after a switch to Simple, the session view falls back to Live for a
 * tab it does not offer, and Stop asks before it stops.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  EMPTY_STATE,
  selectProjects,
  selectSessionIdentity,
  type AgentKey,
  type CommandResult,
  type HuddleCommand,
  type HuddleState,
  type HuddleTask,
} from '@huddle/shared';
import { Home } from './components/Home.js';
import { SessionView, type SessionViewProps } from './components/SessionView.js';
import { TasksPanel } from './components/Tasks.js';
import { settled } from './testing/arming.js';
import { byText, click, flush, mount, type Mounted } from './testing/dom.js';
import { CONNECTED, interactState, IK, NOW } from './testing/interact-fixture.js';
import { m4State, MK, NOW_M4 } from './testing/m4-fixture.js';
import { ORCH_WORDS, taskDraftFromAsk } from './view/orch.js';
import { VIEW_MODE_WORDS } from './view/prefs.js';
import { treeOptions } from './view/summary.js';
import { ViewModeProvider, ViewModeSwitch } from './viewMode.js';

let mounted: Mounted | null = null;
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});

const noop = () => undefined;
const ok = () => Promise.resolve({ ok: true as const });
const PROJECT = 'C:\\work\\app';

const task = (extra: Partial<HuddleTask> = {}): HuddleTask => ({
  taskId: 'task-1',
  title: 'Fix it',
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

function tasksState(tasks: HuddleTask[]): HuddleState {
  return { ...EMPTY_STATE, connection: CONNECTED, templates: [], huddleTasks: tasks };
}

function field(scope: ParentNode, label: string): HTMLInputElement | null {
  const id = byText(scope, 'label', label)?.getAttribute('for');
  const el = id ? document.getElementById(id) : null;
  return el instanceof HTMLInputElement ? el : null;
}

/** A command answer the test settles by hand. */
function deferred() {
  const commands: HuddleCommand[] = [];
  const pending: ((r: CommandResult) => void)[] = [];
  const fails: ((e: Error) => void)[] = [];
  const send = (cmd: HuddleCommand): Promise<CommandResult> => {
    commands.push(cmd);
    return new Promise<CommandResult>((resolve, reject) => {
      pending.push(resolve);
      fails.push(reject);
    });
  };
  return { commands, send, pending, fails };
}

describe('Tasks: Launch', () => {
  it('a second press while the first launch is on its way sends nothing; Launch comes back when it answers', async () => {
    const rec = deferred();
    mounted = await mount(<TasksPanel state={tasksState([task()])} onCommand={rec.send} />);
    const c = mounted.container;
    await click(byText(c, 'button', ORCH_WORDS.launch));
    const busy = byText(c, 'button', ORCH_WORDS.launching);
    expect(busy?.getAttribute('aria-disabled')).toBe('true');
    await click(busy);
    await click(busy);
    expect(rec.commands).toEqual([{ type: 'huddle_task.launch', taskId: 'task-1' }]);

    rec.pending[0]?.({ ok: true });
    await flush();
    const again = byText(c, 'button', ORCH_WORDS.launch);
    expect(again?.getAttribute('aria-disabled')).toBeNull();
    expect(c.textContent).toContain(ORCH_WORDS.launched);
  });

  it('a launch that fails turns Launch back on', async () => {
    const rec = deferred();
    mounted = await mount(<TasksPanel state={tasksState([task()])} onCommand={rec.send} />);
    const c = mounted.container;
    await click(byText(c, 'button', ORCH_WORDS.launch));
    rec.fails[0]?.(new Error('bridge gone'));
    await flush();
    expect(byText(c, 'button', ORCH_WORDS.launch)?.getAttribute('aria-disabled')).toBeNull();
    expect(c.querySelector('[role="alert"]')).not.toBeNull();
  });
});

describe('Tasks: editor', () => {
  it('uses the Ask prefill once: after Cancel, New task opens empty', async () => {
    mounted = await mount(
      <TasksPanel
        state={tasksState([])}
        onCommand={ok}

        prefill={taskDraftFromAsk('Why is the build slow?', 'Because of the cache.')}
      />,
    );
    const c = mounted.container;
    expect(field(c, ORCH_WORDS.titleLabel)?.value).toBe('Why is the build slow?');
    await click(byText(c, 'button', 'Cancel'));
    await click(byText(c, 'button', ORCH_WORDS.newTask));
    expect(field(c, ORCH_WORDS.titleLabel)?.value).toBe('');
  });

  it('closes the editor of a task deleted meanwhile and never sends a create', async () => {
    const commands: HuddleCommand[] = [];
    const send = (cmd: HuddleCommand): Promise<CommandResult> => {
      commands.push(cmd);
      return Promise.resolve({ ok: true });
    };
    mounted = await mount(<TasksPanel state={tasksState([task()])} onCommand={send} />);
    const c = mounted.container;
    await click(byText(c, 'button', 'Edit'));
    expect(field(c, ORCH_WORDS.titleLabel)?.value).toBe('Fix it');

    await mounted.render(<TasksPanel state={tasksState([])} onCommand={send} />);
    expect(field(c, ORCH_WORDS.titleLabel)).toBeNull();
    expect(byText(c, 'button', ORCH_WORDS.saveTask)).toBeNull();
    expect(c.textContent).toContain(ORCH_WORDS.taskDeleted);
    expect(commands).toEqual([]);
  });
});

function identityOf(state: HuddleState, now: number) {
  return (key: AgentKey) => selectSessionIdentity(state, key, now, {});
}

describe('Explain this screen', () => {
  it('hides the explanation when the view switches to Simple while the screen is open', async () => {
    const state = interactState();
    mounted = await mount(
      <ViewModeProvider store={null} initial="advanced">
        <ViewModeSwitch />
        <Home
          projects={selectProjects(state, treeOptions(state))}
          now={NOW}
          identity={identityOf(state, NOW)}
          onStart={noop}
          onHistory={noop}
          onOpenSession={noop}
          askEnabled={false}
          askStatus={null}
          query={null}
          onCommand={ok}
          onOpenAskSettings={noop}
          askPrefill={null}
          explainStore={null}
        />
      </ViewModeProvider>,
    );
    const c = mounted.container;
    expect(c.querySelector('.explain-note')).not.toBeNull();
    await click(byText(c, 'button', VIEW_MODE_WORDS.simple));
    expect(c.querySelector('.explain-note')).toBeNull();
    // Asked for in Simple, it shows.
    await click(c.querySelector('.explain-button'));
    expect(c.querySelector('.explain-note')).not.toBeNull();
  });
});

function session(state: HuddleState, agentKey: AgentKey, now: number, extra: Partial<SessionViewProps> = {}) {
  return settled(
    <SessionView
      state={state}
      agentKey={agentKey}
      renames={new Map()}
      now={now}
      query={null}
      onCommand={ok}
      onRename={ok}
      onSelect={noop}
      onHome={noop}
      section="now"
      onSection={noop}
      timeline={{ rows: [], loading: false }}
      filter="all"
      onFilter={noop}
      lastHoldEnding={null}
      onMakeRule={noop}
      {...extra}
    />,
  );
}

describe('Session view', () => {
  it('a tab the session does not offer (Report before the run ended) falls back to Live', async () => {
    mounted = await mount(session(interactState(), IK.main, NOW, { initialTab: 'report' }));
    const c = mounted.container;
    expect(byText(c, '[role="tab"]', 'Report')).toBeNull();
    expect(byText(c, '[role="tab"]', 'Live')?.getAttribute('aria-selected')).toBe('true');
    expect(c.querySelector('.session-live')).not.toBeNull();
  });

  it('Stop asks first: No sends nothing, Yes stops the run', async () => {
    const commands: HuddleCommand[] = [];
    const send = (cmd: HuddleCommand): Promise<CommandResult> => {
      commands.push(cmd);
      return Promise.resolve({ ok: true });
    };
    mounted = await mount(session(m4State(), MK.run, NOW_M4, { onCommand: send }));
    const c = mounted.container;
    await click(byText(c, 'button', 'Stop'));
    expect(commands).toEqual([]);
    expect(c.querySelector('[aria-label="Confirm stopping this run"]')).not.toBeNull();
    await click(byText(c, 'button', 'No'));
    expect(commands).toEqual([]);
    expect(c.querySelector('[aria-label="Confirm stopping this run"]')).toBeNull();

    await click(byText(c, 'button', 'Stop'));
    await click(byText(c, 'button', 'Yes'));
    expect(commands).toHaveLength(1);
    expect(commands[0]?.type).toBe('run.stop');
  });
});
