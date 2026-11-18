// @vitest-environment happy-dom
/**
 * "Start a typed team" in Library > Templates: a preset button opens the new-template editor with the team's agents
 * filled in, the folder left empty; saving goes through the usual template.upsert.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { HuddleCommand } from '@huddle/shared';
import { TemplatesPanel } from './components/Templates.js';
import { byText, click, flush, mount, type Mounted } from './testing/dom.js';
import { m4State } from './testing/m4-fixture.js';

let mounted: Mounted | null = null;
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});

describe('Templates, start a typed team', () => {
  it('a preset opens the editor with its agents filled in', async () => {
    const sent: HuddleCommand[] = [];
    const onCommand = (cmd: HuddleCommand) => {
      sent.push(cmd);
      return Promise.resolve({ ok: true } as const);
    };
    mounted = await mount(<TemplatesPanel state={m4State()} onCommand={onCommand} query={null} />);
    const c = mounted.container;
    await click(byText(c, 'button', 'Design, build, review'));

    const editor = c.querySelector('section.template-editor');
    expect(editor?.getAttribute('aria-label')).toBe('New template');
    const drafts = [...c.querySelectorAll('.agent-draft')];
    const names = drafts.map((d) => d.querySelector<HTMLInputElement>('input[id$="-name"]')?.value);
    expect(names).toEqual(['designer', 'builder', 'reviewer']);
    const prompt = c.querySelector<HTMLTextAreaElement>('textarea[id$="-prompt"]');
    expect(prompt?.value).toContain('the designer, the builder and the reviewer');
    const cwd = c.querySelector<HTMLInputElement>('input[id$="-cwd"]');
    expect(cwd?.value).toBe('');

    // Nothing is sent until the user saves; without a folder the save is refused in the form.
    await click(byText(c, 'button', 'Save template'));
    await flush();
    expect(sent).toEqual([]);
    expect(c.textContent).toContain('Choose the folder the run works in.');
  });

  it('the type picker starts a team from the checked types', async () => {
    mounted = await mount(
      <TemplatesPanel state={m4State()} onCommand={() => Promise.resolve({ ok: true })} query={null} />,
    );
    const c = mounted.container;
    await click(byText(c, 'button', 'Pick types…'));
    await click(c.querySelector('#typed-team-tester'));
    await click(byText(c, 'button', 'Start team'));
    const names = [...c.querySelectorAll('.agent-draft')].map(
      (d) => d.querySelector<HTMLInputElement>('input[id$="-name"]')?.value,
    );
    expect(names).toEqual(['builder', 'tester', 'reviewer']);
  });
});
