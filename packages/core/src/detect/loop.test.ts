import type { HuddleEvent } from '@huddle/shared';
import { describe, expect, it } from 'vitest';
import { builder, DEFAULTS, MAIN, raisedIds, resolvedIds, run, SUB, T0 } from '../test/detect-events.js';

type Ev = ReturnType<typeof builder>;

function start(ev: Ev): HuddleEvent[] {
  return [
    ev(
      'session.started',
      { ts: T0 },
      { origin: 'attached', cwd: 'C:\\repo', title: null, model: null, startKind: 'startup' },
    ),
    ev('prompt.submitted', { ts: T0 + 1 }, { text: 'go', promptId: 'p1' }),
  ];
}

let seq = 0;
function call(
  ev: Ev,
  ts: number,
  digest: string,
  opts: { agent?: string; fail?: boolean; interrupted?: boolean } = {},
) {
  seq += 1;
  const id = `tu${String(seq)}`;
  const at = { ts, ...(opts.agent !== undefined ? { agent: opts.agent } : {}) };
  const started = ev('tool.started', at, {
    toolUseId: id,
    toolName: 'Bash',
    summary: `cmd ${digest}`,
    filePath: null,
    inputDigest: digest,
  });
  const ended =
    opts.fail === true
      ? ev(
          'tool.failed',
          { ...at, ts: ts + 1 },
          { toolUseId: id, toolName: 'Bash', error: 'exit 1', interrupted: opts.interrupted ?? false },
        )
      : ev('tool.finished', { ...at, ts: ts + 1 }, { toolUseId: id, toolName: 'Bash', durationMs: 1 });
  return [started, ended];
}

function repeat(ev: Ev, n: number, digest: string, from = 10, opts: { agent?: string; fail?: boolean } = {}) {
  const out: HuddleEvent[] = [];
  for (let i = 0; i < n; i++) out.push(...call(ev, T0 + from + i * 10, digest, opts));
  return out;
}

describe('loop detector: same input repeated', () => {
  it('raises once at loopRepeat identical calls in a row, not before', () => {
    const ev = builder();
    expect(raisedIds(run([...start(ev), ...repeat(ev, 4, 'd1')]).emitted)).toEqual([]);
    const ev2 = builder();
    const out = run([...start(ev2), ...repeat(ev2, 8, 'd1')]);
    expect(raisedIds(out.emitted)).toEqual([`loop:${MAIN}:d1`]);
    expect(out.emitted[0]).toMatchObject({
      type: 'attention.raised',
      agentKey: MAIN,
      source: 'huddle',
      item: { kind: 'loop', title: 'Same Bash call 5 times in a row', resolvedAt: null },
    });
  });

  it('a different call between breaks the run', () => {
    const ev = builder();
    const out = run([
      ...start(ev),
      ...repeat(ev, 3, 'd1'),
      ...call(ev, T0 + 500, 'other'),
      ...repeat(ev, 3, 'd1', 600),
    ]);
    expect(raisedIds(out.emitted)).toEqual([]);
  });

  it('counts per agent: interleaved agents do not break or add to each other', () => {
    const ev = builder();
    const events: HuddleEvent[] = [
      ...start(ev),
      ev('agent.started', { ts: T0 + 2, agent: SUB }, { agentId: 'sub1', role: 'x', parentKey: MAIN }),
    ];
    for (let i = 0; i < 5; i++) {
      events.push(...call(ev, T0 + 10 + i * 10, 'd1'), ...call(ev, T0 + 15 + i * 10, `s${String(i)}`, { agent: SUB }));
    }
    expect(raisedIds(run(events).emitted)).toEqual([`loop:${MAIN}:d1`]);
  });

  it('resolves when the agent moves on, at a new prompt, at turn end and when it ends', () => {
    const base = () => {
      const ev = builder();
      return { ev, events: [...start(ev), ...repeat(ev, 5, 'd1')] };
    };
    const a = base();
    expect(resolvedIds(run([...a.events, ...call(a.ev, T0 + 900, 'd2')]).emitted)).toEqual([`loop:${MAIN}:d1`]);
    const b = base();
    expect(
      resolvedIds(
        run([...b.events, b.ev('prompt.submitted', { ts: T0 + 900 }, { text: 'stop', promptId: 'p2' })]).emitted,
      ),
    ).toEqual([`loop:${MAIN}:d1`]);
    const c = base();
    expect(
      resolvedIds(
        run([...c.events, c.ev('turn.ended', { ts: T0 + 900 }, { lastMessage: null, backgroundAgentIds: [] })]).emitted,
      ),
    ).toEqual([`loop:${MAIN}:d1`]);
    const d = base();
    expect(
      resolvedIds(run([...d.events, d.ev('session.ended', { ts: T0 + 900 }, { reason: 'other' })]).emitted),
    ).toEqual([`loop:${MAIN}:d1`]);
  });

  it('honors changed thresholds', () => {
    const ev = builder();
    const out = run([...start(ev), ...repeat(ev, 3, 'd1')], { ...DEFAULTS, loopRepeat: 3 });
    expect(raisedIds(out.emitted)).toEqual([`loop:${MAIN}:d1`]);
  });

  it('ignores ended agents', () => {
    const ev = builder();
    const out = run([...start(ev), ev('session.ended', { ts: T0 + 5 }, { reason: 'other' }), ...repeat(ev, 6, 'd1')]);
    expect(out.emitted).toEqual([]);
  });
});

describe('loop detector: failures in a row', () => {
  it('raises once at loopFailures failures in a row', () => {
    const ev = builder();
    expect(
      raisedIds(
        run([...start(ev), ...call(ev, T0 + 10, 'a', { fail: true }), ...call(ev, T0 + 20, 'b', { fail: true })])
          .emitted,
      ),
    ).toEqual([]);
    const ev2 = builder();
    const out = run([
      ...start(ev2),
      ...call(ev2, T0 + 10, 'a', { fail: true }),
      ...call(ev2, T0 + 20, 'b', { fail: true }),
      ...call(ev2, T0 + 30, 'c', { fail: true }),
      ...call(ev2, T0 + 40, 'd', { fail: true }),
    ]);
    expect(raisedIds(out.emitted)).toEqual([`loop:${MAIN}:failures`]);
    const raised = out.emitted[0];
    if (raised?.type === 'attention.raised') {
      expect(raised.item.title).toBe('3 tool calls failed in a row');
      expect(raised.item.detail).toBe('Last: Bash: exit 1');
    }
  });

  it('a success between resets the count, and resolves an open item', () => {
    const ev = builder();
    const out = run([
      ...start(ev),
      ...call(ev, T0 + 10, 'a', { fail: true }),
      ...call(ev, T0 + 20, 'b', { fail: true }),
      ...call(ev, T0 + 30, 'ok'),
      ...call(ev, T0 + 40, 'c', { fail: true }),
      ...call(ev, T0 + 50, 'd', { fail: true }),
    ]);
    expect(raisedIds(out.emitted)).toEqual([]);

    const ev2 = builder();
    const out2 = run([
      ...start(ev2),
      ...call(ev2, T0 + 10, 'a', { fail: true }),
      ...call(ev2, T0 + 20, 'b', { fail: true }),
      ...call(ev2, T0 + 30, 'c', { fail: true }),
      ...call(ev2, T0 + 40, 'ok'),
    ]);
    expect(resolvedIds(out2.emitted)).toEqual([`loop:${MAIN}:failures`]);
  });

  it('parallel calls failing together count once', () => {
    const ev = builder();
    const events: HuddleEvent[] = [...start(ev)];
    for (const id of ['p1', 'p2', 'p3', 'p4']) {
      events.push(
        ev(
          'tool.started',
          { ts: T0 + 10 },
          { toolUseId: id, toolName: 'Bash', summary: id, filePath: null, inputDigest: id },
        ),
      );
    }
    for (const id of ['p1', 'p2', 'p3', 'p4']) {
      events.push(
        ev('tool.failed', { ts: T0 + 20 }, { toolUseId: id, toolName: 'Bash', error: 'x', interrupted: false }),
      );
    }
    expect(raisedIds(run(events).emitted)).toEqual([]);
  });

  it('a user interrupt is not a failure', () => {
    const ev = builder();
    const out = run([
      ...start(ev),
      ...call(ev, T0 + 10, 'a', { fail: true }),
      ...call(ev, T0 + 20, 'b', { fail: true }),
      ...call(ev, T0 + 30, 'c', { fail: true, interrupted: true }),
      ...call(ev, T0 + 40, 'd', { fail: true }),
    ]);
    expect(raisedIds(out.emitted)).toEqual([]);
  });

  it('honors changed thresholds', () => {
    const ev = builder();
    const events = [...start(ev), ...call(ev, T0 + 10, 'a', { fail: true }), ...call(ev, T0 + 20, 'b', { fail: true })];
    expect(raisedIds(run(events, { ...DEFAULTS, loopFailures: 2 }).emitted)).toEqual([`loop:${MAIN}:failures`]);
  });

  it('is deterministic: same input, same output', () => {
    const make = () => {
      seq = 0;
      const ev = builder();
      return run([...start(ev), ...repeat(ev, 6, 'd1'), ...repeat(ev, 4, 'f', 900, { fail: true })]);
    };
    const a = make();
    const b = make();
    expect(a).toEqual(b);
    expect(a.emitted.map((e) => e.id)).toEqual(b.emitted.map((e) => e.id));
    expect(new Set(a.emitted.map((e) => e.id)).size).toBe(a.emitted.length);
  });
});
