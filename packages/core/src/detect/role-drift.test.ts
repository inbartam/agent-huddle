import type { HuddleEvent } from '@huddle/shared';
import { describe, expect, it } from 'vitest';
import { step, tick, type DetectorState } from './index.js';
import { builder, DEFAULTS, MIN, raisedIds, resolvedIds, run, SUB, T0 } from '../test/detect-events.js';

function withSub(ev: ReturnType<typeof builder>, role: string): HuddleEvent[] {
  return [
    ev(
      'session.started',
      { ts: T0 },
      { origin: 'attached', cwd: 'C:\\repo', title: null, model: null, startKind: 'startup' },
    ),
    ev('prompt.submitted', { ts: T0 + 1000 }, { text: 'go', promptId: 'p1' }),
    ev('agent.started', { ts: T0 + 2000, agent: SUB }, { agentId: 'sub1', role, parentKey: 'sess-a' }),
  ];
}

function edit(ev: ReturnType<typeof builder>, ts: number): HuddleEvent {
  return ev(
    'tool.started',
    { ts, agent: SUB },
    {
      toolUseId: `t${String(ts)}`,
      toolName: 'Edit',
      summary: 'src/a.ts',
      filePath: 'C:\\repo\\src\\a.ts',
      inputDigest: 'd',
    },
  );
}

function fold(events: readonly HuddleEvent[], roleKinds: Record<string, never> | null = null, from?: DetectorState) {
  let state = from ?? run([]).state;
  const emitted = [];
  for (const e of events) {
    const s = step(state, e, DEFAULTS, roleKinds);
    state = s.state;
    emitted.push(...s.emit);
  }
  return { state, emitted };
}

describe('role drift (2026-11-18)', () => {
  it('raises once when a reviewer starts editing, and resolves when it stops', () => {
    const ev = builder();
    const { state, emitted } = fold([
      ...withSub(ev, 'oh-my-claudecode:code-reviewer'),
      edit(ev, T0 + 3000),
      edit(ev, T0 + 4000),
    ]);
    expect(raisedIds(emitted)).toEqual([`role:${SUB}`]);
    const raised = emitted.find((e) => e.type === 'attention.raised');
    expect(raised?.type === 'attention.raised' && raised.item).toMatchObject({
      kind: 'role_drift',
      severity: 'warning',
      title: 'A reviewer is changing files',
    });
    const end = fold(
      [ev('agent.stopped', { ts: T0 + 5000, agent: SUB }, { agentId: 'sub1', result: null })],
      null,
      state,
    );
    expect(resolvedIds(end.emitted)).toEqual([`role:${SUB}`]);
  });

  it('a builder editing is normal', () => {
    const ev = builder();
    expect(raisedIds(fold([...withSub(ev, 'core-engineer'), edit(ev, T0 + 3000)]).emitted)).toEqual([]);
  });

  it("the user's type for the role wins: a reviewer set to builder may edit", () => {
    const ev = builder();
    const overrides = { 'code-reviewer': 'builder' } as unknown as Record<string, never>;
    expect(raisedIds(fold([...withSub(ev, 'code-reviewer'), edit(ev, T0 + 3000)], overrides).emitted)).toEqual([]);
  });

  it('a reviewer gets twice the quiet time before it looks stuck', () => {
    const ev = builder();
    const { state } = fold([
      ...withSub(ev, 'security-reviewer'),
      ev(
        'tool.started',
        { ts: T0 + 3000, agent: SUB },
        { toolUseId: null, toolName: 'Read', summary: 'a', filePath: null, inputDigest: 'r' },
      ),
      ev('tool.finished', { ts: T0 + 3500, agent: SUB }, { toolUseId: null, toolName: 'Read', durationMs: 5 }),
    ]);
    const quiet = T0 + 3500 + DEFAULTS.stuckMinutes * MIN;
    expect(raisedIds(tick(state, quiet, DEFAULTS).emit)).not.toContain(`stuck:${SUB}`);
    expect(raisedIds(tick(state, T0 + 3500 + 2 * DEFAULTS.stuckMinutes * MIN, DEFAULTS).emit)).toContain(
      `stuck:${SUB}`,
    );
  });

  it('a role named like an Object.prototype key never crashes the detectors (security review)', () => {
    for (const role of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const ev = builder();
      const events = [
        ...withSub(ev, role),
        ev('role.described', { ts: T0 + 2500 }, { role, description: 'x', definedIn: 'user', filePath: null }),
        edit(ev, T0 + 3000),
      ];
      expect(() => fold(events)).not.toThrow();
      expect(() => tick(fold(events).state, T0 + 60 * MIN, DEFAULTS)).not.toThrow();
    }
  });
});
