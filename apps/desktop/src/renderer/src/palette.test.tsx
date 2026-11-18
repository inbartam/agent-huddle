/**
 * The command palette (M3, F15): the actions it offers, fuzzy matching, keyboard navigation, disabled actions with
 * their reason, and the commands it runs.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CONTROL_REASONS } from '@huddle/shared';
import { Palette } from './components/Palette.js';
import { APPROVAL, approvalItem, IK, interactState, STUCK } from './testing/interact-fixture.js';
import {
  filterActions,
  fuzzyScore,
  PALETTE_REASONS,
  paletteActions,
  paletteKey,
  paletteOpened,
} from './view/palette.js';

const noop = () => undefined;

describe('actions', () => {
  it('offers the top request first (open, then allow, deny, pass), then navigation, pause and resume all, then every agent', () => {
    const ids = paletteActions(interactState(), new Map()).map((a) => a.id);
    expect(ids.slice(0, 8)).toEqual([
      'top.open',
      'top.allow',
      'top.deny',
      'top.pass',
      'team',
      'settings',
      'all.pause',
      'all.resume',
    ]);
    expect(ids).toContain(`agent:${IK.tester}`);
  });

  it('runs the exact commands', () => {
    const byId = new Map(paletteActions(interactState(), new Map()).map((a) => [a.id, a]));
    expect(byId.get('top.allow')?.effect).toEqual({
      kind: 'command',
      command: { type: 'approval.decide', requestId: 'req-1', decision: 'allow' },
    });
    expect(byId.get('top.deny')?.effect).toEqual({
      kind: 'command',
      command: { type: 'approval.decide', requestId: 'req-1', decision: 'deny' },
    });
    expect(byId.get('all.pause')?.effect).toEqual({ kind: 'command', command: { type: 'all.pause' } });
    expect(byId.get('all.resume')?.effect).toEqual({ kind: 'command', command: { type: 'all.resume' } });
    expect(byId.get(`agent:${IK.tester}`)?.effect).toEqual({ kind: 'select', agentKey: IK.tester });
  });

  it('has no top-request actions without an approval, and disables them when not connected', () => {
    expect(paletteActions(interactState({ inbox: [STUCK] }), new Map()).some((a) => a.id === 'top.allow')).toBe(false);
    const off = paletteActions(interactState({ connection: undefined, inbox: [approvalItem()] }), new Map());
    const allow = off.find((a) => a.id === 'top.allow');
    expect(allow?.control).toEqual({ enabled: false, reason: CONTROL_REASONS.notConnected });
    expect(off.find((a) => a.id === 'all.pause')?.control.reason).toBe(CONTROL_REASONS.notConnected);
  });
});

describe('the top request is the one seen when the palette opened', () => {
  const other = approvalItem({
    id: 'approval:req-2',
    approval: { ...APPROVAL, requestId: 'req-2', summary: 'git push --force' },
  });

  it('a changed top request turns allow, deny and pass off with a reason, and they never name the new request', () => {
    const opened = paletteOpened(interactState());
    expect(opened).toEqual({ topRequestId: 'req-1' });
    const now = paletteActions(interactState({ inbox: [other] }), new Map(), opened);
    for (const id of ['top.allow', 'top.deny', 'top.pass']) {
      const a = now.find((x) => x.id === id);
      expect(a?.control).toEqual({ enabled: false, reason: PALETTE_REASONS.topChanged });
      expect(JSON.stringify(a?.effect)).not.toContain('req-2');
      expect(a?.hint).not.toContain('git push');
    }
    const allow = now.findIndex((x) => x.id === 'top.allow');
    expect(paletteKey('Enter', allow, now, true)).toMatchObject({
      kind: 'blocked',
      reason: PALETTE_REASONS.topChanged,
    });
  });

  it('a request that is gone, or one that arrived after opening, is off too', () => {
    const gone = paletteActions(interactState({ inbox: [STUCK] }), new Map(), { topRequestId: 'req-1' });
    expect(gone.find((a) => a.id === 'top.allow')?.control.reason).toBe(PALETTE_REASONS.topChanged);
    const arrived = paletteActions(interactState(), new Map(), { topRequestId: null });
    expect(arrived.find((a) => a.id === 'top.allow')?.control.reason).toBe(PALETTE_REASONS.topChanged);
  });

  it('the same top request stays on', () => {
    const state = interactState();
    const allow = paletteActions(state, new Map(), paletteOpened(state)).find((a) => a.id === 'top.allow');
    expect(allow?.control.enabled).toBe(true);
  });
});

describe('fuzzy matching', () => {
  it('matches characters in order, case-insensitive, and refuses out-of-order', () => {
    expect(fuzzyScore('pa', 'Pause all')).not.toBeNull();
    expect(fuzzyScore('PSALL', 'Pause all')).not.toBeNull();
    expect(fuzzyScore('lap', 'Pause all')).toBeNull();
    expect(fuzzyScore('', 'anything')).toBe(0);
  });

  it('ranks word starts and runs above scattered matches', () => {
    const actions = paletteActions(interactState(), new Map());
    expect(filterActions(actions, 'resume')[0]?.id).toBe('all.resume');
    expect(filterActions(actions, 'settings')[0]?.id).toBe('settings');
    expect(filterActions(actions, 'go tests')[0]?.id).toBe(`agent:${IK.tester}`);
    expect(filterActions(actions, 'zzzz')).toEqual([]);
  });
});

describe('keys', () => {
  const list = paletteActions(interactState(), new Map());

  it('moves with wrap-around, jumps with Home and End, closes with Escape', () => {
    expect(paletteKey('ArrowDown', 0, list)).toEqual({ kind: 'move', index: 1 });
    expect(paletteKey('ArrowUp', 0, list)).toEqual({ kind: 'move', index: list.length - 1 });
    expect(paletteKey('ArrowDown', list.length - 1, list)).toEqual({ kind: 'move', index: 0 });
    expect(paletteKey('End', 0, list)).toEqual({ kind: 'move', index: list.length - 1 });
    expect(paletteKey('Home', 3, list)).toEqual({ kind: 'move', index: 0 });
    expect(paletteKey('Escape', 0, list)).toEqual({ kind: 'close' });
    expect(paletteKey('x', 0, list)).toEqual({ kind: 'none' });
  });

  it('Enter on a fresh open does not decide anything: the first action opens the waiting agent', () => {
    const r = paletteKey('Enter', 0, list);
    expect(r).toMatchObject({
      kind: 'run',
      action: { id: 'top.open', effect: { kind: 'select', agentKey: IK.tester } },
    });
  });

  it('Enter runs allow only after the user typed or moved to it', () => {
    const allow = list.findIndex((a) => a.id === 'top.allow');
    expect(paletteKey('Enter', allow, list)).toMatchObject({
      kind: 'blocked',
      action: { id: 'top.allow' },
      reason: PALETTE_REASONS.moveFirst,
    });
    expect(paletteKey('Enter', allow, list, true)).toMatchObject({ kind: 'run', action: { id: 'top.allow' } });
    const typed = filterActions(list, 'allow');
    expect(typed[0]?.id).toBe('top.allow');
    expect(paletteKey('Enter', 0, typed, true)).toMatchObject({ kind: 'run', action: { id: 'top.allow' } });
  });

  it('blocks a disabled action with its reason', () => {
    const off = paletteActions(interactState({ connection: undefined }), new Map());
    const allow = off.findIndex((a) => a.id === 'top.allow');
    expect(paletteKey('Enter', allow, off, true)).toMatchObject({
      kind: 'blocked',
      action: { id: 'top.allow' },
      reason: CONTROL_REASONS.notConnected,
    });
    expect(paletteKey('Enter', 0, [])).toEqual({ kind: 'none' });
  });
});

describe('palette markup', () => {
  it('is a modal dialog with a combobox and a listbox, the first option (open the top request) active', () => {
    const html = renderToStaticMarkup(
      <Palette state={interactState()} renames={new Map()} onRun={noop} onClose={noop} />,
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('role="combobox"');
    expect(html).toContain('role="listbox"');
    expect(html).toMatch(/role="option" aria-selected="true"[^>]*><span class="palette-label">Open the top request/);
    expect(html).toMatch(/role="option" aria-selected="false"[^>]*><span class="palette-label">Allow the top request/);
  });

  it('shows the reason in place of the hint on a disabled action', () => {
    const html = renderToStaticMarkup(
      <Palette
        state={interactState({ connection: undefined })}
        renames={new Map()}
        onRun={noop}
        onClose={noop}
        initialQuery="pause all"
      />,
    );
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain(CONTROL_REASONS.notConnected.replace("'", '&#x27;'));
  });
});
