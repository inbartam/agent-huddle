// @vitest-environment happy-dom
/**
 * The template editor's agent drafts with real DOM events: removing a middle draft keeps the other drafts' fields
 * (the same DOM nodes, so focus and typing state stay with their draft) and their errors.
 */
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentsEditor } from './components/LaunchForm.js';
import { validateDraft, EMPTY_DRAFT, type AgentDraft } from './view/launch.js';
import { byText, click, mount, type Mounted } from './testing/dom.js';

let mounted: Mounted | null = null;
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});

const agent = (name: string, description: string): AgentDraft => ({
  name,
  description,
  prompt: `${name} prompt`,
  tools: '',
  model: '',
});

function Harness({ initial, ignore = false }: { initial: AgentDraft[]; ignore?: boolean }) {
  const [agents, setAgents] = useState(initial);
  const [, bump] = useState(0);
  const errors = validateDraft({ ...EMPTY_DRAFT, agents }, false);
  return (
    <AgentsEditor
      agents={agents}
      errors={errors}
      onChange={(next) => {
        if (ignore) bump((n) => n + 1);
        else setAgents(next);
      }}
    />
  );
}

describe('AgentsEditor, removing a draft', () => {
  it('keeps the remaining drafts, their DOM nodes and their errors', async () => {
    mounted = await mount(<Harness initial={[agent('a', 'does a'), agent('b', 'does b'), agent('c', '')]} />);
    const c = mounted.container;
    const names = () => [...c.querySelectorAll<HTMLInputElement>('input[id$="-name"]')];
    const [first, , third] = names();
    expect(third?.value).toBe('c');
    const groups = c.querySelectorAll('.agent-draft');
    expect(groups[2]?.textContent).toContain('Say when to use this agent.');

    const removeButtons = [...c.querySelectorAll('button')].filter((b) => b.textContent === 'Remove agent');
    await click(removeButtons[1]);

    const after = names();
    expect(after.map((n) => n.value)).toEqual(['a', 'c']);
    expect(after[0]).toBe(first);
    expect(after[1]).toBe(third);
    expect(third?.isConnected).toBe(true);
    const groupsAfter = c.querySelectorAll('.agent-draft');
    expect(groupsAfter).toHaveLength(2);
    expect(groupsAfter[0]?.textContent).not.toContain('Say when to use this agent.');
    expect(groupsAfter[1]?.textContent).toContain('Say when to use this agent.');
    expect(byText(c, 'button', 'Add agent')).not.toBeNull();
  });
  it('keeps every key and DOM node when the parent ignores a remove', async () => {
    mounted = await mount(
      <Harness ignore initial={[agent('a', 'does a'), agent('b', 'does b'), agent('c', 'does c')]} />,
    );
    const c = mounted.container;
    const nodes = () => [...c.querySelectorAll<HTMLInputElement>('input[id$="-name"]')];
    const before = nodes();
    const idsBefore = before.map((n) => n.id);
    const removeButtons = [...c.querySelectorAll('button')].filter((b) => b.textContent === 'Remove agent');
    await click(removeButtons[1]);
    const after = nodes();
    expect(after).toHaveLength(3);
    after.forEach((n, i) => {
      expect(n).toBe(before[i]);
      expect(n.id).toBe(idsBefore[i]);
    });
  });
});
