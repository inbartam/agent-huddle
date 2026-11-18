// @vitest-environment happy-dom
/**
 * Agent types by role (2026-11-18): Library › Roles lists each role with its guessed type and sends one
 * settings.update when the user picks another; the tree names a subagent's type and a finished one's finish line.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { selectTree, type HuddleCommand, type HuddleState } from '@huddle/shared';
import { RolesPanel } from './components/Roles.js';
import { TeamTree } from './components/TeamTree.js';
import { flush, mount, type Mounted } from './testing/dom.js';
import { fixtureState, KEYS } from './testing/fixture.js';
import { roleRows } from './view/roles.js';
import { buildRows } from './view/tree.js';

let mounted: Mounted | null = null;
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});

function withSettings(state: HuddleState, roleKinds: Record<string, string>): HuddleState {
  return {
    ...state,
    settings: { ...(state.settings as NonNullable<HuddleState['settings']>), roleKinds },
  } as HuddleState;
}

describe('Library › Roles', () => {
  it('groups the roles it has seen by type, with the guess named', () => {
    const rows = roleRows(fixtureState().agents, {});
    const byRole = Object.fromEntries(rows.map((r) => [r.role, r.kind]));
    expect(byRole).toMatchObject({ 'core-engineer': 'builder', 'test-engineer': 'tester', Explore: 'researcher' });
    expect(rows.some((r) => r.role === 'main')).toBe(false);
  });

  it('a pick sends settings.update for that role; "Guess" clears it', async () => {
    const sent: HuddleCommand[] = [];
    const onCommand = (cmd: HuddleCommand) => {
      sent.push(cmd);
      return Promise.resolve({ ok: true } as const);
    };
    mounted = await mount(<RolesPanel state={fixtureState()} onCommand={onCommand} />);
    const select = mounted.container.querySelector<HTMLSelectElement>('select[id]');
    const label = mounted.container.querySelector(`label[for="${select?.id ?? ''}"]`)?.textContent ?? '';
    const role = label.replace('Type of ', '');
    if (select === null) throw new Error('no select');
    expect(select.options[0]?.textContent).toMatch(/^Guess: /);
    select.value = 'designer';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    expect(sent).toEqual([{ type: 'settings.update', patch: { roleKinds: { [role]: 'designer' } } }]);
  });

  it('a role set by the user says so and moves to its group', () => {
    const state = withSettings(fixtureState(), { 'core-engineer': 'reviewer' });
    const html = renderToStaticMarkup(<RolesPanel state={state} onCommand={() => Promise.resolve({ ok: true })} />);
    const reviewers = html.slice(html.indexOf('aria-label="Reviewer"'));
    expect(reviewers).toContain('core-engineer');
    expect(reviewers).toContain('set by you');
  });
});

describe('the tree names types', () => {
  it('a subagent row shows its type; a finished researcher says "findings ready"', () => {
    const state = fixtureState();
    const rows = buildRows(selectTree(state), { toggled: new Set() });
    const html = renderToStaticMarkup(
      <TeamTree
        rows={rows}
        renames={new Map()}
        selectedKey={null}
        onActivate={() => undefined}
        onToggle={() => undefined}
        mode="main"
        label="Team"
        roleKinds={{}}
      />,
    );
    expect(html).toContain('class="tree-type type-builder"');
    expect(html).toContain('class="tree-type type-tester"');
    expect(state.agents[KEYS.doneExplore]?.status).toBe('done');
    expect(html).toContain('>findings ready</span>');
  });
});
